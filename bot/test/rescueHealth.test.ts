import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPIRY_WARNING_SEC, issueKey, rescueIssues } from "../src/rescueHealth.ts";

const e18 = (n: number) => BigInt(n) * 10n ** 18n;
const now = 1_800_000_000;
const base = {
  amount: e18(300),
  deadline: now + 7 * 86_400,
  now,
  reserve: e18(400),
  trigger: 135n * 10n ** 16n,
  guard: 0n,
  debt: e18(2_502),
  limits: { minNetDebt: e18(1_800), gasCompensation: e18(200) },
};

test("a funded rescue on a loan with room to repay has no issues", () => {
  assert.deepEqual(rescueIssues(base), []);
});

test("withdrawn reserve and switched-off trigger block the rescue", () => {
  const issues = rescueIssues({ ...base, reserve: e18(100), trigger: 0n });
  assert.equal(issueKey(issues), "reserve_low,trigger_off");
  assert.ok(issues.every((i) => i.blocking));
  assert.match(issues[0]!.text, /201\.50 MUSD more/); // 300 repay + 1.50 fee - 100 held
});

test("a repay that would break Mezo's minimum net debt is flagged with the current maximum", () => {
  // 2,250 debt - 200 gas comp - 1,800 min = 250 max; signed 300 fails.
  const issues = rescueIssues({ ...base, debt: e18(2_250) });
  assert.equal(issueKey(issues), "below_min_debt");
  assert.match(issues[0]!.text, /250 MUSD/);
  // A higher on-chain minimum blocks a repay that fits today's.
  assert.equal(issueKey(rescueIssues({ ...base, limits: { minNetDebt: e18(2_100), gasCompensation: e18(200) } })), "below_min_debt");
});

test("the reserve must cover the repay plus the fee", () => {
  assert.equal(issueKey(rescueIssues({ ...base, reserve: e18(300) })), "reserve_low");
  assert.equal(issueKey(rescueIssues({ ...base, reserve: e18(302) })), "");
});

test("a redemption guard alone keeps the rescue on", () => {
  assert.equal(issueKey(rescueIssues({ ...base, trigger: 0n, guard: e18(50_000) })), "");
});

test("a signature about to expire warns without blocking", () => {
  const issues = rescueIssues({ ...base, deadline: now + EXPIRY_WARNING_SEC - 60 });
  assert.equal(issueKey(issues), "expiring");
  assert.equal(issues[0]!.blocking, false);
});

test("an unknown debt skips only the min-debt check", () => {
  assert.equal(issueKey(rescueIssues({ ...base, debt: null, reserve: 0n })), "reserve_low");
});
