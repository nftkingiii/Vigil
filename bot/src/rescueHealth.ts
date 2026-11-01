import { maxRepay, musd } from "./risk.ts";

/**
 * Why an armed rescue can't succeed right now, checked every snapshot so the borrower hears about it
 * before they need the rescue, not after. Blocking issues stop the keeper from submitting; the
 * borrower can fix each one without signing again. Permanent failures (expired, nonce moved, loan
 * closed) void the signature instead and are handled by the keeper.
 */
export interface RescueIssue {
  code: "reserve_low" | "trigger_off" | "below_min_debt" | "expiring";
  blocking: boolean;
  text: string;
}

export const BLOCKING: ReadonlySet<string> = new Set(["reserve_low", "trigger_off", "below_min_debt"]);

export const EXPIRY_WARNING_SEC = 24 * 3600;

export function rescueIssues(r: {
  amount: bigint;
  deadline: number;
  now: number;
  reserve: bigint;
  trigger: bigint;
  /** Current debt, or null when the loan isn't in the snapshot. */
  debt: bigint | null;
  limits: { minNetDebt: bigint; gasCompensation: bigint };
}): RescueIssue[] {
  const out: RescueIssue[] = [];
  if (r.reserve < r.amount) {
    out.push({
      code: "reserve_low",
      blocking: true,
      text: `your Vigil reserve holds ${musd(r.reserve)} but the signed repay is ${musd(r.amount)}. Deposit at least ${musd(r.amount - r.reserve)} more.`,
    });
  }
  if (r.trigger === 0n) {
    out.push({ code: "trigger_off", blocking: true, text: "your rescue trigger is switched off. Set a trigger on the web page." });
  }
  if (r.debt !== null) {
    const max = maxRepay(r.debt, r.limits);
    if (r.amount > max) {
      out.push({
        code: "below_min_debt",
        blocking: true,
        text: `the signed repay of ${musd(r.amount)} would take your loan under Mezo's ${musd(r.limits.minNetDebt)} minimum net debt, so Mezo would reject it. The most it allows now is ${musd(max)}. Sign a smaller rescue.`,
      });
    }
  }
  const left = r.deadline - r.now;
  if (left > 0 && left <= EXPIRY_WARNING_SEC) {
    out.push({
      code: "expiring",
      blocking: false,
      text: `the signature expires in ${Math.max(1, Math.round(left / 3600))} h. Sign a new one with /rescue to stay covered.`,
    });
  }
  return out;
}

/** Stable key for "did anything change since we last told the borrower". */
export const issueKey = (issues: RescueIssue[]) => issues.map((i) => i.code).sort().join(",");
