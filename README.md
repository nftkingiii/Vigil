<p align="center"><img src="brand/vigil-lockup.png" alt="Vigil" width="600"></p>

# Vigil

**Telegram alerts before your Mezo MUSD loan is liquidated or redeemed, plus a rescue you pre-sign.**

- Demo video (1:40): https://youtu.be/0sAUZjEPfE4
- App: https://vigil-mezo.up.railway.app
- Telegram: [@VigilMezoBot](https://t.me/VigilMezoBot)
- Contract (Mezo testnet, verified): [`VigilReserve` v3 0x29FB…3885](https://explorer.test.mezo.org/address/0x29FB8a330cD5c114B30F0C69b50Bb459dE023885). Earlier: [v2 0x772d…B2c4](https://explorer.test.mezo.org/address/0x772dC64C23e579CaBA63D4f824379Cad19D2B2c4) (redemption-guard proof), [v1 0x9829…cf3E](https://explorer.test.mezo.org/address/0x9829963c86bf6A8AC47b0996eAD58cf3e630cf3E) (Wave 1)
- Evidence (transactions, tests, read-backs): [`docs/evidence.md`](docs/evidence.md)

## The problem

Borrowing MUSD against BTC on Mezo has two ways to lose collateral, and most borrowers only watch one:

1. **Liquidation** below 110% collateral ratio.
2. **Redemption.** Anyone can redeem MUSD for BTC at par, and Mezo takes that BTC from the *lowest-ratio loans above 110% first*. A loan at 130% can be partly redeemed on a quiet day if it sits at the front of the queue.

Price alerts don't cover the second risk. Most of the time the fix is a small repay, and the borrower has to be awake to make it.

## What Vigil does

| | |
|---|---|
| **Liquidation price** | The BTC price where your ratio hits 110%, and how far away it is. |
| **Redemption queue** | Your place in Mezo's redemption order (`SortedTroves`, ascending nominal ICR, skipping loans under 110%) and how much MUSD gets redeemed before yours. |
| **Interest drift** | Days until simple interest alone takes you to 110% at a flat price. |
| **Stale price** | Mezo's `PriceFeed` reverts when its oracle is over 60 s old. Vigil reports "paused" and never acts on a guessed price. |
| **Recovery Mode** | Read from Mezo's `TroveManager.checkRecoveryMode` every minute. Vigil alerts when Mezo enters or leaves it and explains what changes: liquidation stays at 110%, repaying still works, but collateral withdrawals, closing and refinancing are blocked. |
| **Rescue checks** | Every minute Vigil checks each armed rescue can still succeed: reserve at least the signed amount, trigger on, and a repay that keeps net debt above Mezo's `minNetDebt` (read on-chain, since governance can change it). It tells you when one can't, and again when it's fixed. Expired, nonce-moved or closed-loan rescues are voided with the reason. |
| **Redemption guard** | A rescue can also start when less than your chosen amount of MUSD debt sits ahead of your loan in Mezo's redemption queue. `VigilReserve` walks `SortedTroves` on-chain the same way Mezo's redemption does, so the keeper can't fake it. Repaying moves the loan back in the queue. |
| **Plan a loan** | Before borrowing, `/plan 0.05 2500` in Telegram or the web page's Plan tab shows what a loan would look like on Mezo right now: ratio, liquidation price, its spot in the redemption queue among today's loans, interest drift, and a suggested trigger, guard, repay and reserve. Mezo's borrowing fee, interest rate and minimums are read from its contracts. |
| **Pre-signed rescue** | You keep a MUSD reserve in `VigilReserve` and sign Mezo's own `RepayMUSD` message once. If your ratio falls below the trigger you set, the keeper submits exactly that repay. |

## Why the rescue is safe

The rescue goes through Mezo's `BorrowerOperationsSignatures.repayMUSDWithSignature`. Mezo checks the borrower's EIP-712 signature over `(amount, borrower, nonce, deadline)` and burns the MUSD from the caller, which is the Vigil reserve contract. So:

- **Mezo, not Vigil, enforces** the amount, the loan and the deadline. A changed amount fails with `Invalid signature`.
- `VigilReserve` adds two checks: the ratio at a **fresh oracle price** must be under **your** trigger, and only **your** reserve can pay.
- Each signature works once (Mezo's nonce). Signing any other Mezo action voids it.
- `VigilReserve` has no owner, no admin and no keeper allow-list. Anyone may submit a rescue, because a rescue can only spend your reserve on your debt, below your trigger. You can withdraw the reserve at any time.
- The only other thing a rescue spends is the fixed submitter fee (0.5%, at most 25 MUSD), written into the contract as constants.

## Proof

All on Mezo testnet (chain 31611). Details and links are in [`docs/evidence.md`](docs/evidence.md).

- **17/17 fork tests** against the real MUSD contracts: allowed rescues by ratio and by redemption guard, plus rejections for a stale oracle, a tampered amount, an expired signature, a moved nonce, a replay, a short reserve, rescue switched off, a guard not reached, a guard on a loan under 110%, and someone else withdrawing your reserve.
- **Live redemption-guard rescue (2026-11-04, Wave 2):** with the ratio trigger off, the Railway keeper repaid 300 MUSD because only 25,882 MUSD of debt was ahead of the loan in Mezo's redemption queue (guard 60,000). The loan moved more than 60 troves back ([tx](https://explorer.test.mezo.org/tx/0x0f17ddb3de97630f65a72f25b59c8432e76ecdacb22bfad07bfee02a822c0c6a)). With the guard at 20,000 the same rescue was refused on-chain with `NotTriggered` ([tx](https://explorer.test.mezo.org/tx/0x4774df79fc352a33a7dddd1a97a9e3ddbf2c960e1c2d54d9d55a18852045d6e9)).
- **Live ratio rescue (2026-10-16, Wave 1):** the Railway keeper repaid 300 MUSD from the reserve. Ratio went from 130.94% to 148.77% ([tx](https://explorer.test.mezo.org/tx/0x36505f769fecbff092c85736a9f09e1c9fc006bf4454d387effe70a8ad5e8347)).
- **Live rejections:** `AboveTrigger` ([tx](https://explorer.test.mezo.org/tx/0x94b9e31e8c385f7459ec69c265a7c78dc924e0f5f60704fb8a79135f9a7417da)) and Mezo's `Invalid signature` for a tampered amount ([tx](https://explorer.test.mezo.org/tx/0x5400e79bbcf8e84252b8d37afbd2d6bd24c4c60f336ba638ccf4ac5366a77168)).

The test borrower's setup transactions were scripted (`scripts/live-demo.sh`); the rescue transaction itself came from the live keeper.

## Which address?

Watch the **0x Mezo address that owns the loan** (the trove owner). If you sign in to Mezo with a Bitcoin wallet through Mezo Passport, that is the 0x smart account the Mezo app shows, not your `bc1…` address.

Alerts work for any owner. The pre-signed rescue needs an EVM wallet (MetaMask, Rabby): Mezo checks rescue signatures with `ECDSA.recover(...) == borrower`, which a Passport smart account cannot satisfy.

## Architecture

```
Telegram ──► bot (grammy) ─┐
Web page ──► API (hono) ───┤ one Node service on Railway
                           ├─ monitor: every 60 s, reads all troves via Multicall3,
                           │           PriceFeed.fetchPrice, computes risk, sends alerts
                           └─ keeper:  for armed signatures, canRescue → simulate → rescue()
                                       │
Mezo testnet ◄─────────────────────────┘
  VigilReserve ──► BorrowerOperationsSignatures.repayMUSDWithSignature ──► MUSD burn
               └─► PriceFeed.fetchPrice, TroveManager.getCurrentICR
```

| Path | What |
|---|---|
| `contracts/` | Foundry project: `VigilReserve.sol`, fork tests, deploy script |
| `bot/src/risk.ts` | Pure risk maths (bigint, 1e18) with unit tests |
| `bot/src/snapshot.ts` | Trove and price reads |
| `bot/src/telegram.ts` | Commands and alerts |
| `bot/src/keeper.ts` | Rescue submission |
| `bot/src/web.ts`, `bot/src/web/app.html` | Health, API and the wallet page (no JS libraries, plain EIP-1193) |

## Run your own keeper

`VigilReserve` has no keeper allow-list, and each executed rescue pays its submitter a fee fixed in the contract: **0.5% of the repaid amount, at most 25 MUSD**, from the borrower's reserve. The fee is known before signing and can't be changed by anyone. Vigil runs the default keeper and earns the fee; anyone can compete:

```bash
cd bot && npm install
KEEPER_KEY_FILE=./my-keeper.key VIGIL_URL=https://vigil-mezo.up.railway.app npm run keeper
```

The key only pays gas. Armed signatures come from the public `GET /api/armed`, which is safe to publish: a signature can only repay that borrower's own debt, from their own reserve, while one of their own conditions holds, and the contract checks all of that.

## Run it

```bash
# contracts (fork tests hit https://rpc.test.mezo.org)
cd contracts && forge test

# service
cd bot && npm install && cp .env.example .env   # set TELEGRAM_BOT_TOKEN
npm test && npm start                            # http://localhost:3000
npm run inspect -- 0xBorrower                    # one-off position read
```

Mezo contracts used (testnet): MUSD `0x1189…c503`, TroveManager `0xE47c…6bb0`, BorrowerOperationsSignatures `0xD757…639e`, PriceFeed `0x86bC…9366`, from [mezo-org/musd](https://github.com/mezo-org/musd) deployments, read back on-chain.

## Status

Mezo testnet only. Built for the Mezo Buildathon (Waves 1 and 2, Track 2: Access & Distribution). Not audited.
