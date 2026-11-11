# Evidence

All on Mezo testnet (chain ID 31611). Explorer: https://explorer.test.mezo.org

## Wave 2 (from 2026-11-02)

Wave 1 feedback asked for a new job for MUSD (a redemption-triggered rescue), Mezo parameters read on-chain instead of hardcoded, and a warning when an armed rescue can no longer succeed. All three are built and live.

### VigilReserve v2: redemption-guard rescue

| Item | Value |
|---|---|
| Address | [`0x772dC64C23e579CaBA63D4f824379Cad19D2B2c4`](https://explorer.test.mezo.org/address/0x772dC64C23e579CaBA63D4f824379Cad19D2B2c4) |
| Deploy tx | [`0xafc4e654…82dc`](https://explorer.test.mezo.org/tx/0xafc4e654f82a64af611df9fea23c9bd340126ef60f372d30ed286bd5850682dc), block 16,572,786, 2026-11-04 18:03 UTC, status success |
| Source | Verified on the explorer (Blockscout), same compiler settings as v1 |
| Read back | `VERSION()` 2, `sortedTroves()` `0x722E4D24…68fA` (= `TroveManager.sortedTroves()`), `MAX_QUEUE_STEPS()` 60, MUSD and BorrowerOperationsSignatures as v1 |
| What's new | `setRedemptionGuard(minDebtAhead)`: a rescue may also run when less than that much MUSD of other debt sits ahead of the loan in Mezo's redemption queue. The contract walks `SortedTroves` on-chain the way `TroveManager.redeemCollateral` does (`getLast`, `getPrev`, skipping troves under 110%), stops once the guard is reached or after 60 troves. `Rescued` now logs the reason (1 ratio, 2 redemption) and the debt ahead. |
| Fork tests | 17/17 pass (2026-11-04), 5 new: rescue near the front of the real queue, `Rescued` reason, guard not reached, no guard rescue under 110%, ratio trigger still fires with a guard set |
| Gas | Full 60-trove walk: 1,808,087 gas (`eth_estimateGas` of `debtAhead` on testnet). Block gas limit 10,000,000 |

v1 (`0x9829…cf3E`, below) stays deployed for its Wave 1 history.

### Declared Wave 2 goals: Passport accounts and stepped rescues (from 2026-11-05)

| Contract | Address | Deploy tx |
|---|---|---|
| `VigilReserve` v4 (EVM wallets, stepped rescues) | [`0xF968043b58Bf9993FE3ADC1157C7D186242DE0EB`](https://explorer.test.mezo.org/address/0xF968043b58Bf9993FE3ADC1157C7D186242DE0EB) | [`0xa7c9e7fb…a148`](https://explorer.test.mezo.org/tx/0xa7c9e7fbc14c60336238e993b87ffa8807aff14c82fe53e6b770e519dd83a148), block 16,594,948 |
| `VigilSafeModule` (Mezo Passport accounts) | [`0x1F5a0031Bfd7db38249eC8a4dcbc0FDA0e96c7B3`](https://explorer.test.mezo.org/address/0x1F5a0031Bfd7db38249eC8a4dcbc0FDA0e96c7B3) | [`0xa46d4700…fbb8`](https://explorer.test.mezo.org/tx/0xa46d4700d7af6d5e8ceabf975c61a71f38cb6d010ac9607d29c308ee65a3fbb8), block 16,594,948 |

Both verified on the explorer. Read back: v4 `VERSION()` 4, `FEE_BPS()` 50; module `VERSION()` 1, `borrowerOperations()` `0xCdF7…beE5`; both `sortedTroves()` `0x722E…68fA`. Shared rules (trigger, guard, fee) live in `RescueRules.sol`.

**What a Mezo Passport account is** (read from Mezo's verified contracts and the `@mezo-org/orangekit-smart-account` package): a Safe v1.4.1 proxy (singleton `0x4167…461a`) created by OrangeKitSafeFactory `0x7E80…1052`, owned by one BitcoinSafeOwner proxy (singleton `0x8873…a4d5`) that checks BIP-137 Bitcoin message signatures. MUSD's `BorrowerOperationsSignatures` verifies with `ECDSA.recover` only, which is why Passport accounts couldn't use the Wave 1 rescue.

**Fork tests, 34/34 (2026-11-05)**:

| Suite | Tests | What it shows |
|---|---|---|
| `VigilReserve.t.sol` | 21 | Wave 1 and 2 rules, plus stepped rescues: step 2 (nonce 1) can't run before step 1, step 1's trigger stops applying once it ran, step 2 runs under its own 125% trigger, the reserve pays both steps and both fees |
| `VigilSafeModule.t.sol` | 11 | On the real Passport account [`0xf13A…edf1`](https://explorer.test.mezo.org/address/0xf13Aa8136D1f6Fbb0f1adf4bC4bd4f70Ec21edf1) (Safe 1.4.1, OrangeKit 4337 module, one BitcoinSafeOwner, active loan): rescue as the Safe from its own MUSD, fee to the submitter, stepped triggers, redemption guard; refusals for module off, above trigger, no rescues left, MUSD too low, stale oracle, low trigger; settings only for the caller. The account's owner is stood in for by acting as the Safe |
| `PassportOptIn.t.sol` | 2 | No stand-ins: a Bitcoin key gets an account from Mezo's factory, opens a loan with a BIP-137 signed Safe tx, opts in with **one** signed MultiSendCallOnly batch (enable module + configure) verified by Mezo's BitcoinSafeOwner, and is rescued (300 MUSD, 1.50 fee). A wrong Bitcoin key is refused |

**Service end to end on a local fork of Mezo testnet (anvil, 2026-11-06; not live testnet):**
- The service's signature code (`bot/src/passport.ts`) enabled the module through the real BitcoinSafeOwner for all three address types it supports: native SegWit, legacy, nested SegWit.
- A fresh Passport account opened a loan with a Bitcoin-signed Safe tx.
- It then went through the web page's API: `GET /api/passport/account`, `POST /api/passport/prepare` (amount 300, trigger 140%, 1 rescue), a wallet-style `signMessage` signature, and `POST /api/passport/submit`. The keeper relayed it and the module was enabled with the settings saved.
- With the fork's price lowered to $70,000 (ratio 129.5%), the running service's keeper rescued the account on its own. Ratio 129.5% → 145.7%; the account's MUSD went 2,500 → 2,198.5 (300 repay + 1.50 fee).

### Live stepped rescue on VigilReserve v4: 2026-11-06

Same burner borrower ([`0x16f2981D…CB4f`](https://explorer.test.mezo.org/address/0x16f2981DF2027e66857e3a857d6d3B2F858eCB4f)), ratio 134.0% at the start, base trigger off.

**Scripted setup** (`scripts/live-demo.sh`, not a user flow):

| Step | Tx | Result |
|---|---|---|
| Withdraw 100 MUSD from the v2 reserve | [`0x3dafa54e…8b62`](https://explorer.test.mezo.org/tx/0x3dafa54e3665adbcfd189114366599cd705fac9a3d75384ddd44e52e01578b62) | ok |
| Approve and deposit 210 MUSD into v4 | [`0x2e06a9ab…2238`](https://explorer.test.mezo.org/tx/0x2e06a9ab2164a31d359a2643ec190fcb643ade8a375125b9c5d7394092aa2238), [`0x643bf165…e1c4`](https://explorer.test.mezo.org/tx/0x643bf1656f86feb4b8c9faab76f4a59cc7db4e96eb5c1dc5e69ea657667fe1c4) | ok. Covers two 100 MUSD steps and two 0.50 fees |
| Step triggers: nonce 2 at 140%, nonce 3 at 125% | [`0x05d9c336…ed15`](https://explorer.test.mezo.org/tx/0x05d9c3368cc695365fa2cecb9e182bee377198b8b06fb8aec1bd0edc4865ed15), [`0x90f81924…2c43`](https://explorer.test.mezo.org/tx/0x90f8192480b0b09849c3702b7b306b3a35f915d88ebd89e4589799a11fa92c43) | ok |
| Sign RepayMUSD(100) for nonce 3 and nonce 2; POST both to the live `/api/rescue` | off-chain | `{"ok":true,"id":3}`, `{"ok":true,"id":4}`. Two steps armed at once |

**Step 1, submitted by the live keeper:** [`0x9177bc71…a806`](https://explorer.test.mezo.org/tx/0x9177bc71a154504b508bfcd1fc180bfcb16a89c52709f4c36262ed9fc2f0a806), block 16,602,816, 04:30:45 UTC. 100 MUSD, ICR **134.08% → 140.31%**, reason 1 (ratio), fee 0.50 MUSD. Mezo nonce 2 → 3, and `activeTrigger` became step 2's 125%.

**Step 2 refused while above its own trigger** (scripted attempt): [`0x08f10807…3580`](https://explorer.test.mezo.org/tx/0x08f10807ca405782e9c1253d9892d0c26c2ef84d48bb48ac4877bdfbe80c3580) reverted with `AboveTrigger(icr 1.4025, trigger 1.25)`, replayed at the block before. Step 1's 140% no longer applies.

**Step 2, submitted by the live keeper** after its trigger was raised to 150% ([`0xb4e2d016…5e8f`](https://explorer.test.mezo.org/tx/0xb4e2d016c5d215254fc8b4661b5a1956b4af0a80f82a02ae733ee55280855e8f), scripted): [`0x629b058b…e5b3`](https://explorer.test.mezo.org/tx/0x629b058b4ce2f35600766c95256080e3f2fa594beaefd03bec123b5b719ae5b3), block 16,602,844, 04:32:41 UTC. 100 MUSD, ICR **140.42% → 147.25%**, fee 0.50. Mezo nonce 3 → 4, reserve 210 → 9 MUSD.

**Gas with the keeper's repay hints, live:** 455,853 and 438,753 gas for the two rescues. Before hints, the Oct 16 and Nov 4 rescues used 3,677,444 and 6,205,031.

### Live Passport rescue: 2026-11-11

A Bitcoin key with no Ethereum key got a Mezo Passport account, opened a loan from it, opted in through the live service, and was rescued by the live keeper, all on Mezo testnet. The account is [`0xd36b77…4561`](https://explorer.test.mezo.org/address/0xd36b77Cb3615217b20Bd18Cc42e56317c8064561), a Safe from Mezo's OrangeKitSafeFactory owned by a BitcoinSafeOwner. Its Bitcoin key is a throwaway demo key (native SegWit, never an address that holds coins).

**What was scripted and what was live:**
- **Scripted (our burner, our script):** the setup below, including the Bitcoin signatures. They were produced by a script that imitates a Bitcoin wallet's `signMessage(text, "ecdsa")`, not by a real Unisat or OKX wallet. The burner paid gas and relayed.
- **Live service:** the opt-in went through the deployed Railway service's own `/api/passport/account`, `/prepare` and `/submit` endpoints, the same calls the web page makes. The service's keeper relayed it.
- **Live keeper:** the rescue was submitted by the Railway keeper `0xBE8c12D0…3934`, not by our script.

**Scripted setup:**

| Step | Tx | Result |
|---|---|---|
| `deploySafe` on the factory (burner) | [`0xf30fac5e…28ec`](https://explorer.test.mezo.org/tx/0xf30fac5efb2b912eb66fcaea5fe03d3dabc0615b98536c2fc8e32f49d03c28ec) | ok, Passport account created |
| Send 0.042 testnet BTC to the account | [`0x0682e635…0262`](https://explorer.test.mezo.org/tx/0x0682e635885cc232b8d52312507ecbec5fd4bf0140af9aa221b25522641e0262) | ok |
| `openTrove` through a Bitcoin-signed Safe tx (collateral 0.04 BTC, debt 2,075 MUSD) | [`0x58a47a47…015b`](https://explorer.test.mezo.org/tx/0x58a47a4766b82e36113a4bafa1040e0941721cf508f822975f37327012f2015b) | ok, trove status 1. Debt 2,277.08 MUSD with fee and gas compensation, ratio 129.9% at $73,924 |

**Opt-in through the live service** (script signs `message` with the simulated wallet, service relays): [`0x9a0037f0…bda9`](https://explorer.test.mezo.org/tx/0x9a0037f020f769074f85963bd288f43d5c6953eb36bcdb9dc11f5e9b2272bda9), block 16,712,463. One MultiSend batch: enable the module, then configure 100 MUSD, one rescue, trigger 134%. `isModuleEnabled` true, `configOf` = (100 MUSD, guard 0, 1 rescue left).

**Rescue, submitted by the live keeper:** [`0xde2b57e1…4279`](https://explorer.test.mezo.org/tx/0xde2b57e191e4e50f8b0299e5e6823d4d5bde0cfb7ca3517f7dd14be0f5574279), block 16,712,466, 2026-11-11 11:11:55 UTC, within about a minute of the opt-in. `SafeRescued`: amount 100 MUSD, price $73,941.78, ICR **129.89% → 135.86%**, reason 1 (ratio), debt ahead 0, fee 0.50 MUSD. Gas 445,637.

**Read-backs after the rescue:**

| Item | Value |
|---|---|
| `configOf` | rescues left 0, done true |
| Account MUSD balance | 2,075 → 1,974.50 (100 repay + 0.50 fee) |
| Trove debt | 2,277.08 → 2,177.08 MUSD |
| Collateral | 0.04 BTC |

**Not yet done:**
- a real Unisat or OKX wallet signing through the page (the wallet calls are written to their documented `signMessage(message, "ecdsa")` API, but no real wallet has been tried yet).

### VigilReserve v3: fixed rescue fee

| Item | Value |
|---|---|
| Address | [`0x29FB8a330cD5c114B30F0C69b50Bb459dE023885`](https://explorer.test.mezo.org/address/0x29FB8a330cD5c114B30F0C69b50Bb459dE023885) |
| Deploy tx | [`0x93161107…8d92`](https://explorer.test.mezo.org/tx/0x9316110761e903497d61008a50fd9e91d8fb0a4f98d08ce6f456a7d802988d92), block 16,573,144, status success |
| Source | Verified on the explorer (Blockscout) |
| Read back | `VERSION()` 3, `FEE_BPS()` 50, `FEE_CAP()` 25e18, `feeFor(300e18)` 1.5e18 |
| What's new | Each executed rescue pays its submitter 0.5% of the amount, at most 25 MUSD, from the same reserve. The reserve must cover amount + fee. Constants, no owner. `Rescued` logs the fee. Everything else as v2 |
| Fork tests | 19/19 pass (2026-11-04): the 17 above plus the fee schedule and "reserve must cover amount plus fee"; the allowed-rescue tests now also check the submitter received the fee |

The service used v3 until v4 replaced it on 2026-11-06. The redemption-guard proof below ran on v2, which has the same guard logic without the fee.

### Live redemption-guard rescue: 2026-11-04

Same burner borrower as Wave 1, [`0x16f2981D…CB4f`](https://explorer.test.mezo.org/address/0x16f2981DF2027e66857e3a857d6d3B2F858eCB4f). Ratio trigger **off**, so only the redemption guard can start the rescue.

**Scripted setup** (`scripts/live-demo.sh`, not a user flow):

| Step | Tx | Result |
|---|---|---|
| Borrow 350 more MUSD | [`0xb2757644…2b1f`](https://explorer.test.mezo.org/tx/0xb2757644fd473ad967a0350699df6a323cd568593bb7144c39661a32b8272b1f) | ok. Ratio ~146% → 126.2%; the loan moves near the front of the redemption queue |
| Withdraw 100 MUSD left in the v1 reserve | [`0xd345b9e0…ce7d`](https://explorer.test.mezo.org/tx/0xd345b9e0a3bb822b66e37ec1a5c5fd0edd0a78965581f0dcd66b35694c10ce7d) | ok |
| Approve 400 MUSD for v2 | [`0xb3f278cb…6efb`](https://explorer.test.mezo.org/tx/0xb3f278cb6f75a675244d0eface9d501cf3f7aac4914dc89e58389cd085b76efb) | ok |
| Deposit 400 MUSD reserve | [`0xe523e8ba…b667`](https://explorer.test.mezo.org/tx/0xe523e8ba3d71476c6056bf6639ac37cb4282cad19dde83c0943385ac9957b667) | ok |
| Redemption guard 20,000 MUSD | [`0x5ae5f073…b000`](https://explorer.test.mezo.org/tx/0x5ae5f073efb1dcd3aad3583597397bef7d3d802c4d653bfc4fea998920edb000) | ok. `debtAhead` on-chain: found, 25,882 MUSD ahead, so the guard is not hit |
| Sign RepayMUSD(300 MUSD, nonce 1, 7 days); POST to the live `/api/rescue` | off-chain | `{"ok":true,"id":2}` |
| Rescue while 25,882 MUSD is ahead (guard 20,000) | [`0x4774df79…d6e9`](https://explorer.test.mezo.org/tx/0x4774df79fc352a33a7dddd1a97a9e3ddbf2c960e1c2d54d9d55a18852045d6e9) | reverted, as expected: `NotTriggered(icr 1.2617, trigger 0, found false, debtAhead 21,444, guard 20,000)`. The walk stopped as soon as the debt ahead passed the guard |
| Raise the guard to 60,000 MUSD | [`0x29950e45…5aa1`](https://explorer.test.mezo.org/tx/0x29950e4568a269f840b44a70845b41160e0727a492df7f0b5358dd31c9af5aa1) | ok |

**Rescue, submitted by the live keeper on Railway, not by the script:**

| Tx | From | Event `Rescued` |
|---|---|---|
| [`0x0f17ddb3…0c6a`](https://explorer.test.mezo.org/tx/0x0f17ddb3de97630f65a72f25b59c8432e76ecdacb22bfad07bfee02a822c0c6a), block 16,572,945, 2026-11-04 18:14:52 UTC | keeper `0xbe8c12d0…3934` | amount **300 MUSD**, price $80,591.75, ICR 126.23% → 143.03%, **reason 2 (redemption)**, **debt ahead 25,882 MUSD** |

Read back after the rescue:

| What | Value |
|---|---|
| Vigil v2 reserve | 400 → 100 MUSD |
| Mezo `getNonce(borrower)` | 1 → 2 |
| Debt ahead in the redemption queue | 25,882 MUSD → more than 166,928 MUSD (more than 60 troves back; `debtAhead` returns found = false) |
| Service log | `/api/rescues` shows #2 `executed` with the same tx hash |

**Gas, and the fix it led to.** This rescue used 6,205,031 gas. The keeper had passed no position hints, so Mezo's `SortedTroves.reInsert` searched the list from the top. The keeper now computes the trove's nominal ICR after the repay (Mezo applies a repay to interest first, then principal) and asks `SortedTroves.findInsertPosition` for the exact neighbours. Measured on testnet with `eth_estimateGas` for a 50 MUSD repay from the same borrower (360 troves): **5,883,246 gas without hints, 379,807 with**.

### Mezo parameters on-chain, and dead-rescue warnings

Shipped 2026-11-01 (`3f07b37`), the day the Wave 1 feedback arrived:

- Every minute the service reads `BorrowerOperations.minNetDebt()` (1,800 MUSD), `MUSD_GAS_COMPENSATION()` (200), `TroveManager.MCR()` (110%), `CCR()` (150%), `getTCR(price)` and `checkRecoveryMode(price)`. `/health` shows them under `monitor.system`.
- Recovery Mode: alerts on entry and exit, with what changes (from the MUSD source: liquidation stays below 110%, repaying and adding collateral still work, collateral withdrawals, closing and refinancing are blocked). Off on testnet so far (system ratio ~279%), so the live alert has not fired.
- Each armed rescue is checked every minute: reserve at least the signed amount, a trigger or guard on, and a repay that keeps net debt above `minNetDebt`. The borrower is told once per change, and again when it's fixed; a reminder comes 24 h before the signature expires. Closed, liquidated or fully redeemed loans void the rescue with the reason. Verified against testnet with a test rescue and Telegram off; the Telegram messages themselves have not been seen live yet.

## VigilReserve (v1, Wave 1)

| Item | Value |
|---|---|
| Address | [`0x9829963c86bf6A8AC47b0996eAD58cf3e630cf3E`](https://explorer.test.mezo.org/address/0x9829963c86bf6A8AC47b0996eAD58cf3e630cf3E) |
| Deploy tx | [`0x3f8d39cc…2a75`](https://explorer.test.mezo.org/tx/0x3f8d39cc97eb9d3a59a01f610da70384e0aaed247e3ecab003a3332a6e0d2a75), block 16,174,041, status success |
| Source | Verified on the explorer (Blockscout). Solidity 0.8.24, optimizer 200 runs, via-IR, EVM paris |
| Deployed | 2026-10-15 |

Read back with `cast call` after the deploy:

| Getter | Returns | Mezo contract |
|---|---|---|
| `musd()` | `0x118917a4…c503` | MUSD |
| `priceFeed()` | `0x86bCF084…9366` | PriceFeed |
| `troveManager()` | `0xE47c80e8…6bb0` | TroveManager |
| `borrowerOpsSig()` | `0xD757e364…639e` | BorrowerOperationsSignatures |
| `MIN_TRIGGER_ICR()` | `1.1e18` | the 110% liquidation line |

## Fork tests

`forge test` in `contracts/` runs on a fork of Mezo testnet, so every repay goes through the real MUSD contracts. Only the oracle at `0x7b7c…0015` is replaced, because it doesn't work on a local fork.

12/12 passed (2026-10-15):

| Case | Expected | Result |
|---|---|---|
| Rescue below trigger | Debt drops by the signed amount; MUSD burned from the reserve; ICR improves; nonce consumed | pass |
| Above trigger | `AboveTrigger` | pass |
| Stale oracle (61 s) | `PriceFeed: Oracle is stale.` | pass |
| Amount changed after signing | `BorrowerOperationsSignatures: Invalid signature` | pass |
| Signature past deadline | `Signature expired` | pass |
| Borrower's nonce moved | `Invalid signature` (rescue void) | pass |
| Same signature replayed | `Invalid signature` | pass |
| Reserve smaller than amount | `ReserveTooSmall` | pass |
| Rescue switched off | `RescueOff` | pass |
| Stranger withdraws someone's reserve | `ReserveTooSmall(0, 1)` | pass |
| Trigger at or below 110% | `TriggerTooLow` | pass |
| `canRescue` view | Matches the guards | pass |

## Live service

| Item | Value |
|---|---|
| App and API | https://vigil-mezo.up.railway.app |
| Health | https://vigil-mezo.up.railway.app/health |
| Revision served on 2026-10-16 | `d83ab05` (matches the pushed commit; history was later rewritten to fix authorship, originally `f49ba95`) |
| Keeper (gas only, key generated inside the service) | [`0xBE8c12D0…3934`](https://explorer.test.mezo.org/address/0xBE8c12D0546430A371d3dE375958574393113934) |
| Telegram | [@VigilMezoBot](https://t.me/VigilMezoBot) |

## Live rescue: 2026-10-16

Borrower: the project's burner wallet [`0x16f2981D…CB4f`](https://explorer.test.mezo.org/address/0x16f2981DF2027e66857e3a857d6d3B2F858eCB4f).

**Scripted setup.** These transactions were sent by `scripts/live-demo.sh` from the burner. They are not a user flow.

| Step | Tx | Result |
|---|---|---|
| Open trove: 0.04 BTC, 2,300 MUSD borrowed | [`0xbccbfb53…8b6c`](https://explorer.test.mezo.org/tx/0xbccbfb53e0abfa0ed78b98ddb820f228052e14ab96e4f27219e3b043665c8b6c) | ok. ICR ~130.8%, liquidation $68,813, #27 in the redemption queue (read from the live API) |
| Approve 400 MUSD | [`0xc71c84cf…29ba`](https://explorer.test.mezo.org/tx/0xc71c84cf3f5313b92f4cf8b99f92a5b1856f5f0cb94817fb9d1ab520d65729ba) | ok |
| Deposit 400 MUSD reserve | [`0xfccafa23…6cb5`](https://explorer.test.mezo.org/tx/0xfccafa234a2da05ee0a1ff77f96c6b00c08c02a08c5724576189439dac276cb5) | ok |
| Set trigger 120% | [`0x54c6d9a0…ae04`](https://explorer.test.mezo.org/tx/0x54c6d9a01eeedc9aed30dbe3553aa8e077b9ab43705c7cdfac8ac46943bdae04) | ok |
| Sign RepayMUSD(300 MUSD, nonce 0, 7 days); POST to the live `/api/rescue` | off-chain | `{"ok":true,"id":1}`. The service verified the signature, nonce, reserve and trigger before arming |

**Rejections (on-chain, expected to revert).**

| Attempt | Tx | Revert (replayed at the block before) |
|---|---|---|
| Rescue while the loan is above its 120% trigger | [`0x94b9e31e…17da`](https://explorer.test.mezo.org/tx/0x94b9e31e8c385f7459ec69c265a7c78dc924e0f5f60704fb8a79135f9a7417da) | `AboveTrigger(icr = 1.30885, trigger = 1.2)` from VigilReserve |
| Same signature, amount changed from 300 to 400 MUSD | [`0x5400e79b…7168`](https://explorer.test.mezo.org/tx/0x5400e79bbcf8e84252b8d37afbd2d6bd24c4c60f336ba638ccf4ac5366a77168) | `BorrowerOperationsSignatures: Invalid signature` from Mezo |

Between the two attempts the trigger was raised to 135% ([`0x794f4b5b…71fd`](https://explorer.test.mezo.org/tx/0x794f4b5b5f611a0bcc4b0554b16c62e5ca02405ea2b9667567351bf23f2471fd), scripted). That put the ~130.9% loan below its trigger.

**Rescue, submitted by the live keeper on Railway, not by the script.**

| Tx | From | Event `Rescued` |
|---|---|---|
| [`0x36505f76…8347`](https://explorer.test.mezo.org/tx/0x36505f769fecbff092c85736a9f09e1c9fc006bf4454d387effe70a8ad5e8347), block 16,183,495, 03:47:21 UTC | keeper `0xbe8c12d0…3934` | amount **300 MUSD**, price $81,910.87, ICR **130.94% → 148.77%** |

Read back after the rescue:

| What | Value |
|---|---|
| Vigil reserve | 400 → 100 MUSD |
| Mezo `getNonce(borrower)` | 0 → 1, so the signature cannot be replayed |
| Trove debt | 2,502.30 → 2,202.30 MUSD |
| Service log | `/api/rescues` shows #1 `executed` with the same tx hash |

**Not yet done:** a rescue signed by a real user in a wallet through the web page. Everything above was set up by script; only the rescue tx came from the live service.
