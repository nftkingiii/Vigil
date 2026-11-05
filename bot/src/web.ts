import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getAddress, isAddress, isHex, toFunctionSelector, verifyTypedData } from "viem";
import { config } from "./config.ts";
import { keeperStatus } from "./keeper.ts";
import { addresses, client, mezoTestnet, repayTypedData, sigOpsAbi, vigilAbi } from "./mezo.ts";
import { latestSnapshot, monitorStatus } from "./monitor.ts";
import { rescueIssues } from "./rescueHealth.ts";
import { FEE_BPS, FEE_CAP, maxRepay, musd, pct, parseAmount, planLoan, position, repayToReach, rescueFee } from "./risk.ts";
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
    setRedemptionGuard: toFunctionSelector("setRedemptionGuard(uint256)"),
  },
  bot: "VigilMezoBot",
  fee: { bps: Number(FEE_BPS), cap: FEE_CAP.toString() },
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
      uptimeSec: Math.round((Date.now() - new Date(startedAt).getTime()) / 1000),
      chainId: mezoTestnet.id,
      vigilReserve: addresses.vigilReserve,
      monitor,
      keeper: await keeperStatus(),
      telegram: telegramEnabled,
      watches: watches.count(),
      armedRescues: rescues.armed().length,
      lastRescue: (() => {
        const r = rescues.history(1)[0];
        return r ? { id: r.id, status: r.status, txHash: r.txHash, detail: r.detail, createdAt: r.createdAt } : null;
      })(),
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

  const [reserve, trigger, guard, nonce, musdBalance] = await Promise.all([
    client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "reserveOf", args: [borrower] }),
    client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "triggerOf", args: [borrower] }),
    client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "guardOf", args: [borrower] }),
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
      guard,
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
              guard,
              debt: pos?.debt ?? null,
              limits: snap.system,
            })
          : [],
    }),
  );
});

/** A new loan, planned against today's troves and Mezo's live settings. Nothing is sent. */
app.get("/api/plan", (c) => {
  const coll = parseAmount(c.req.query("btc"));
  const borrow = parseAmount(c.req.query("musd"));
  if (!coll || !borrow) return c.json({ error: "btc and musd must be positive numbers, e.g. ?btc=0.05&musd=2500" }, 400);
  const snap = latestSnapshot();
  if (!snap) return c.json({ error: "Vigil is still taking its first snapshot of Mezo" }, 503);
  if (!snap.price.ok) return c.json({ error: `Mezo's price feed is unavailable (${snap.price.reason}); Vigil won't plan on a guessed price` }, 503);
  const plan = planLoan(snap.troves, { coll, borrow, price: snap.price.price, system: snap.system });
  return c.json(json({ ...plan, borrow, coll, price: snap.price.price, system: snap.system }));
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

  const [reserve, trigger, guard] = await Promise.all([
    client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "reserveOf", args: [getAddress(borrower)] }),
    client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "triggerOf", args: [getAddress(borrower)] }),
    client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "guardOf", args: [getAddress(borrower)] }),
  ]);
  if (trigger === 0n && guard === 0n) return c.json({ error: "set a ratio trigger or a redemption guard first" }, 400);
  const fee = rescueFee(amt);
  if (reserve < amt + fee) {
    return c.json({ error: `reserve must cover the repay plus the ${musd(fee, 2)} rescue fee: deposit ${musd(amt + fee - reserve, 2)} more` }, 400);
  }

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
    `🛟 Rescue armed: up to ${musd(amt)} will be repaid from your Vigil reserve ${[
      trigger ? `if your ratio drops below ${pct(trigger, 1)}` : "",
      guard ? `if less than ${musd(guard)} of other debt is ahead of you in Mezo's redemption queue` : "",
    ]
      .filter(Boolean)
      .join(", or ")}.`,
  );
  return c.json({ ok: true, id });
});

/** Public counts: how much Vigil is watching and has done. No addresses, no chat ids. */
app.get("/api/stats", (c) => {
  const r = rescues.stats();
  return c.json(
    json({
      watchedLoans: watches.borrowers(),
      watches: watches.count(),
      armedRescues: r.armed,
      executedRescues: r.executed,
      musdRepaid: r.repaid,
      vigilReserve: addresses.vigilReserve,
      feeBps: Number(FEE_BPS),
      feeCap: FEE_CAP,
    }),
  );
});

/**
 * Armed rescues with their signatures, for anyone who wants to run a keeper (scripts/keeper.ts).
 * Publishing them is safe: a signature can only repay that borrower's own debt, from their own
 * reserve, while one of their own conditions holds; the submitter earns the fixed rescue fee.
 */
app.get("/api/armed", (c) =>
  c.json(json(rescues.armed().map((r) => ({ borrower: r.borrower, amount: r.amount, deadline: r.deadline, signature: r.signature })))),
);

/** Public rescue log (signatures omitted). */
app.get("/api/rescues", (c) => c.json(json(rescues.history(50).map((r) => ({ ...r, signature: undefined })))));

export function startWeb() {
  serve({ fetch: app.fetch, port: config.port }, (info) => console.log(`web: listening on :${info.port}`));
}

