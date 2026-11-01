/**
 * Pure risk math for a MUSD trove. All values are 1e18 fixed point bigints, as on-chain.
 *
 * Mezo facts this relies on (mezo-org/musd):
 * - Liquidation below 110% ICR (LiquityBase.MCR).
 * - Redemptions walk SortedTroves from the lowest nominal ICR (coll / principal) upward and skip
 *   troves under 110% (TroveManager.redeemCollateral).
 * - Interest is simple and linear on principal at a fixed per-trove rate in basis points.
 */

export const WAD = 10n ** 18n;
export const MCR = 11n * 10n ** 17n; // 1.1e18
const NICR_PRECISION = 10n ** 20n; // LiquityMath.NICR_PRECISION
const YEAR_SECONDS = 365n * 24n * 3600n;

export interface Trove {
  borrower: `0x${string}`;
  coll: bigint;
  principal: bigint;
  interest: bigint;
  rateBips: number;
}

export interface Position {
  borrower: `0x${string}`;
  coll: bigint;
  debt: bigint;
  icr: bigint;
  /** BTC price at which ICR reaches 110%. */
  liquidationPrice: bigint;
  /** How far BTC can fall before liquidation, 1e18 = 100%. Zero if already under. */
  dropToLiquidation: bigint;
  /** Days until interest alone takes ICR to 110% at a flat price. null if no interest accrues. */
  daysToMcrFlat: number | null;
  /** Position in the redemption queue, 1 = redeemed first. null if under 110% (not redeemable). */
  redemptionRank: number | null;
  /** MUSD debt of troves redeemed before this one. */
  redemptionBuffer: bigint;
  redeemableTroves: number;
}

export const debtOf = (t: Trove) => t.principal + t.interest;

export function icr(coll: bigint, debt: bigint, price: bigint): bigint {
  if (debt === 0n) return 2n ** 256n - 1n;
  return (coll * price) / debt;
}

export function nicr(t: Trove): bigint {
  if (t.principal === 0n) return 2n ** 256n - 1n;
  return (t.coll * NICR_PRECISION) / t.principal;
}

export function liquidationPrice(coll: bigint, debt: bigint): bigint {
  if (coll === 0n) return 0n;
  return (MCR * debt) / coll;
}

export function daysToMcrFlat(t: Trove, price: bigint): number | null {
  const debt = debtOf(t);
  const interestPerYear = (t.principal * BigInt(t.rateBips)) / 10_000n;
  if (interestPerYear === 0n) return null;
  const headroom = (t.coll * price) / MCR - debt; // MUSD of debt the trove can still absorb
  if (headroom <= 0n) return 0;
  const seconds = (headroom * YEAR_SECONDS) / interestPerYear;
  return Number(seconds) / 86_400;
}

/**
 * Builds the position for `borrower` from a snapshot of every trove at `price`.
 * Redemption order follows SortedTroves (ascending NICR), skipping troves under 110%.
 */
export function position(all: Trove[], borrower: string, price: bigint): Position | null {
  const target = all.find((t) => t.borrower.toLowerCase() === borrower.toLowerCase());
  if (!target) return null;

  const debt = debtOf(target);
  const currentIcr = icr(target.coll, debt, price);
  const liqPrice = liquidationPrice(target.coll, debt);
  const drop = price > liqPrice ? ((price - liqPrice) * WAD) / price : 0n;

  const queue = all
    .filter((t) => icr(t.coll, debtOf(t), price) >= MCR)
    .sort((a, b) => (nicr(a) < nicr(b) ? -1 : nicr(a) > nicr(b) ? 1 : 0));

  let rank: number | null = null;
  let buffer = 0n;
  for (const [i, t] of queue.entries()) {
    if (t.borrower.toLowerCase() === borrower.toLowerCase()) {
      rank = i + 1;
      break;
    }
    buffer += debtOf(t);
  }
  if (rank === null) buffer = 0n;

  return {
    borrower: target.borrower,
    coll: target.coll,
    debt,
    icr: currentIcr,
    liquidationPrice: liqPrice,
    dropToLiquidation: drop,
    daysToMcrFlat: daysToMcrFlat(target, price),
    redemptionRank: rank,
    redemptionBuffer: buffer,
    redeemableTroves: queue.length,
  };
}

export type Level = "ok" | "watch" | "danger" | "liquidatable";

/** Alert level from ICR against the user's own alert line (default 150%). */
export function levelFor(p: Position, alertIcr: bigint): Level {
  if (p.icr < MCR) return "liquidatable";
  const dangerLine = MCR + (alertIcr - MCR) / 2n; // halfway between 110% and the alert line
  if (p.icr < dangerLine) return "danger";
  if (p.icr < alertIcr) return "watch";
  return "ok";
}

/**
 * Largest repay Mezo accepts: BorrowerOperations requires net debt (debt minus gas compensation) to
 * stay at or above minNetDebt after a repay. Both values come from Mezo on-chain (snapshot.system).
 */
export function maxRepay(debt: bigint, limits: { minNetDebt: bigint; gasCompensation: bigint }): bigint {
  const floor = limits.minNetDebt + limits.gasCompensation;
  return debt > floor ? debt - floor : 0n;
}

/** Repay needed to lift ICR to `target` at `price`. */
export function repayToReach(coll: bigint, debt: bigint, price: bigint, target: bigint): bigint {
  const maxDebt = (coll * price) / target;
  return debt > maxDebt ? debt - maxDebt : 0n;
}

// ------------------------------------------------------------------ formatting

export function pct(x: bigint, decimals = 1): string {
  const scaled = Number((x * 10_000n) / WAD) / 100;
  return `${scaled.toFixed(decimals)}%`;
}

export function usd(x: bigint, decimals = 0): string {
  const n = Number(x / 10n ** 14n) / 10_000;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

export function musd(x: bigint, decimals = 0): string {
  const n = Number(x / 10n ** 14n) / 10_000;
  return `${n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} MUSD`;
}

export function btc(x: bigint): string {
  return `${(Number(x / 10n ** 10n) / 1e8).toFixed(6)} BTC`;
}

export function parsePercent(input: string): bigint | null {
  const m = /^(\d{2,4})(?:\.(\d{1,2}))?%?$/.exec(input.trim());
  if (!m) return null;
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? "").padEnd(2, "0"));
  return ((whole * 100n + frac) * WAD) / 10_000n;
}
