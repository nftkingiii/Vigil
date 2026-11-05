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

/** VigilReserve walks at most this many troves from the front of the queue (MAX_QUEUE_STEPS). */
export const MAX_QUEUE_STEPS = 60;

/**
 * Most debt-ahead a redemption guard can see: the redeemable debt among the first MAX_QUEUE_STEPS
 * troves of the queue (troves under 110% use up a step but add no debt, as on-chain). A loan
 * further back than that is never found by the contract, so a larger guard can't fire.
 */
export function guardReach(all: Trove[], price: bigint, exclude: string): bigint {
  const list = all
    .filter((t) => t.borrower.toLowerCase() !== exclude.toLowerCase())
    .sort((a, b) => (nicr(a) < nicr(b) ? -1 : nicr(a) > nicr(b) ? 1 : 0))
    .slice(0, MAX_QUEUE_STEPS - 1);
  let reach = 0n;
  for (const t of list) if (icr(t.coll, debtOf(t), price) >= MCR) reach += debtOf(t);
  return reach;
}

/**
 * Smallest repay that puts at least `target` MUSD of other debt ahead of `borrower` in the
 * redemption queue. Repaying lowers principal (after interest, which goes first), raising the
 * loan's nominal ICR past the troves it must move behind. Returns null when even Mezo's largest
 * allowed repay can't get there (more collateral is the fix then).
 */
export function repayForDebtAhead(
  all: Trove[],
  borrower: string,
  price: bigint,
  target: bigint,
  limits: { minNetDebt: bigint; gasCompensation: bigint },
): bigint | null {
  const me = all.find((t) => t.borrower.toLowerCase() === borrower.toLowerCase());
  if (!me) return null;
  const others = all
    .filter((t) => t !== me && icr(t.coll, debtOf(t), price) >= MCR)
    .sort((a, b) => (nicr(a) < nicr(b) ? -1 : nicr(a) > nicr(b) ? 1 : 0));
  let ahead = 0n;
  let passNicr: bigint | null = null; // nominal ICR the loan must exceed
  for (const t of others) {
    ahead += debtOf(t);
    if (ahead >= target) {
      passNicr = nicr(t);
      break;
    }
  }
  if (passNicr === null) return null; // not that much redeemable debt in the whole system
  if (nicr(me) > passNicr) return 0n;
  // principal must drop below coll * 1e20 / passNicr
  const maxPrincipal = (me.coll * 10n ** 20n) / passNicr - 1n;
  const repay = me.interest + (me.principal - maxPrincipal);
  const rounded = ((repay + WAD - 1n) / WAD) * WAD; // whole MUSD, rounded up
  return rounded <= maxRepay(debtOf(me), limits) ? rounded : null;
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

/**
 * Nominal ICR after repaying `amount`. Mezo applies a repay to accrued interest first, then to
 * principal (TroveManager._updateTroveDebt), and re-sorts the trove by coll / principal.
 */
export function nicrAfterRepay(t: Trove, amount: bigint): bigint {
  const toPrincipal = amount > t.interest ? amount - t.interest : 0n;
  const principal = t.principal > toPrincipal ? t.principal - toPrincipal : 0n;
  return nicr({ ...t, principal });
}

/**
 * A trove already in the list whose nominal ICR is closest to `target`: a starting hint for
 * SortedTroves.findInsertPosition, which then returns the exact neighbours.
 */
export function nearestByNicr(all: Trove[], target: bigint, exclude: string): Trove | null {
  let best: Trove | null = null;
  let bestGap = 0n;
  for (const t of all) {
    if (t.borrower.toLowerCase() === exclude.toLowerCase()) continue;
    const n = nicr(t);
    const gap = n > target ? n - target : target - n;
    if (best === null || gap < bestGap) {
      best = t;
      bestGap = gap;
    }
  }
  return best;
}

/** VigilReserve v3's fixed rescue fee, paid to the submitter: 0.5% of the amount, at most 25 MUSD. */
export const FEE_BPS = 50n;
export const FEE_CAP = 25n * WAD;
export function rescueFee(amount: bigint): bigint {
  const fee = (amount * FEE_BPS) / 10_000n;
  return fee > FEE_CAP ? FEE_CAP : fee;
}

/** Repay needed to lift ICR to `target` at `price`. */
export function repayToReach(coll: bigint, debt: bigint, price: bigint, target: bigint): bigint {
  const maxDebt = (coll * price) / target;
  return debt > maxDebt ? debt - maxDebt : 0n;
}

// ------------------------------------------------------------------ planning a new loan

export interface PlanInput {
  coll: bigint;
  /** MUSD the borrower wants to receive. */
  borrow: bigint;
  price: bigint;
  system: {
    mcr: bigint;
    ccr: bigint;
    minNetDebt: bigint;
    gasCompensation: bigint;
    borrowingRate: bigint;
    newLoanRateBips: number;
    recoveryMode: boolean | null;
  };
}

export interface Plan {
  ok: boolean;
  /** Why Mezo would refuse to open this loan, if it would. */
  problems: string[];
  /** Total debt at open: what you borrow + Mezo's borrowing fee + gas compensation. */
  debt: bigint;
  borrowingFee: bigint;
  position: Position;
  /** Suggested Vigil setup for this loan. */
  suggestion: {
    trigger: bigint;
    /** null when the loan wouldn't be in the redemption queue, or nothing is ahead of it. */
    guard: bigint | null;
    /** Most debt-ahead the contract's 60-trove walk can see today (guardReach). */
    guardReach: bigint;
    repay: bigint;
    fee: bigint;
    reserve: bigint;
  };
}

const PLAN_ADDRESS = "0x0000000000000000000000000000000000000001" as const;

/**
 * What a new loan would look like on Mezo right now, before it is opened: its ratio and
 * liquidation price, where it would enter the redemption queue among today's troves, how fast
 * interest erodes it, and a Vigil setup that would protect it.
 */
export function planLoan(all: Trove[], input: PlanInput): Plan {
  const { coll, borrow, price, system } = input;
  const borrowingFee = (borrow * system.borrowingRate) / WAD;
  const debt = borrow + borrowingFee + system.gasCompensation;
  const planned: Trove = { borrower: PLAN_ADDRESS, coll, principal: debt, interest: 0n, rateBips: system.newLoanRateBips };
  const p = position([...all, planned], PLAN_ADDRESS, price)!;

  const problems: string[] = [];
  if (borrow + borrowingFee < system.minNetDebt) {
    problems.push(`Mezo's minimum loan is ${musd(system.minNetDebt)} of net debt; this one would be ${musd(borrow + borrowingFee)}.`);
  }
  const floor = system.recoveryMode ? system.ccr : system.mcr;
  if (p.icr < floor) {
    problems.push(
      system.recoveryMode
        ? `Mezo is in Recovery Mode, so a new loan must open at ${pct(system.ccr, 0)} or more; this one would be ${pct(p.icr, 1)}.`
        : `A loan must open above ${pct(system.mcr, 0)}; this one would be ${pct(p.icr, 1)}.`,
    );
  }

  // Trigger halfway between the planned ratio and 110%, never under 115%. At the trigger, the
  // repay that restores the planned ratio is debt * (1 - trigger / planned ICR).
  const midway = system.mcr + (p.icr > system.mcr ? (p.icr - system.mcr) / 2n : 0n);
  const trigger = midway < (115n * WAD) / 100n ? (115n * WAD) / 100n : (midway / 10n ** 16n) * 10n ** 16n;
  let repay = p.icr > trigger ? debt - (debt * trigger) / p.icr : 0n;
  const cap = maxRepay(debt, system);
  if (repay > cap) repay = cap;
  repay = (repay / WAD) * WAD; // whole MUSD
  const fee = rescueFee(repay);
  // Guard at half the debt that would be ahead today, so the rescue runs once half that cushion is
  // gone; never beyond what the contract's 60-trove walk can see, or it could never fire.
  const reach = guardReach(all, price, PLAN_ADDRESS);
  let half = p.redemptionRank !== null && p.redemptionBuffer > 0n ? p.redemptionBuffer / 2n : 0n;
  if (half > reach) half = reach;
  const guard = half > 0n ? (half / (1000n * WAD)) * 1000n * WAD : null;

  return {
    ok: problems.length === 0,
    problems,
    debt,
    borrowingFee,
    position: { ...p, borrower: PLAN_ADDRESS },
    suggestion: { trigger, guard: guard && guard > 0n ? guard : null, guardReach: reach, repay, fee, reserve: repay + fee },
  };
}

/** Parses "0.05" or "2500.5" into 1e18 fixed point; null if it isn't a plain positive number. */
export function parseAmount(s: string | undefined): bigint | null {
  const m = /^(\d{1,12})(?:\.(\d{1,18}))?$/.exec((s ?? "").trim());
  if (!m) return null;
  const v = BigInt(m[1]!) * WAD + BigInt((m[2] ?? "").padEnd(18, "0"));
  return v > 0n ? v : null;
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
