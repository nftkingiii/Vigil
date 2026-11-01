import { explorerAddress } from "./mezo.ts";
import { btc, type Level, musd, pct, type Position, usd } from "./risk.ts";
import type { MezoSystem } from "./snapshot.ts";

/** Telegram HTML parse mode. Escape anything that is not ours. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const levelLabel: Record<Level, string> = {
  ok: "🟢 Healthy",
  watch: "🟡 Below your alert line",
  danger: "🟠 Danger",
  liquidatable: "🔴 Liquidatable",
};

/** Redemptions take the lowest-ratio troves first; within this many places is "front of the queue". */
export const REDEMPTION_ALERT_RANK = 5;

/**
 * What Recovery Mode changes for a borrower, from mezo-org/musd: liquidation stays at 110%
 * (TroveManager liquidates only ICR < MCR), repaying and adding collateral still work, but
 * BorrowerOperations blocks collateral withdrawals, closing and refinancing, and only allows new
 * debt that leaves the loan at or above 150% (CCR).
 */
export function recoveryModeText(s: MezoSystem): string {
  const tcr = s.tcr !== null ? pct(s.tcr, 1) : "unknown";
  return `Mezo's system-wide collateral ratio is ${tcr}, under its ${pct(s.ccr, 0)} line. Liquidation still happens below ${pct(s.mcr, 0)}, and repaying or adding collateral still works, so a Vigil rescue can still run. Until it ends you can't withdraw collateral, close or refinance a loan, and you can only borrow more if the loan ends at or above ${pct(s.ccr, 0)} with a better ratio than before.`;
}

export function positionCard(p: Position, price: bigint, alertIcr: bigint, level: Level, system?: MezoSystem): string {
  const lines = [
    `<b>${levelLabel[level]}</b> · <a href="${explorerAddress(p.borrower)}">${short(p.borrower)}</a>`,
    ``,
    `Collateral ratio <b>${pct(p.icr, 2)}</b> (alert at ${pct(alertIcr, 0)}, liquidation at ${system ? pct(system.mcr, 0) : "110%"})`,
    `Collateral ${btc(p.coll)} · Debt ${musd(p.debt)}`,
    ``,
    `<b>Liquidation</b>: BTC at ${usd(p.liquidationPrice)} (now ${usd(price)}, ${pct(p.dropToLiquidation)} away)`,
  ];
  if (p.redemptionRank !== null) {
    const front = p.redemptionRank <= REDEMPTION_ALERT_RANK;
    lines.push(
      `<b>Redemption queue</b>: #${p.redemptionRank} of ${p.redeemableTroves}${front ? " ⚠️ near the front" : ""}`,
      `   ${musd(p.redemptionBuffer)} of other debt gets redeemed before yours`,
    );
  } else {
    lines.push(`<b>Redemption queue</b>: not redeemable (under 110%)`);
  }
  if (p.daysToMcrFlat !== null) {
    lines.push(`<b>Interest drift</b>: ${Math.round(p.daysToMcrFlat).toLocaleString("en-US")} days to 110% if BTC stays flat`);
  }
  if (system?.recoveryMode) lines.push(``, `🟠 <b>Mezo is in Recovery Mode</b>: no collateral withdrawals, closing or refinancing until it ends.`);
  return lines.join("\n");
}

export const helpText = `<b>Vigil</b> watches your MUSD loan on Mezo and warns you before it gets hurt.

<b>What it watches</b>
• <b>Liquidation</b>: the BTC price where your loan hits 110%.
• <b>Redemption</b>: Mezo redeems MUSD against the lowest-ratio loans first. If yours is near the front, you can lose BTC at par even far above 110%.
• <b>Interest drift</b>: how long interest alone takes to push you to 110%.
• <b>Stale price</b>: if Mezo's price feed is stale, Vigil says so and does nothing.
• <b>Recovery Mode</b>: when Mezo's system-wide ratio falls under 150%, Vigil tells you what you can and can't do until it ends.
• <b>Rescue checks</b>: every minute Vigil checks your armed rescue can still succeed (reserve, trigger, Mezo's minimum debt, expiry) and tells you if it can't.

<b>Commands</b>
/watch &lt;address&gt; [alert%]: watch the 0x Mezo address that owns your MUSD loan (default alert 150%). If you sign in to Mezo with a Bitcoin wallet, use the 0x account shown in the Mezo app, not your bc1… address.
/status: your positions now
/alerts &lt;percent&gt;: change your alert line, e.g. /alerts 160
/rescue: set up a pre-signed rescue
/unwatch [address]: stop watching
/help: this message

<b>Rescue</b>: you keep a MUSD reserve in the Vigil contract and sign one capped repay in advance. If your ratio falls below your trigger, Vigil submits it. Mezo's own contract checks your signature, so Vigil can't change the amount, the loan or the deadline. Rescue needs an EVM wallet such as MetaMask; Bitcoin-wallet (Passport) accounts get alerts only.

Mezo testnet only.`;
