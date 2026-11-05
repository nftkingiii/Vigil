import { Bot, type Context } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getAddress, isAddress } from "viem";
import { config } from "./config.ts";
import { esc, helpText, positionCard } from "./format.ts";
import { latestSnapshot } from "./monitor.ts";
import { btc as fmtBtc, levelFor, musd, parseAmount, parsePercent, pct, planLoan, position, usd } from "./risk.ts";
import { BLOCKING } from "./rescueHealth.ts";
import { feedback, rescues, watches } from "./store.ts";

export const DEFAULT_ALERT_ICR = 15n * 10n ** 17n; // 150%
const MIN_ALERT_ICR = 115n * 10n ** 16n; // 115%
const MAX_ALERT_ICR = 500n * 10n ** 16n; // 500%

/** Without a token the service still monitors, serves the page and runs the keeper; Telegram stays off. */
const token = config.telegramToken;
export const telegramEnabled = token.length > 0;

/** Never let the bot token reach a log line: grammy puts it in request URLs and error messages. */
export const redact = (s: string) => (token ? s.split(token).join("<token>") : s);
const logError = (where: string, e: unknown) =>
  console.error(where, redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e)));

// Honour HTTPS_PROXY where one is set (grammy's fetch does not read it on its own).
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
export const bot = new Bot(token || "0:disabled", proxy ? { client: { baseFetchConfig: { agent: new HttpsProxyAgent(proxy), compress: true } } } : {});

const html = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

function parseAlert(arg: string | undefined): bigint | null | "invalid" {
  if (!arg) return null;
  const v = parsePercent(arg);
  if (v === null || v < MIN_ALERT_ICR || v > MAX_ALERT_ICR) return "invalid";
  return v;
}

function rescueLine(borrower: string): string {
  const steps = rescues.armedFor(borrower);
  if (steps.length === 0) return `\n\n<b>Rescue</b>: none armed. /rescue to set one up.`;
  const lines = steps.map((r, i) => {
    const blocked = r.warning.split(",").some((c) => BLOCKING.has(c));
    const until = new Date(r.deadline * 1000).toISOString().slice(0, 10);
    const label = steps.length > 1 ? `step ${i + 1}: ` : "";
    return `${label}${musd(r.amount)} armed until ${until}${i > 0 ? " (runs after the step before)" : blocked ? " ❌ <b>can't succeed right now</b>, see the last Vigil message" : " ✅"}`;
  });
  return `\n\n<b>Rescue</b>: ${lines.join("\n   ")}`;
}

async function statusFor(ctx: Context, borrower: string, alertIcr: bigint) {
  const snap = latestSnapshot();
  if (!snap) return ctx.reply("Vigil is still taking its first snapshot of Mezo. Try again in a minute.");
  if (!snap.price.ok) {
    return ctx.reply(
      `⏸ Mezo's price feed is unavailable right now (${snap.price.reason}). Vigil won't guess a price. It will report your position as soon as the feed is fresh.`,
    );
  }
  const p = position(snap.troves, borrower, snap.price.price);
  if (!p) {
    return ctx.reply(
      `No active MUSD loan found for <code>${esc(borrower)}</code> on Mezo testnet. Vigil will start reporting as soon as one is open.`,
      html,
    );
  }
  const w = (ctx.chat ? watches.forChat(ctx.chat.id) : []).find((x) => x.borrower.toLowerCase() === borrower.toLowerCase());
  const threshold = w?.redemptionAlert ? `\n<b>Redemption threshold</b>: ${musd(w.redemptionAlert)} of debt ahead${p.redemptionBuffer < w.redemptionAlert ? " ⚠️ crossed" : " ✅"}` : "";
  return ctx.reply(positionCard(p, snap.price.price, alertIcr, levelFor(p, alertIcr), snap.system) + threshold + rescueLine(borrower), html);
}

bot.command("start", (ctx) =>
  ctx.reply(
    `👁 <b>Vigil</b> guards MUSD loans on Mezo.\n\nSend <code>/watch 0xYourAddress</code> to start. No loan yet? <code>/plan 0.05 2500</code> shows what borrowing 2,500 MUSD against 0.05 BTC would look like first. Vigil alerts you before liquidation <i>and</i> before redemption, which most borrowers don't see coming.\n\n/help for everything else.`,
    html,
  ),
);

bot.command("help", (ctx) => ctx.reply(helpText, html));

bot.command("watch", async (ctx) => {
  const [addr, alertArg] = ctx.match.trim().split(/\s+/);
  if (addr && /^(bc1|tb1|[13mn2])[a-zA-HJ-NP-Z0-9]{20,}$/.test(addr) && !addr.startsWith("0x")) {
    return ctx.reply(
      "That looks like a Bitcoin address. MUSD loans live on Mezo, which uses 0x addresses. Open the Mezo app, copy the 0x account that holds your loan, and send /watch 0x…",
    );
  }
  if (!addr || !isAddress(addr)) return ctx.reply("Usage: /watch 0xYourMezoAddress [alert%]\nExample: /watch 0xabc…123 160");
  const alert = parseAlert(alertArg);
  if (alert === "invalid") return ctx.reply("Alert line must be between 115% and 500%, e.g. 150.");
  const alertIcr = alert ?? DEFAULT_ALERT_ICR;
  const borrower = getAddress(addr);
  watches.upsert(ctx.chat.id, borrower, alertIcr);
  await ctx.reply(`Watching <code>${esc(borrower)}</code> · alert below ${pct(alertIcr, 0)}.`, html);
  return statusFor(ctx, borrower, alertIcr);
});

bot.command("status", async (ctx) => {
  const list = watches.forChat(ctx.chat.id);
  if (list.length === 0) return ctx.reply("You're not watching anything yet. Send /watch 0xYourAddress.");
  for (const w of list) await statusFor(ctx, w.borrower, w.alertIcr);
});

bot.command("alerts", (ctx) => {
  const alert = parseAlert(ctx.match.trim());
  if (alert === null || alert === "invalid") return ctx.reply("Usage: /alerts 160  (between 115 and 500)");
  const list = watches.forChat(ctx.chat.id);
  if (list.length === 0) return ctx.reply("Nothing to update. Send /watch 0xYourAddress first.");
  for (const w of list) watches.upsert(ctx.chat.id, w.borrower, alert);
  return ctx.reply(`Alert line set to ${pct(alert, 0)} for ${list.length} address${list.length > 1 ? "es" : ""}.`);
});

bot.command("redemption", (ctx) => {
  const arg = ctx.match.trim().replace(/,/g, "");
  const list = watches.forChat(ctx.chat.id);
  if (list.length === 0) return ctx.reply("Nothing to update. Send /watch 0xYourAddress first.");
  if (arg === "off" || arg === "0") {
    watches.setRedemptionAlert(ctx.chat.id, null);
    return ctx.reply("Redemption threshold off. You still get the front-of-queue alert.");
  }
  const amount = parseAmount(arg);
  if (!amount) return ctx.reply("Usage: /redemption <MUSD>, e.g. /redemption 50000\nVigil alerts when less than that much other debt is ahead of you in Mezo's redemption queue, and suggests a repay. /redemption off to stop.");
  watches.setRedemptionAlert(ctx.chat.id, amount);
  return ctx.reply(`Redemption threshold set to ${musd(amount)} for ${list.length} address${list.length > 1 ? "es" : ""}. You'll get an alert, with a suggested repay, when less than that is ahead of you.`);
});

bot.command("feedback", (ctx) => {
  const text = ctx.match.trim();
  if (text.length < 3) return ctx.reply("Usage: /feedback <what worked, what confused you, what you wish Vigil did>\nIt goes to the Vigil team; it's stored without your name, and quotes may be published without who said them.");
  feedback.add(ctx.chat.id, text);
  return ctx.reply("Thanks, noted. This shapes what Vigil builds next.");
});

bot.command("unwatch", (ctx) => {
  const addr = ctx.match.trim();
  if (addr && !isAddress(addr)) return ctx.reply("Usage: /unwatch [0xAddress]");
  const n = watches.remove(ctx.chat.id, addr || undefined);
  return ctx.reply(n ? `Stopped watching ${n} address${n > 1 ? "es" : ""}.` : "You weren't watching that.");
});

bot.command("plan", async (ctx) => {
  const [btcArg, musdArg] = ctx.match.trim().split(/\s+/);
  const coll = parseAmount(btcArg);
  const borrow = parseAmount(musdArg);
  if (!coll || !borrow) return ctx.reply("Usage: /plan <BTC collateral> <MUSD to borrow>\nExample: /plan 0.05 2500");
  const snap = latestSnapshot();
  if (!snap) return ctx.reply("Vigil is still taking its first snapshot of Mezo. Try again in a minute.");
  if (!snap.price.ok) return ctx.reply(`⏸ Mezo's price feed is unavailable (${snap.price.reason}). Vigil won't plan on a guessed price.`);
  const p = planLoan(snap.troves, { coll, borrow, price: snap.price.price, system: snap.system });
  const pos = p.position;
  const s = p.suggestion;
  const lines = [
    `🧮 <b>Planned loan</b>: ${fmtBtc(coll)} collateral, ${musd(borrow)} borrowed`,
    p.ok ? `✅ Mezo would open it.` : `❌ Mezo would refuse it: ${p.problems.join(" ")}`,
    ``,
    `Total debt ${musd(p.debt)} (incl. ${musd(p.borrowingFee, 2)} borrowing fee and ${musd(snap.system.gasCompensation)} gas compensation)`,
    `Collateral ratio <b>${pct(pos.icr, 1)}</b>`,
    `<b>Liquidation</b>: BTC at ${usd(pos.liquidationPrice)} (now ${usd(snap.price.price)}, ${pct(pos.dropToLiquidation)} away)`,
    pos.redemptionRank !== null
      ? `<b>Redemption queue</b>: would be #${pos.redemptionRank} of ${pos.redeemableTroves}, with ${musd(pos.redemptionBuffer)} redeemed before it`
      : `<b>Redemption queue</b>: not redeemable (under 110%)`,
    pos.daysToMcrFlat !== null ? `<b>Interest drift</b>: ${Math.round(pos.daysToMcrFlat).toLocaleString("en-US")} days to 110% at ${(snap.system.newLoanRateBips / 100).toFixed(2)}% a year, BTC flat` : ``,
    ``,
    `<b>Suggested Vigil setup</b>`,
    `• Ratio trigger ${pct(s.trigger, 0)}${s.guard ? `, redemption guard ${musd(s.guard)}` : ""}`,
    `• Signed repay ${musd(s.repay)}, reserve ${musd(s.reserve, 2)} (incl. ${musd(s.fee, 2)} rescue fee)`,
    ``,
    `Open it on testnet.mezo.org, then /watch your 0x address. Plan on the web: ${config.publicUrl}/?tab=plan&btc=${btcArg}&musd=${musdArg}`,
  ];
  return ctx.reply(lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n"), html);
});

bot.command("rescue", (ctx) => {
  const list = watches.forChat(ctx.chat.id);
  const target = list[0]?.borrower;
  const url = `${config.publicUrl}/${target ? `?borrower=${getAddress(target)}` : ""}`;
  return ctx.reply(
    `🛟 <b>Pre-signed rescue</b>\n\n1. Deposit a MUSD reserve into the Vigil contract.\n2. Choose a trigger ratio (above 110%), a redemption guard (MUSD of debt ahead of you in the redemption queue), or both.\n3. Sign one capped repay with your wallet.\n\nIf your ratio drops below the trigger, or less debt than your guard is ahead of you in Mezo's redemption queue, Vigil submits that exact repay. Mezo checks your signature, so the amount, the loan and the deadline can't be changed.\n\nOpen in a browser with your wallet:\n${url}`,
    html,
  );
});

bot.catch((err) => logError("telegram error", err.error));

export async function notify(chatId: number, text: string) {
  if (!telegramEnabled) return;
  try {
    await bot.api.sendMessage(chatId, text, html);
  } catch (e) {
    logError(`notify ${chatId} failed`, e);
  }
}

export async function notifyBorrower(borrower: string, text: string) {
  for (const w of watches.forBorrower(borrower)) await notify(w.chatId, text);
}

/** Starts polling; retries instead of crashing the service when Telegram is unreachable. */
export async function startTelegram(attempt = 1): Promise<void> {
  if (!telegramEnabled) {
    console.warn("telegram: TELEGRAM_BOT_TOKEN not set, bot disabled");
    return;
  }
  try {
    await registerCommands();
    await bot.init();
  } catch (e) {
    const wait = Math.min(60, 5 * attempt);
    logError(`telegram unreachable (attempt ${attempt}), retrying in ${wait}s:`, e);
    setTimeout(() => void startTelegram(attempt + 1), wait * 1000);
    return;
  }
  void bot
    .start({ drop_pending_updates: true, onStart: (me) => console.log(`telegram: @${me.username} polling`) })
    .catch((e) => logError("telegram polling stopped:", e));
}

async function registerCommands() {
  await bot.api.setMyCommands([
    { command: "watch", description: "Watch a Mezo address" },
    { command: "status", description: "Your positions now" },
    { command: "alerts", description: "Change your alert line" },
    { command: "rescue", description: "Set up a pre-signed rescue" },
    { command: "plan", description: "Plan a new MUSD loan before you borrow" },
    { command: "redemption", description: "Alert when the redemption queue gets close" },
    { command: "unwatch", description: "Stop watching" },
    { command: "feedback", description: "Tell the Vigil team what to fix" },
    { command: "help", description: "How Vigil works" },
  ]);
}

