/**
 * Keeper for Mezo Passport accounts opted in to VigilSafeModule. Finds them from the module's
 * Configured events, rescues the ones whose condition holds, and tells their watchers when one
 * can't be rescued (module switched off, not enough MUSD in the account, no rescues left).
 */
import { decodeEventLog, type Hex } from "viem";
import { config } from "./config.ts";
import { short } from "./format.ts";
import { repayHints } from "./hints.ts";
import { addresses, client, explorerTx, moduleAbi, musdAbi } from "./mezo.ts";
import { safeAbi } from "./passport.ts";
import { musd, pct, rescueFee } from "./risk.ts";
import type { Snapshot } from "./snapshot.ts";
import { kv } from "./store.ts";
import { notifyBorrower } from "./telegram.ts";

const safes = new Set<Hex>();
let scannedTo = config.vigilSafeModuleBlock - 1n;
const CHUNK = 5_000n;

/** Opted-in accounts, from Configured logs since the module was deployed. */
export async function optedInSafes(): Promise<Hex[]> {
  const head = await client.getBlockNumber();
  while (scannedTo < head) {
    const to = scannedTo + CHUNK < head ? scannedTo + CHUNK : head;
    const logs = await client.getLogs({
      address: addresses.vigilSafeModule,
      event: moduleAbi.find((x) => x.type === "event" && x.name === "Configured") as never,
      fromBlock: scannedTo + 1n,
      toBlock: to,
    });
    for (const l of logs) safes.add((l as unknown as { args: { safe: Hex } }).args.safe);
    scannedTo = to;
  }
  return [...safes];
}

export interface PassportStatus {
  safe: Hex;
  moduleEnabled: boolean;
  amount: bigint;
  guard: bigint;
  rescuesLeft: bigint;
  done: bigint;
  triggers: readonly bigint[];
  activeTrigger: bigint;
  musdBalance: bigint;
}

export async function passportStatus(safe: Hex): Promise<PassportStatus | null> {
  const code = await client.getCode({ address: safe });
  if (!code || code === "0x") return null;
  const res = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: safe, abi: safeAbi, functionName: "isModuleEnabled", args: [addresses.vigilSafeModule] },
      { address: addresses.vigilSafeModule, abi: moduleAbi, functionName: "configOf", args: [safe] },
      { address: addresses.vigilSafeModule, abi: moduleAbi, functionName: "triggersOf", args: [safe] },
      { address: addresses.vigilSafeModule, abi: moduleAbi, functionName: "activeTrigger", args: [safe] },
      { address: addresses.musd, abi: musdAbi, functionName: "balanceOf", args: [safe] },
    ],
  });
  if (res[0].status !== "success") return null; // not a Safe
  const [amount, guard, rescuesLeft, done] = res[1].status === "success" ? (res[1].result as readonly bigint[]) : [0n, 0n, 0n, 0n];
  return {
    safe,
    moduleEnabled: res[0].result as boolean,
    amount: amount!,
    guard: guard!,
    rescuesLeft: rescuesLeft!,
    done: done!,
    triggers: res[2].status === "success" ? (res[2].result as readonly bigint[]) : [],
    activeTrigger: res[3].status === "success" ? (res[3].result as bigint) : 0n,
    musdBalance: res[4].status === "success" ? (res[4].result as bigint) : 0n,
  };
}

/** Why an opted-in account can't be rescued right now, as stable codes plus text. */
export function passportIssues(s: PassportStatus): { code: string; text: string }[] {
  if (s.rescuesLeft === 0n) return []; // off by choice, or all allowed rescues used
  const out: { code: string; text: string }[] = [];
  if (!s.moduleEnabled) out.push({ code: "module_off", text: "Vigil's module is no longer enabled on your account, so it can't repay. Opt in again on the web page." });
  const needed = s.amount + rescueFee(s.amount);
  if (s.musdBalance < needed) {
    out.push({
      code: "musd_low",
      text: `your account holds ${musd(s.musdBalance, 2)} but a rescue needs ${musd(needed, 2)} (the ${musd(s.amount)} repay plus the ${musd(rescueFee(s.amount), 2)} fee). Keep at least that much MUSD in the account.`,
    });
  }
  return out;
}

export async function runPassportKeeper(snap: Snapshot, wallet: { writeContract: Function; account: { address: Hex } }) {
  for (const safe of await optedInSafes()) {
    const s = await passportStatus(safe);
    if (!s) continue;

    const issues = passportIssues(s);
    const key = issues.map((i) => i.code).sort().join(",");
    const prev = kv.get(`passport:${safe.toLowerCase()}`) ?? "";
    if (key !== prev) {
      kv.set(`passport:${safe.toLowerCase()}`, key);
      if (issues.length) {
        await notifyBorrower(safe, `❌ <b>Your Passport rescue can't run right now</b> for <code>${short(safe)}</code>:\n${issues.map((i) => `• ${i.text}`).join("\n")}`);
      } else if (prev) {
        await notifyBorrower(safe, `✅ Your Passport rescue for <code>${short(safe)}</code> can run again.`);
      }
    }
    if (issues.length || s.rescuesLeft === 0n) continue;
    if (!config.keeperEnabled || !snap.price.ok) continue;

    const [ok] = await client
      .readContract({ address: addresses.vigilSafeModule, abi: moduleAbi, functionName: "canRescue", args: [safe] })
      .catch(() => [false] as const);
    if (!ok) continue;

    const trove = snap.troves.find((t) => t.borrower.toLowerCase() === safe.toLowerCase());
    try {
      const { request } = await client.simulateContract({
        account: wallet.account as never,
        address: addresses.vigilSafeModule,
        abi: moduleAbi,
        functionName: "rescue",
        args: [safe, ...(await repayHints(trove, s.amount, snap.troves))],
      });
      const hash = (await wallet.writeContract(request)) as Hex;
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") {
        console.error(`passport rescue for ${safe} reverted: ${hash}`);
        continue;
      }
      let detail = "";
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== addresses.vigilSafeModule.toLowerCase()) continue;
        const ev = decodeEventLog({ abi: moduleAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "SafeRescued") {
          const why = ev.args.reason === 2 ? `only ${musd(ev.args.debtAhead)} of other debt was ahead of you in the redemption queue` : `your ratio fell below your trigger`;
          detail = `\nRatio ${pct(ev.args.icrBefore, 2)} → <b>${pct(ev.args.icrAfter, 2)}</b>\nWhy: ${why}.\nRescue fee ${musd(ev.args.fee, 2)} paid to the submitter.`;
        }
      }
      console.log(`passport rescue executed ${safe} ${hash}`);
      await notifyBorrower(safe, `🛟 <b>Rescue executed</b> for your Passport account <code>${short(safe)}</code>\nRepaid ${musd(s.amount)} from the account's own MUSD.${detail}\n<a href="${explorerTx(hash)}">View transaction</a>`);
    } catch (e) {
      console.error(`passport rescue for ${safe} not submitted: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
  }
}
