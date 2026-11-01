import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getAddress, isAddress, isHex, toFunctionSelector, verifyTypedData } from "viem";
import { config } from "./config.ts";
import { keeperStatus } from "./keeper.ts";
import { addresses, client, mezoTestnet, repayTypedData, sigOpsAbi, vigilAbi } from "./mezo.ts";
import { latestSnapshot, monitorStatus } from "./monitor.ts";
import { rescueIssues } from "./rescueHealth.ts";
import { maxRepay, musd, position, repayToReach } from "./risk.ts";
import { rescues, watches } from "./store.ts";
import { notifyBorrower, telegramEnabled } from "./telegram.ts";

const MAX_DEADLINE_DAYS = 30;
const startedAt = new Date().toISOString();

const page = readFileSync(new URL("./web/app.html", import.meta.url), "utf8");

/** Everything the page needs to build transactions without a JS library. */
const pageConfig = {
  chainId: mezoTestnet.id,
  chainName: mezoTestnet.name,
  rpcUrl: "https://rpc.test.mezo.org",
  explorer: "https://explorer.test.mezo.org",
  musd: addresses.musd,
  vigilReserve: addresses.vigilReserve,
  typedData: repayTypedData,
  selectors: {
    approve: toFunctionSelector("approve(address,uint256)"),
    deposit: toFunctionSelector("deposit(address,uint256)"),
    withdraw: toFunctionSelector("withdraw(uint256,address)"),
    setTrigger: toFunctionSelector("setTrigger(uint256)"),
  },
  bot: "VigilMezoBot",
};

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

export const app = new Hono();

app.get("/", (c) => c.html(page.replace("__VIGIL_CONFIG__", JSON.stringify(pageConfig))));

app.get("/health", async (c) => {
  const monitor = monitorStatus();
  const healthy = monitor.lastSnapshotAt !== null && monitor.lastError === null;
  return c.json(
    {
      ok: healthy,
      service: "vigil",
      revision: config.revision,
      startedAt,
      chainId: mezoTestnet.id,
      vigilReserve: addresses.vigilReserve,
      monitor,
      keeper: await keeperStatus(),
      telegram: telegramEnabled,
      watches: watches.count(),
      armedRescues: rescues.armed().length,
    },
    healthy ? 200 : 503,
  );
});

/** Live position plus the borrower's Vigil reserve, trigger and signing nonce. */
app.get("/api/position/:address", async (c) => {
  const addr = c.req.param("address");
  if (!isAddress(addr)) return c.json({ error: "invalid address" }, 400);
  const borrower = getAddress(addr);
  const snap = latestSnapshot();

  const [reserve, trigger, nonce, musdBalance] = await Promise.all([
    client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "reserveOf", args: [borrower] }),
    client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "triggerOf", args: [borrower] }),
    client.readContract({ address: addresses.borrowerOperationsSignatures, abi: sigOpsAbi, functionName: "getNonce", args: [borrower] }),
    client.readContract({
      address: addresses.musd,
      abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
      functionName: "balanceOf",
      args: [borrower],
    }),
  ]);

  const price = snap?.price.ok ? snap.price.price : null;
  const pos = price && snap ? position(snap.troves, borrower, price) : null;
  const latest = rescues.latest(borrower);

  return c.json(
    json({
      borrower,
      snapshotAt: snap?.at ?? null,
      price: snap ? (snap.price.ok ? { ok: true, value: snap.price.price } : snap.price) : null,
      position: pos,
      maxRepay: pos && snap ? maxRepay(pos.debt, snap.system) : null,
      system: snap?.system ?? null,
      repayTo150: pos && price ? repayToReach(pos.coll, pos.debt, price, 15n * 10n ** 17n) : null,
      reserve,
      trigger,
      nonce,
      musdBalance,
      latestRescue: latest && { ...latest, signature: undefined },
      // Same checks the keeper runs each minute: why the armed rescue can't succeed, if it can't.
      rescueIssues:
        latest?.status === "armed" && snap
          ? rescueIssues({
              amount: latest.amount,
              deadline: latest.deadline,
              now: Math.floor(Date.now() / 1000),
              reserve,
              trigger,
              debt: pos?.debt ?? null,
              limits: snap.system,
            })
          : [],
    }),
  );
});

/** Store a borrower-signed RepayMUSD so the keeper can submit it below the trigger. */
app.post("/api/rescue", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid JSON" }, 400);
  const { borrower, amount, nonce, deadline, signature } = body as Record<string, string>;

  if (!borrower || !isAddress(borrower)) return c.json({ error: "invalid borrower" }, 400);
  if (!signature || !isHex(signature)) return c.json({ error: "invalid signature" }, 400);
  let amt: bigint, n: bigint, dl: bigint;
  try {
    amt = BigInt(amount!);
    n = BigInt(nonce!);
    dl = BigInt(deadline!);
  } catch {
    return c.json({ error: "amount, nonce and deadline must be integers" }, 400);
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (amt <= 0n) return c.json({ error: "amount must be positive" }, 400);
  if (dl <= now + 600n || dl > now + BigInt(MAX_DEADLINE_DAYS * 86_400)) {
    return c.json({ error: `deadline must be between 10 minutes and ${MAX_DEADLINE_DAYS} days away` }, 400);
  }

  const valid = await verifyTypedData({
    ...repayTypedData,
    address: getAddress(borrower),
    message: { amount: amt, borrower: getAddress(borrower), nonce: n, deadline: dl },
    signature,
  });
  if (!valid) return c.json({ error: "signature does not match the borrower" }, 400);

  const onchainNonce = await client.readContract({
    address: addresses.borrowerOperationsSignatures,
    abi: sigOpsAbi,
    functionName: "getNonce",
    args: [getAddress(borrower)],
  });
  if (onchainNonce !== n) return c.json({ error: `nonce is ${onchainNonce}, signature used ${n}` }, 400);

  const [reserve, trigger] = await Promise.all([
    client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "reserveOf", args: [getAddress(borrower)] }),
    client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "triggerOf", args: [getAddress(borrower)] }),
  ]);
  if (trigger === 0n) return c.json({ error: "set a trigger first" }, 400);
  if (reserve < amt) return c.json({ error: "reserve is smaller than the signed amount" }, 400);

  const snap = latestSnapshot();
  const pos = snap?.price.ok ? position(snap.troves, borrower, snap.price.price) : null;
  if (snap && pos && amt > maxRepay(pos.debt, snap.system)) {
    return c.json(
      { error: `amount would take the loan below Mezo's ${musd(snap.system.minNetDebt)} minimum net debt; the most Mezo allows now is ${musd(maxRepay(pos.debt, snap.system))}` },
      400,
    );
  }

  const id = rescues.arm({ borrower, amount: amt, nonce: n, deadline: Number(dl), signature });
  await notifyBorrower(
    borrower,
    `🛟 Rescue armed: up to ${Number(amt / 10n ** 18n).toLocaleString("en-US")} MUSD will be repaid from your Vigil reserve if your ratio drops below ${(Number((trigger * 1000n) / 10n ** 18n) / 10).toFixed(1)}%.`,
  );
  return c.json({ ok: true, id });
});

/** Public rescue log (signatures omitted). */
app.get("/api/rescues", (c) => c.json(json(rescues.history(50).map((r) => ({ ...r, signature: undefined })))));

export function startWeb() {
  serve({ fetch: app.fetch, port: config.port }, (info) => console.log(`web: listening on :${info.port}`));
}

