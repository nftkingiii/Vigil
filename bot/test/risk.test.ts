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
