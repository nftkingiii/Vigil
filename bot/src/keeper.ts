import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BaseError, ContractFunctionRevertedError, createWalletClient, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { config } from "./config.ts";
import { short } from "./format.ts";
import { addresses, client, explorerTx, mezoTestnet, sigOpsAbi, sortedTrovesAbi, troveManagerAbi, TROVE_ACTIVE, vigilAbi } from "./mezo.ts";
import { BLOCKING, issueKey, rescueIssues } from "./rescueHealth.ts";
import { debtOf, musd, nearestByNicr, nicrAfterRepay, pct, type Trove } from "./risk.ts";
import type { Snapshot } from "./snapshot.ts";
import { rescues } from "./store.ts";
import { notifyBorrower } from "./telegram.ts";

/**
 * The keeper only pays gas. Its key is generated on first boot inside the data volume and never
 * leaves it; VigilReserve has no keeper allow-list, so the key controls nothing but its own gas.
 */
function loadKeeperKey(): Hex {
  const file = join(config.dataDir, "keeper.key");
  if (!existsSync(file)) writeFileSync(file, generatePrivateKey(), { mode: 0o600 });
  return readFileSync(file, "utf8").trim() as Hex;
}

export const keeperAccount = privateKeyToAccount(loadKeeperKey());
const wallet = createWalletClient({ account: keeperAccount, chain: mezoTestnet, transport: http(config.rpcUrl) });

/** Mezo errors that mean the signature can never succeed. */
const PERMANENT = [/Invalid signature/i, /Signature expired/i, /TroveNotActive/, /RescueOff/];

function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return revert.data?.errorName ?? revert.reason ?? revert.shortMessage;
    }
    return e.shortMessage;
  }
  return String(e);
}

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
    console.error(`repay hints unavailable, submitting without: ${revertReason(e)}`);
    return [ZERO, ZERO];
  }
}

/** TroveManager.Status: why a loan is no longer active. */
const CLOSED: Record<number, string> = {
  0: "the loan doesn't exist",
  2: "the loan was closed",
  3: "the loan was liquidated",
  4: "the loan was fully redeemed",
};

/**
 * Every snapshot: check each armed rescue can still succeed and tell the borrower when it can't,
 * then submit the ones below their trigger. Checks run even while the price is stale; submitting
 * never does.
 */
export async function runKeeper(snap: Snapshot) {
  const now = Math.floor(Date.now() / 1000);

  for (const r of rescues.armed()) {
    const borrower = r.borrower as Hex;
    if (r.deadline <= now) {
      rescues.finish(r.id, "void", "signature expired");
      await notifyBorrower(borrower, `⌛ Your pre-signed rescue for <code>${short(borrower)}</code> expired. Sign a new one with /rescue.`);
      continue;
    }

    const [nonce, reserve, trigger, guard, status] = await client.multicall({
      allowFailure: false,
      contracts: [
        { address: addresses.borrowerOperationsSignatures, abi: sigOpsAbi, functionName: "getNonce", args: [borrower] },
        { address: addresses.vigilReserve, abi: vigilAbi, functionName: "reserveOf", args: [borrower] },
        { address: addresses.vigilReserve, abi: vigilAbi, functionName: "triggerOf", args: [borrower] },
        { address: addresses.vigilReserve, abi: vigilAbi, functionName: "guardOf", args: [borrower] },
        { address: addresses.troveManager, abi: troveManagerAbi, functionName: "getTroveStatus", args: [borrower] },
      ],
    });
    if (nonce !== r.nonce) {
      rescues.finish(r.id, "void", `nonce moved (${r.nonce} → ${nonce})`);
      await notifyBorrower(borrower, `⚠️ Your pre-signed rescue is void: you signed another Mezo action since, which used up its nonce. Sign a new one with /rescue.`);
      continue;
    }
    if (Number(status) !== TROVE_ACTIVE) {
      const why = CLOSED[Number(status)] ?? `loan status ${status}`;
      rescues.finish(r.id, "void", why);
      await notifyBorrower(borrower, `⚠️ Your pre-signed rescue for <code>${short(borrower)}</code> is void: ${why}. Your reserve stays yours; withdraw it on the web page.`);
      continue;
    }

    const trove = snap.troves.find((t) => t.borrower.toLowerCase() === borrower.toLowerCase());
    const issues = rescueIssues({
      amount: r.amount,
      deadline: r.deadline,
      now,
      reserve,
      trigger,
      guard,
      debt: trove ? debtOf(trove) : null,
      limits: snap.system,
    });
    const key = issueKey(issues);
    if (key !== r.warning) {
      rescues.setWarning(r.id, key);
      const fresh = issues.filter((i) => !r.warning.split(",").includes(i.code));
      if (fresh.length > 0) {
        const blocked = issues.some((i) => i.blocking);
        await notifyBorrower(
          borrower,
          `${blocked ? "❌ <b>Your rescue can't succeed right now</b>" : "⏳ <b>Rescue reminder</b>"} for <code>${short(borrower)}</code>:\n${fresh.map((i) => `• ${i.text}`).join("\n")}`,
        );
      } else if (!issues.some((i) => i.blocking) && r.warning.split(",").some((c) => BLOCKING.has(c))) {
        await notifyBorrower(borrower, `✅ Your pre-signed rescue for <code>${short(borrower)}</code> can succeed again.`);
      }
    }
    if (issues.some((i) => i.blocking)) continue;
    if (!config.keeperEnabled || !snap.price.ok) continue; // never act on a stale price

    let ready = false;
    try {
      const [ok] = await client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "canRescue", args: [borrower, r.amount] });
      ready = ok;
    } catch {
      ready = false; // canRescue reverts when the oracle is stale
    }
    if (!ready) continue;

    try {
      const { request } = await client.simulateContract({
        account: keeperAccount,
        address: addresses.vigilReserve,
        abi: vigilAbi,
        functionName: "rescue",
        args: [borrower, r.amount, BigInt(r.deadline), r.signature, ...(await repayHints(trove, r.amount, snap.troves))],
      });
      const hash = await wallet.writeContract(request);
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") {
        rescues.finish(r.id, "failed", "transaction reverted", hash);
        continue;
      }
      rescues.finish(r.id, "executed", null, hash);
      const log = receipt.logs.find((l) => l.address.toLowerCase() === addresses.vigilReserve.toLowerCase());
      let detail = "";
      if (log) {
        const { decodeEventLog } = await import("viem");
        const ev = decodeEventLog({ abi: vigilAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "Rescued") {
          const why =
            ev.args.reason === 2
              ? `Why: only ${musd(ev.args.debtAhead)} of other debt was ahead of you in Mezo's redemption queue, under your guard. Repaying moves your loan back in the queue.`
              : `Why: your ratio fell below your trigger.`;
          detail = `\nRatio ${pct(ev.args.icrBefore, 2)} → <b>${pct(ev.args.icrAfter, 2)}</b>\n${why}`;
        }
      }
      console.log(`rescue executed ${borrower} ${hash}`);
      await notifyBorrower(
        borrower,
        `🛟 <b>Rescue executed</b> for <code>${short(borrower)}</code>\nRepaid ${musd(r.amount)} from your Vigil reserve.${detail}\n<a href="${explorerTx(hash)}">View transaction</a>`,
      );
    } catch (e) {
      const reason = revertReason(e);
      if (PERMANENT.some((re) => re.test(reason))) {
        rescues.finish(r.id, "void", reason);
        await notifyBorrower(borrower, `❌ Your pre-signed rescue was rejected: ${reason}. Sign a new one with /rescue.`);
      } else {
        console.error(`rescue ${r.id} not submitted: ${reason}`);
      }
    }
  }
}

export async function keeperStatus() {
  const balance = await client.getBalance({ address: keeperAccount.address }).catch(() => null);
  return { address: keeperAccount.address, balanceWei: balance?.toString() ?? null, enabled: config.keeperEnabled };
}
