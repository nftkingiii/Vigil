import type { Hex } from "viem";
import { addresses, client, sortedTrovesAbi } from "./mezo.ts";
import { nearestByNicr, nicrAfterRepay, type Trove } from "./risk.ts";

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/**
 * Exact (upper, lower) neighbours for the trove's position after the repay. Without hints Mezo's
 * reInsert walks the sorted list from the top, which cost the Oct 16 rescue 3.7M gas and grows
 * with every new trove. Falls back to no hints if the lookup fails; the repay still works then.
 */
export async function repayHints(trove: Trove | undefined, amount: bigint, all: Trove[]): Promise<readonly [Hex, Hex]> {
  if (!trove) return [ZERO, ZERO];
  try {
    const target = nicrAfterRepay(trove, amount);
    const near = nearestByNicr(all, target, trove.borrower)?.borrower ?? ZERO;
    const [upper, lower] = await client.readContract({
      address: addresses.sortedTroves,
      abi: sortedTrovesAbi,
      functionName: "findInsertPosition",
      args: [target, near, near],
    });
    return [upper, lower];
  } catch (e) {
    console.error(`repay hints unavailable, submitting without: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    return [ZERO, ZERO];
  }
}

