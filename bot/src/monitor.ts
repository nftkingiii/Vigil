import { config } from "./config.ts";
import { levelLabel, positionCard, recoveryModeText, REDEMPTION_ALERT_RANK, short } from "./format.ts";
import { runKeeper } from "./keeper.ts";
import { type Level, levelFor, musd, position, repayForDebtAhead } from "./risk.ts";
import { takeSnapshot, type Snapshot } from "./snapshot.ts";
import { watches } from "./store.ts";
import { notify } from "./telegram.ts";

let latest: Snapshot | null = null;
let lastError: string | null = null;
/** When the last fresh price was read, for /health's price age. */
let lastFreshPriceAt: Date | null = null;
let running = false;
/** Last Recovery Mode state seen; null until the first fresh price. Alerts fire on changes only. */
let recoveryMode: boolean | null = null;

export const latestSnapshot = () => latest;
export const monitorStatus = () => ({
  lastSnapshotAt: latest?.at.toISOString() ?? null,
  block: latest?.block.toString() ?? null,
  troves: latest?.troves.length ?? 0,
  price: latest ? (latest.price.ok ? { ok: true, price: latest.price.price.toString() } : latest.price) : null,
  lastFreshPriceAt: lastFreshPriceAt?.toISOString() ?? null,
  priceAgeSec: lastFreshPriceAt ? Math.round((Date.now() - lastFreshPriceAt.getTime()) / 1000) : null,
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

    // Personal redemption threshold: alert on crossing it, with the repay that restores a cushion.
    if (w.redemptionAlert !== null) {
      const below = p.redemptionRank !== null && p.redemptionBuffer < w.redemptionAlert;
      if (below && !w.belowRedemption) {
        const target = w.redemptionAlert * 2n;
        const repay = repayForDebtAhead(snap.troves, w.borrower, snap.price.price, target, snap.system);
        const fix =
          repay === null
            ? `A repay alone can't put ${musd(target)} ahead of you within Mezo's minimum debt; adding collateral would.`
            : repay === 0n
              ? ``
              : `Repaying about <b>${musd(repay)}</b> would put ${musd(target)} (twice your threshold) of other debt ahead of you again.`;
        await notify(
          w.chatId,
          `⚠️ <b>Redemption threshold crossed</b> for <code>${short(w.borrower)}</code>: only ${musd(p.redemptionBuffer)} of other debt is ahead of you in Mezo's redemption queue (your threshold: ${musd(w.redemptionAlert)}).\n${fix}\n\n${positionCard(p, snap.price.price, w.alertIcr, level, snap.system)}`,
        );
      } else if (!below && w.belowRedemption) {
        await notify(w.chatId, `✅ Back above your redemption threshold: ${musd(p.redemptionBuffer)} of other debt is ahead of <code>${short(w.borrower)}</code>.`);
      }
      if (below !== w.belowRedemption) watches.setBelowRedemption(w.chatId, w.borrower, below);
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
    if (snap.price.ok) lastFreshPriceAt = snap.at;
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
