import { config } from "./config.ts";
import { levelLabel, positionCard, recoveryModeText, REDEMPTION_ALERT_RANK, short } from "./format.ts";
import { runKeeper } from "./keeper.ts";
import { type Level, levelFor, position } from "./risk.ts";
import { takeSnapshot, type Snapshot } from "./snapshot.ts";
import { watches } from "./store.ts";
import { notify } from "./telegram.ts";

let latest: Snapshot | null = null;
let lastError: string | null = null;
let running = false;
/** Last Recovery Mode state seen; null until the first fresh price. Alerts fire on changes only. */
let recoveryMode: boolean | null = null;

export const latestSnapshot = () => latest;
export const monitorStatus = () => ({
  lastSnapshotAt: latest?.at.toISOString() ?? null,
  block: latest?.block.toString() ?? null,
  troves: latest?.troves.length ?? 0,
  price: latest ? (latest.price.ok ? { ok: true, price: latest.price.price.toString() } : latest.price) : null,
  system: latest
    ? {
        minNetDebt: latest.system.minNetDebt.toString(),
        gasCompensation: latest.system.gasCompensation.toString(),
        mcr: latest.system.mcr.toString(),
        ccr: latest.system.ccr.toString(),
        recoveryMode: latest.system.recoveryMode,
        tcr: latest.system.tcr?.toString() ?? null,
      }
    : null,
  lastError,
});

const severity: Record<Level, number> = { ok: 0, watch: 1, danger: 2, liquidatable: 3 };

/** Tells every watcher when Mezo enters or leaves Recovery Mode. */
async function evaluateRecoveryMode(snap: Snapshot) {
  const now = snap.system.recoveryMode;
  if (now === null) return; // unknown without a fresh price; keep the last state
  const before = recoveryMode;
  recoveryMode = now;
  if (before === null || before === now) return;
  const chats = new Set(watches.all().map((w) => w.chatId));
  const text = now
    ? `🟠 <b>Mezo is in Recovery Mode</b>\n\n${recoveryModeText(snap.system)}`
    : `🟢 Mezo has left Recovery Mode. Borrowing, collateral withdrawals, closing and refinancing work normally again.`;
  for (const chatId of chats) await notify(chatId, text);
}

/** Sends alerts on level changes, redemption-queue entry and price-feed pauses. */
async function evaluateWatches(snap: Snapshot) {
  for (const w of watches.all()) {
    if (!snap.price.ok) {
      if (!w.pricePaused) {
        await notify(
          w.chatId,
          `⏸ Mezo's price feed is unavailable (${snap.price.reason}). Vigil is paused for <code>${short(w.borrower)}</code> and won't act on a guessed price.`,
        );
        watches.setState(w.chatId, w.borrower, w.lastLevel, w.lastRank, true);
      }
      continue;
    }

    const p = position(snap.troves, w.borrower, snap.price.price);
    if (!p) {
      if (w.lastLevel !== "none") watches.setState(w.chatId, w.borrower, "none", null, false);
      continue;
    }

    const level = levelFor(p, w.alertIcr);
    const prev = (w.lastLevel in severity ? w.lastLevel : "ok") as Level;
    const enteredFront =
      p.redemptionRank !== null &&
      p.redemptionRank <= REDEMPTION_ALERT_RANK &&
      (w.lastRank === null || w.lastRank > REDEMPTION_ALERT_RANK);

    if (w.pricePaused) {
      await notify(w.chatId, `▶️ Mezo's price feed is back. Watching <code>${short(w.borrower)}</code> again.`);
    }

    if (severity[level] > severity[prev]) {
      await notify(w.chatId, `🚨 <b>${levelLabel[level]}</b>\n\n${positionCard(p, snap.price.price, w.alertIcr, level, snap.system)}\n\n/rescue to set up a pre-signed repay.`);
    } else if (severity[level] < severity[prev] && level === "ok") {
      await notify(w.chatId, `✅ Back above your alert line.\n\n${positionCard(p, snap.price.price, w.alertIcr, level, snap.system)}`);
    } else if (enteredFront) {
      await notify(
        w.chatId,
        `⚠️ <b>Redemption risk</b>: your loan is now #${p.redemptionRank} in Mezo's redemption queue. Redemptions take BTC from the lowest-ratio loans first, even when they are far above 110%.\n\n${positionCard(p, snap.price.price, w.alertIcr, level, snap.system)}`,
      );
    }

    watches.setState(w.chatId, w.borrower, level, p.redemptionRank, false);
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const snap = await takeSnapshot();
    latest = snap;
    lastError = null;
    await evaluateRecoveryMode(snap);
    await evaluateWatches(snap);
    await runKeeper(snap);
  } catch (e) {
    lastError = e instanceof Error ? e.message.split("\n")[0]! : String(e);
    console.error("monitor tick failed:", lastError);
  } finally {
    running = false;
  }
}

export function startMonitor() {
  void tick();
  setInterval(() => void tick(), config.snapshotIntervalSec * 1000);
}
