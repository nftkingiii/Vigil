import assert from "node:assert/strict";
import { test } from "node:test";
import {
  daysToMcrFlat,
  icr,
  levelFor,
  liquidationPrice,
  maxRepay,
  MCR,
  nearestByNicr,
  nicr,
  nicrAfterRepay,
  rescueFee,
  planLoan,
  parseAmount,
  guardReach,
  repayForDebtAhead,
  parsePercent,
  position,
  repayToReach,
  type Trove,
  WAD,
} from "../src/risk.ts";

const e18 = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const trove = (borrower: string, coll: number, principal: number, interest = 0, rateBips = 100): Trove => ({
  borrower: borrower as `0x${string}`,
  coll: e18(coll),
  principal: e18(principal),
  interest: e18(interest),
  rateBips,
});

test("ICR and liquidation price match the Liquity formulas", () => {
  // Sample read from Mezo testnet on 2026-10-12: 0.029938 BTC, 2,211.55 MUSD debt.
  const coll = e18(0.029938);
  const debt = e18(2211.552);
  const price = e18(82431.08);
  const r = icr(coll, debt, price);
  assert.ok(Math.abs(Number(r) / 1e18 - 1.11585) < 1e-4);
  const liq = liquidationPrice(coll, debt);
  const atLiq = icr(coll, debt, liq); // 110% at the liquidation price, up to integer rounding
  assert.ok(MCR - atLiq < 10n ** 6n, `ICR at liquidation price ${atLiq}`);
});

test("days to 110% at a flat price uses simple interest on principal", () => {
  // 1 BTC at $100k, 50k principal at 10%/yr: headroom = 100k/1.1 - 50k = 40,909 MUSD; 5k/yr -> ~8.18 years.
  const t = trove("0x1", 1, 50_000, 0, 1000);
  const days = daysToMcrFlat(t, e18(100_000))!;
  assert.ok(Math.abs(days / 365 - 40_909.09 / 5_000) < 0.01);
  assert.equal(daysToMcrFlat(trove("0x2", 1, 50_000, 0, 0), e18(100_000)), null);
  assert.equal(daysToMcrFlat(trove("0x3", 1, 95_000), e18(100_000)), 0);
});

test("redemption rank follows ascending NICR and skips troves under 110%", () => {
  const price = e18(100_000);
  const all = [
    trove("0xa", 1, 50_000), // 200%
    trove("0xb", 1, 80_000), // 125% -> first in queue
    trove("0xc", 1, 95_000), // 105% -> liquidatable, not redeemable
    trove("0xd", 1, 70_000), // 143% -> second
  ];
  const d = position(all, "0xd", price)!;
  assert.equal(d.redemptionRank, 2);
  assert.equal(d.redemptionBuffer, e18(80_000));
  assert.equal(d.redeemableTroves, 3);

  const c = position(all, "0xc", price)!;
  assert.equal(c.redemptionRank, null);
  assert.equal(c.redemptionBuffer, 0n);
  assert.equal(c.dropToLiquidation, 0n);
});

test("alert levels: ok, watch, danger (halfway to 110%), liquidatable", () => {
  const price = e18(100_000);
  const alert = e18(1.5);
  const lv = (principal: number) => levelFor(position([trove("0x1", 1, principal)], "0x1", price)!, alert);
  assert.equal(lv(60_000), "ok"); // 166%
  assert.equal(lv(70_000), "watch"); // 142.9%
  assert.equal(lv(80_000), "danger"); // 125% < 130%
  assert.equal(lv(95_000), "liquidatable"); // 105%
});

test("repay limits follow Mezo's on-chain minimum net debt plus gas compensation", () => {
  const testnet = { minNetDebt: e18(1_800), gasCompensation: e18(200) }; // read on 2026-11-01
  assert.equal(maxRepay(e18(5_000), testnet), e18(3_000));
  assert.equal(maxRepay(e18(1_500), testnet), 0n);
  // Governance can change minNetDebt (proposeMinNetDebt); the limit moves with it.
  assert.equal(maxRepay(e18(5_000), { minNetDebt: e18(1_000), gasCompensation: e18(200) }), e18(3_800));
  const need = repayToReach(e18(1), e18(80_000), e18(100_000), e18(1.5));
  assert.ok(Math.abs(Number(need) / 1e18 - (80_000 - 100_000 / 1.5)) < 1e-6);
});

test("percent parsing", () => {
  assert.equal(parsePercent("150"), e18(1.5));
  assert.equal(parsePercent("162.5%"), e18(1.625));
  assert.equal(parsePercent("abc"), null);
  assert.equal(parsePercent("1"), null);
  assert.equal(WAD, 10n ** 18n);
});

test("a repay pays interest first, then principal, and re-sorts by coll / principal", () => {
  const t = trove("0x1", 1, 10_000, 50);
  assert.equal(nicrAfterRepay(t, e18(50)), nicr(t), "interest-only repay leaves principal, so NICR is unchanged");
  assert.equal(nicrAfterRepay(t, e18(1_050)), nicr({ ...t, principal: e18(9_000) }));
});

test("hint search picks the nearest other trove by nominal ICR", () => {
  const all = [trove("0xa", 1, 10_000), trove("0xb", 1, 20_000), trove("0xc", 1, 40_000)];
  // Excluding 0xb itself, 0xc (half its NICR) is closer than 0xa (double it).
  assert.equal(nearestByNicr(all, nicr(all[1]!) + 1n, "0xb")?.borrower, "0xc");
  assert.equal(nearestByNicr(all, nicr(all[2]!), "0xd")?.borrower, "0xc");
});

test("rescue fee is 0.5% of the amount, capped at 25 MUSD (VigilReserve v3)", () => {
  assert.equal(rescueFee(e18(300)), e18(1.5));
  assert.equal(rescueFee(e18(5_000)), e18(25));
  assert.equal(rescueFee(e18(1_000_000)), e18(25));
});

const testnetSystem = {
  mcr: e18(1.1),
  ccr: e18(1.5),
  minNetDebt: e18(1_800),
  gasCompensation: e18(200),
  borrowingRate: e18(0.001),
  newLoanRateBips: 100,
  recoveryMode: false as boolean | null,
};

test("planner: debt is borrow + 0.1% fee + 200 gas compensation, ratio and queue spot among today's troves", () => {
  const others = [trove("0xa", 1, 60_000), trove("0xb", 1, 30_000)]; // 133% and 267% at $80k
  const plan = planLoan(others, { coll: e18(0.05), borrow: e18(2_500), price: e18(80_000), system: testnetSystem });
  assert.equal(plan.ok, true);
  assert.equal(plan.borrowingFee, e18(2.5));
  assert.equal(plan.debt, e18(2_702.5));
  assert.ok(Math.abs(Number(plan.position.icr) / 1e18 - 4_000 / 2_702.5) < 1e-9); // ~148%
  assert.equal(plan.position.redemptionRank, 2, "behind the 133% trove, ahead of the 267% one");
  assert.equal(plan.position.redemptionBuffer, e18(60_000));
});

test("planner: suggests a trigger halfway to 110%, a repay that restores the ratio, a guard at half the debt ahead", () => {
  const others = [trove("0xa", 1, 60_000)];
  const plan = planLoan(others, { coll: e18(0.05), borrow: e18(2_500), price: e18(80_000), system: testnetSystem });
  const s = plan.suggestion;
  assert.equal(s.trigger, e18(1.29)); // 110% + (148% - 110%) / 2, rounded down to a whole percent
  assert.equal(s.guard, e18(30_000));
  assert.equal(s.fee, rescueFee(s.repay));
  assert.equal(s.reserve, s.repay + s.fee);
  // At the trigger's price, repaying s.repay brings the ratio back to about today's.
  const priceAtTrigger = (s.trigger * plan.debt) / e18(0.05);
  const restored = Number((e18(0.05) * priceAtTrigger) / (plan.debt - s.repay)) / 1e18;
  assert.ok(Math.abs(restored - Number(plan.position.icr) / 1e18) < 0.01, `restored ${restored}`);
});

test("planner: flags loans Mezo would refuse", () => {
  const tooSmall = planLoan([], { coll: e18(1), borrow: e18(1_000), price: e18(80_000), system: testnetSystem });
  assert.equal(tooSmall.ok, false);
  assert.match(tooSmall.problems[0]!, /minimum loan/);
  const tooThin = planLoan([], { coll: e18(0.03), borrow: e18(2_200), price: e18(80_000), system: testnetSystem });
  assert.match(tooThin.problems.join(" "), /above 110%/);
  const recovery = planLoan([], { coll: e18(0.05), borrow: e18(2_500), price: e18(80_000), system: { ...testnetSystem, recoveryMode: true } });
  assert.match(recovery.problems.join(" "), /Recovery Mode/); // 148% < 150%
});

test("amount parsing", () => {
  assert.equal(parseAmount("0.05"), e18(0.05));
  assert.equal(parseAmount("2500"), e18(2_500));
  assert.equal(parseAmount("0"), null);
  assert.equal(parseAmount("-1"), null);
  assert.equal(parseAmount("1e5"), null);
});

test("guard reach counts redeemable debt in the first 60 troves of the queue only", () => {
  const many = Array.from({ length: 80 }, (_, i) => trove(`0x${i}`, 1, 50_000 - i)); // all ~160%
  const reach = guardReach(many, e18(80_000), "0xnone");
  // The 59 lowest-NICR troves (largest principal) are within reach; the walk's 60th step is the loan itself.
  const expected = many.slice(0, 59).reduce((a, t) => a + t.principal, 0n);
  assert.equal(reach, expected);
  const plan = planLoan(many, { coll: e18(0.1), borrow: e18(5_000), price: e18(80_000), system: testnetSystem });
  assert.ok(plan.suggestion.guard === null || plan.suggestion.guard <= reach, "never suggests a guard the contract can't see");
});

test("repay for debt ahead: smallest repay that moves the loan behind enough redeemable debt", () => {
  const limits = { minNetDebt: e18(1_800), gasCompensation: e18(200) };
  // Queue at $80k by NICR: me (1 BTC, 60,000) is first; then 0xa 55,000, 0xb 50,000, 0xc 45,000.
  const me = trove("0xme", 1, 60_000);
  const all = [me, trove("0xa", 1, 55_000), trove("0xb", 1, 50_000), trove("0xc", 1, 45_000)];
  const price = e18(80_000);
  // To have 100,000 ahead, the loan must pass 0xa and 0xb: principal under 50,000.
  const r = repayForDebtAhead(all, "0xme", price, e18(100_000), limits)!;
  assert.equal(r, e18(10_001));
  const after = position([{ ...me, principal: me.principal - r }, ...all.slice(1)], "0xme", price)!;
  assert.ok(after.redemptionBuffer >= e18(100_000), "target reached");
  // Already behind enough debt: no repay needed.
  assert.equal(repayForDebtAhead(all, "0xc", price, e18(55_000), limits), 0n);
  // More than exists in the system: null.
  assert.equal(repayForDebtAhead(all, "0xme", price, e18(1_000_000), limits), null);
});
