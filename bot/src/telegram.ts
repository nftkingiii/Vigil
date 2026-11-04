import { Bot, type Context } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getAddress, isAddress } from "viem";
import { config } from "./config.ts";
import { esc, helpText, positionCard } from "./format.ts";
import { latestSnapshot } from "./monitor.ts";
import { levelFor, musd, parsePercent, pct, position } from "./risk.ts";
import { BLOCKING } from "./rescueHealth.ts";
import { rescues, watches } from "./store.ts";

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
  const r = rescues.latest(borrower);
  if (!r || r.status !== "armed") return `\n\n<b>Rescue</b>: none armed. /rescue to set one up.`;
  const blocked = r.warning.split(",").some((c) => BLOCKING.has(c));
  const until = new Date(r.deadline * 1000).toISOString().slice(0, 10);
  return `\n\n<b>Rescue</b>: ${musd(r.amount)} armed until ${until}${blocked ? " ❌ <b>can't succeed right now</b>, see the last Vigil message" : " ✅"}`;
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
  return ctx.reply(positionCard(p, snap.price.price, alertIcr, levelFor(p, alertIcr), snap.system) + rescueLine(borrower), html);
}

bot.command("start", (ctx) =>
  ctx.reply(
    `👁 <b>Vigil</b> guards MUSD loans on Mezo.\n\nSend <code>/watch 0xYourAddress</code> to start. Vigil alerts you before liquidation <i>and</i> before redemption, which most borrowers don't see coming.\n\n/help for everything else.`,
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

bot.command("unwatch", (ctx) => {
  const addr = ctx.match.trim();
  if (addr && !isAddress(addr)) return ctx.reply("Usage: /unwatch [0xAddress]");
  const n = watches.remove(ctx.chat.id, addr || undefined);
  return ctx.reply(n ? `Stopped watching ${n} address${n > 1 ? "es" : ""}.` : "You weren't watching that.");
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
    { command: "unwatch", description: "Stop watching" },
    { command: "help", description: "How Vigil works" },
  ]);
}

