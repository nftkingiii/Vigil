/**
 * Run your own Vigil keeper: earn the rescue fee (0.5%, at most 25 MUSD) for submitting rescues.
 *
 *   KEEPER_KEY_FILE=./my-keeper.key VIGIL_URL=https://vigil-mezo.up.railway.app npm run keeper
 *
 * The key only pays gas: VigilReserve has no keeper allow-list and a rescue can only spend the
 * borrower's own reserve on the borrower's own debt, when the borrower's own condition holds.
 * Armed signatures come from the Vigil service's public /api/armed; the contract checks the rest.
 */
import { readFileSync } from "node:fs";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { repayHints } from "../src/hints.ts";
import { addresses, client, explorerTx, mezoTestnet, vigilAbi } from "../src/mezo.ts";
import { takeSnapshot } from "../src/snapshot.ts";

const keyFile = process.env.KEEPER_KEY_FILE;
if (!keyFile) throw new Error("set KEEPER_KEY_FILE to a file holding a funded Mezo testnet key");
const account = privateKeyToAccount(readFileSync(keyFile, "utf8").trim() as Hex);
const wallet = createWalletClient({ account, chain: mezoTestnet, transport: http(mezoTestnet.rpcUrls.default.http[0]) });
const vigilUrl = (process.env.VIGIL_URL ?? "https://vigil-mezo.up.railway.app").replace(/\/$/, "");
const intervalSec = Number(process.env.INTERVAL_SEC ?? 30);

interface Armed {
  borrower: Hex;
  amount: string;
  deadline: number;
  signature: Hex;
}

async function round() {
  const res = await fetch(`${vigilUrl}/api/armed`);
  if (!res.ok) throw new Error(`${vigilUrl}/api/armed returned HTTP ${res.status}`);
  const armed = (await res.json()) as Armed[];
  if (armed.length === 0) return;
  const snap = await takeSnapshot();
  if (!snap.price.ok) return console.log(`price unavailable (${snap.price.reason}); waiting`);
  for (const r of armed) {
    const amount = BigInt(r.amount);
    const [ok] = await client
      .readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "canRescue", args: [r.borrower, amount] })
      .catch(() => [false] as const);
    if (!ok) continue;
    const trove = snap.troves.find((t) => t.borrower.toLowerCase() === r.borrower.toLowerCase());
    try {
      const { request } = await client.simulateContract({
        account,
        address: addresses.vigilReserve,
        abi: vigilAbi,
        functionName: "rescue",
        args: [r.borrower, amount, BigInt(r.deadline), r.signature, ...(await repayHints(trove, amount, snap.troves))],
      });
      const hash = await wallet.writeContract(request);
      console.log(`rescue submitted for ${r.borrower}: ${explorerTx(hash)}`);
    } catch (e) {
      console.log(`rescue for ${r.borrower} not submitted: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
  }
}

console.log(`keeper ${account.address} watching ${vigilUrl}/api/armed every ${intervalSec}s, contract ${addresses.vigilReserve}`);
for (;;) {
  await round().catch((e) => console.error("round failed:", e instanceof Error ? e.message : e));
  await new Promise((res) => setTimeout(res, intervalSec * 1000));
}
