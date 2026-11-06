import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { encodeFunctionData, getAddress, isAddress, isHex, toFunctionSelector, verifyTypedData } from "viem";
import { config } from "./config.ts";
import { keeperAccount, keeperStatus, wallet } from "./keeper.ts";
import {
  addressType,
  factoryAbi,
  messageFor,
  multiSendData,
  PASSPORT,
  safeAbi,
  safeSignature,
  truncatedBitcoinAddress,
} from "./passport.ts";
import { passportIssues, passportStatus } from "./passportKeeper.ts";
import { addresses, client, explorerTx, mezoTestnet, moduleAbi, repayTypedData, sigOpsAbi, vigilAbi } from "./mezo.ts";
import { latestSnapshot, monitorStatus } from "./monitor.ts";
import { rescueIssues } from "./rescueHealth.ts";
import { FEE_BPS, FEE_CAP, maxRepay, musd, parseAmount, parsePercent, pct, planLoan, position, repayToReach, rescueFee } from "./risk.ts";
import { feedback, rescues, watches } from "./store.ts";
import { notifyBorrower, telegramEnabled } from "./telegram.ts";

const MAX_DEADLINE_DAYS = 30;
/** Most rescue steps a borrower can have armed at once (consecutive Mezo nonces). */
const MAX_STEPS = 4;
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
  vigilSafeModule: addresses.vigilSafeModule,
  typedData: repayTypedData,
  selectors: {
    approve: toFunctionSelector("approve(address,uint256)"),
    deposit: toFunctionSelector("deposit(address,uint256)"),
    withdraw: toFunctionSelector("withdraw(uint256,address)"),
    setTrigger: toFunctionSelector("setTrigger(uint256)"),
    setRedemptionGuard: toFunctionSelector("setRedemptionGuard(uint256)"),
    setStepTrigger: toFunctionSelector("setStepTrigger(uint256,uint256)"),
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

  const [reserve, trigger, activeTrigger, guard, nonce, musdBalance] = await Promise.all([
    client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "reserveOf", args: [borrower] }),
    client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "triggerOf", args: [borrower] }),
    client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "activeTrigger", args: [borrower] }),
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
  const liveStep = rescues.armedFor(borrower).find((r) => r.nonce === nonce);

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
      watched: watches.forBorrower(borrower).length > 0,
      passport: await passportStatus(borrower).then((p) => (p ? { ...p, issues: passportIssues(p) } : null)).catch(() => null),
      steps: await Promise.all(
        rescues.armedFor(borrower).map(async (r) => ({
          id: r.id,
          nonce: r.nonce,
          amount: r.amount,
          deadline: r.deadline,
          live: r.nonce === nonce,
          trigger:
            (await client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "stepTriggerOf", args: [borrower, r.nonce] })) ||
            trigger,
        })),
      ),
      // Same checks the keeper runs each minute: why the armed rescue can't succeed, if it can't.
      activeTrigger,
      rescueIssues:
        liveStep && snap
          ? rescueIssues({
              amount: liveStep.amount,
              deadline: liveStep.deadline,
              now: Math.floor(Date.now() / 1000),
              reserve,
              trigger: activeTrigger,
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
  if (n < onchainNonce || n >= onchainNonce + BigInt(MAX_STEPS)) {
    return c.json({ error: `nonce is ${onchainNonce}; a signature must use it, or one of the next ${MAX_STEPS - 1} for a later step (got ${n})` }, 400);
  }

  const [reserve, baseTrigger, stepTrigger, guard] = await Promise.all([
    client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "reserveOf", args: [getAddress(borrower)] }),
    client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "triggerOf", args: [getAddress(borrower)] }),
    client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "stepTriggerOf", args: [getAddress(borrower), n] }),
    client.readContract({ address: addresses.vigilReserve, abi: vigilAbi, functionName: "guardOf", args: [getAddress(borrower)] }),
  ]);
  const trigger = stepTrigger || baseTrigger; // what applies to this step
  if (trigger === 0n && guard === 0n) return c.json({ error: "set a ratio trigger or a redemption guard first" }, 400);
  const fee = rescueFee(amt);
  // Every armed step draws on the same reserve: it must cover them all, each with its fee.
  const others = rescues.armedFor(borrower).filter((r) => r.nonce !== n && r.nonce >= onchainNonce);
  const needed = others.reduce((a, r) => a + r.amount + rescueFee(r.amount), amt + fee);
  if (reserve < needed) {
    return c.json(
      { error: `reserve must cover every armed step plus its 0.5% rescue fee (${musd(needed, 2)} in all): deposit ${musd(needed - reserve, 2)} more` },
      400,
    );
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
    `🛟 Rescue ${n > onchainNonce ? `step ${n - onchainNonce + 1n} ` : ""}armed: up to ${musd(amt)} will be repaid from your Vigil reserve ${[
      trigger ? `if your ratio drops below ${pct(trigger, 1)}` : "",
      guard ? `if less than ${musd(guard)} of other debt is ahead of you in Mezo's redemption queue` : "",
    ]
      .filter(Boolean)
      .join(", or ")}.`,
  );
  return c.json({ ok: true, id });
});

/**
 * Onboarding funnel over watched loans, read on-chain: how many have a reserve, a trigger or guard,
 * and an armed rescue. Cached for a minute; counts only.
 */
let funnelCache: { at: number; value: Record<string, number> } | null = null;
async function funnel() {
  if (funnelCache && Date.now() - funnelCache.at < 60_000) return funnelCache.value;
  const list = watches.borrowerList() as `0x${string}`[];
  const reads = list.length
    ? await client.multicall({
        allowFailure: true,
        contracts: list.flatMap((b) => [
          { address: addresses.vigilReserve, abi: vigilAbi, functionName: "reserveOf" as const, args: [b] as const },
          { address: addresses.vigilReserve, abi: vigilAbi, functionName: "activeTrigger" as const, args: [b] as const },
          { address: addresses.vigilReserve, abi: vigilAbi, functionName: "guardOf" as const, args: [b] as const },
        ]),
      })
    : [];
  const armed = new Set(rescues.armed().map((r) => r.borrower.toLowerCase()));
  let withReserve = 0;
  let withCondition = 0;
  list.forEach((_, i) => {
    const [res, trg, grd] = [reads[i * 3], reads[i * 3 + 1], reads[i * 3 + 2]];
    if (res?.status === "success" && (res.result as bigint) > 0n) withReserve++;
    if ((trg?.status === "success" && (trg.result as bigint) > 0n) || (grd?.status === "success" && (grd.result as bigint) > 0n)) withCondition++;
  });
  const value = {
    watched: list.length,
    withReserve,
    withTriggerOrGuard: withCondition,
    armed: list.filter((b) => armed.has(b.toLowerCase())).length,
  };
  funnelCache = { at: Date.now(), value };
  return value;
}

// ------------------------------------------------------------------ Mezo Passport opt-in

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const SENTINEL = "0x0000000000000000000000000000000000000001" as const;
const troveStatusAbi = [
  { type: "function", name: "getTroveStatus", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint8" }] },
] as const;

interface Prepared {
  safe: `0x${string}`;
  owner: `0x${string}`;
  to: `0x${string}`;
  data: `0x${string}`;
  operation: number;
  pubkey: string;
  type: NonNullable<ReturnType<typeof addressType>>;
  at: number;
}
/** Safe txs Vigil built and will relay once the Bitcoin wallet signs them, keyed by safeTxHash. */
const prepared = new Map<string, Prepared>();

async function passportAccount(btcAddress: string, pubkey: string) {
  const type = addressType(btcAddress);
  if (!type) throw new Error("use a native SegWit (tb1q…/bc1q…), nested SegWit (2…/3…) or legacy (m…/n…/1…) address; Taproot isn't supported by Mezo Passport");
  if (!/^(0x)?(02|03)[0-9a-fA-F]{64}$|^(0x)?04[0-9a-fA-F]{128}$/.test(pubkey)) throw new Error("public key must be 33 or 65 bytes of hex");
  const truncated = truncatedBitcoinAddress(pubkey, type);
  const [safe, owner] = await client.readContract({ address: PASSPORT.factory, abi: factoryAbi, functionName: "predictAddresses", args: [truncated] });
  const code = await client.getCode({ address: safe });
  return { type, truncated, safe, owner, deployed: !!code && code !== "0x" };
}

const errText = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0]! : String(e));

/** Which Mezo Passport account a Bitcoin wallet controls, and its Vigil status. */
app.get("/api/passport/account", async (c) => {
  try {
    const a = await passportAccount(c.req.query("btcAddress") ?? "", c.req.query("pubkey") ?? "");
    const status = a.deployed ? await passportStatus(a.safe) : null;
    const trove = a.deployed ? await client.readContract({ address: addresses.troveManager, abi: troveStatusAbi, functionName: "getTroveStatus", args: [a.safe] }) : 0;
    return c.json(json({ ...a, hasLoan: Number(trove) === 1, status: status && { ...status, issues: passportIssues(status) } }));
  } catch (e) {
    return c.json({ error: errText(e) }, 400);
  }
});

/** Build the one Safe tx a Passport user signs: opt in (enable module + configure) or opt out. */
app.post("/api/passport/prepare", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "invalid JSON" }, 400);
  try {
    const a = await passportAccount(String(body.btcAddress ?? ""), String(body.pubkey ?? ""));
    if (!a.deployed) throw new Error(`no Mezo Passport account found for this wallet (expected ${a.safe}); open your loan in the Mezo app first`);
    const owners = await client.readContract({ address: a.safe, abi: safeAbi, functionName: "getOwners" });
    if (owners.length !== 1 || owners[0]!.toLowerCase() !== a.owner.toLowerCase()) throw new Error("that account isn't owned by this wallet's Bitcoin key");
    const enabled = await client.readContract({ address: a.safe, abi: safeAbi, functionName: "isModuleEnabled", args: [addresses.vigilSafeModule] });

    const calls: { to: `0x${string}`; data: `0x${string}` }[] = [];
    let summary: string;
    if (body.action === "off") {
      calls.push({ to: addresses.vigilSafeModule, data: encodeFunctionData({ abi: moduleAbi, functionName: "configure", args: [0n, 0n, [], 0n] }) });
      if (enabled) {
        const [mods] = await client.readContract({ address: a.safe, abi: safeAbi, functionName: "getModulesPaginated", args: [SENTINEL, 20n] });
        const i = mods.findIndex((m) => m.toLowerCase() === addresses.vigilSafeModule.toLowerCase());
        const prev = i <= 0 ? SENTINEL : mods[i - 1]!;
        calls.push({ to: a.safe, data: encodeFunctionData({ abi: safeAbi, functionName: "disableModule", args: [prev, addresses.vigilSafeModule] }) });
      }
      summary = "Turn off Vigil rescues and remove Vigil's module from your account.";
    } else {
      const amount = parseAmount(String(body.amount ?? ""));
      if (!amount) throw new Error("amount must be a positive number of MUSD");
      const guard = body.guard ? parseAmount(String(body.guard)) : 0n;
      if (guard === null) throw new Error("guard must be a number of MUSD, or empty");
      const triggers = (Array.isArray(body.triggers) ? body.triggers : String(body.triggers ?? "").split(","))
        .map((t) => String(t).trim())
        .filter(Boolean)
        .map((t) => {
          const v = parsePercent(t);
          if (v === null || v <= 11n * 10n ** 17n || v > 5n * 10n ** 18n) throw new Error(`trigger ${t} must be above 110% and at most 500%`);
          return v;
        });
      if (triggers.length === 0 && !guard) throw new Error("set at least one ratio trigger or a redemption guard");
      const max = Number(body.maxRescues ?? Math.max(1, triggers.length));
      if (!Number.isInteger(max) || max < 1 || max > 10) throw new Error("allow between 1 and 10 rescues");
      const snap = latestSnapshot();
      const trove = snap?.troves.find((t) => t.borrower.toLowerCase() === a.safe.toLowerCase());
      if (snap && trove && amount > maxRepay(trove.principal + trove.interest, snap.system)) {
        throw new Error(`that repay would take the loan under Mezo's minimum debt; the most it allows now is ${musd(maxRepay(trove.principal + trove.interest, snap.system))}`);
      }
      if (!enabled) calls.push({ to: a.safe, data: encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [addresses.vigilSafeModule] }) });
      calls.push({ to: addresses.vigilSafeModule, data: encodeFunctionData({ abi: moduleAbi, functionName: "configure", args: [amount, guard, triggers, BigInt(max)] }) });
      const when = [
        triggers.length ? `when the ratio falls below ${triggers.map((t) => pct(t, 0)).join(", then ")}` : "",
        guard ? `when less than ${musd(guard)} of debt is ahead in the redemption queue` : "",
      ].filter(Boolean);
      summary = `${enabled ? "" : "Enable Vigil's module, and "}repay ${musd(amount)} from this account's MUSD (+${musd(rescueFee(amount), 2)} fee) ${when.join(" or ")}, up to ${max} time${max > 1 ? "s" : ""}.`;
    }

    const to = PASSPORT.multiSendCallOnly as `0x${string}`;
    const data = multiSendData(calls);
    const nonce = await client.readContract({ address: a.safe, abi: safeAbi, functionName: "nonce" });
    const safeTxHash = await client.readContract({ address: a.safe, abi: safeAbi, functionName: "getTransactionHash", args: [to, 0n, data, 1, 0n, 0n, 0n, ZERO, ZERO, nonce] });
    for (const [k, v] of prepared) if (Date.now() - v.at > 30 * 60_000) prepared.delete(k);
    prepared.set(safeTxHash, { safe: a.safe, owner: a.owner, to, data, operation: 1, pubkey: String(body.pubkey), type: a.type, at: Date.now() });
    return c.json({ safe: a.safe, safeTxHash, message: messageFor(safeTxHash), summary });
  } catch (e) {
    return c.json({ error: errText(e) }, 400);
  }
});

/** Relay a prepared Safe tx once the Bitcoin wallet has signed its hash. Vigil's keeper pays the gas. */
app.post("/api/passport/submit", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { safeTxHash?: string; signature?: string } | null;
  const p = body?.safeTxHash ? prepared.get(body.safeTxHash) : undefined;
  if (!p || !body?.signature) return c.json({ error: "unknown or expired request; prepare it again" }, 400);
  try {
    const signatures = safeSignature(p.owner, body.signature, p.pubkey, p.type);
    const { request } = await client.simulateContract({
      account: keeperAccount,
      address: p.safe,
      abi: safeAbi,
      functionName: "execTransaction",
      args: [p.to, 0n, p.data, p.operation, 0n, 0n, 0n, ZERO, ZERO, signatures],
    });
    const hash = await wallet.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    prepared.delete(body.safeTxHash!);
    if (receipt.status !== "success") return c.json({ error: "transaction reverted", txHash: hash }, 400);
    await notifyBorrower(p.safe, `🛟 Your Passport account <code>${p.safe.slice(0, 6)}…${p.safe.slice(-4)}</code> updated its Vigil rescue settings. <a href="${explorerTx(hash)}">Transaction</a>`);
    return c.json({ ok: true, txHash: hash, explorer: explorerTx(hash) });
  } catch (e) {
    return c.json({ error: `the account rejected it: ${errText(e)}` }, 400);
  }
});

/** Public counts: how much Vigil is watching and has done. No addresses, no chat ids. */
app.get("/api/stats", async (c) => {
  const r = rescues.stats();
  return c.json(
    json({
      watchedLoans: watches.borrowers(),
      watches: watches.count(),
      armedRescues: r.armed,
      executedRescues: r.executed,
      onboarding: await funnel().catch(() => null),
      feedbackReceived: feedback.count(),
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

