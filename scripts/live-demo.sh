#!/usr/bin/env bash
# Scripted setup for Vigil's live rescue evidence on Mezo testnet.
# Uses a burner key from $KEY_FILE. Every transaction here is labelled "scripted" in docs/evidence.md;
# the rescue itself is submitted by the live Vigil keeper, not by this script.
set -euo pipefail

STEP=${1:?usage: live-demo.sh open|reserve|arm|reject-above|trigger|reject-tamper|borrow|v1-withdraw|guard-reserve|reject-guard|guard}
KEY_FILE=${KEY_FILE:-$HOME/.vigil/deployer.key}
RPC=${RPC:-https://rpc.test.mezo.org}
VIGIL_URL=${VIGIL_URL:-https://vigil-mezo.up.railway.app}
CAST=${CAST:-cast}

MUSD=0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503
BORROWER_OPS=0xCdF7028ceAB81fA0C6971208e83fa7872994beE5
SIG_OPS=0xD757e3646AF370b15f32EB557F0F8380Df7D639e
VIGIL_V1=0x9829963c86bf6A8AC47b0996eAD58cf3e630cf3E # Wave 1 (ratio trigger only)
VIGIL_V2=0x772dC64C23e579CaBA63D4f824379Cad19D2B2c4 # Wave 2 redemption-guard proof (Nov 4)
VIGIL=${VIGIL:-0x29FB8a330cD5c114B30F0C69b50Bb459dE023885} # Wave 2: ratio trigger + redemption guard + submitter fee
ZERO=0x0000000000000000000000000000000000000000

KEY=$(cat "$KEY_FILE")
ME=$($CAST wallet address --private-key "$KEY")
STATE=${STATE:-$(dirname "$KEY_FILE")/demo-state}
mkdir -p "$STATE"

send() { # send <label> <to> <sig> [args...] ; prints tx hash and status
  local label=$1; shift
  local out
  out=$($CAST send "$@" --private-key "$KEY" --rpc-url "$RPC" --json)
  echo "$label $(echo "$out" | python3 -c 'import json,sys;r=json.load(sys.stdin);print(r["transactionHash"], "status", r["status"])')"
}

send_expect_revert() { # broadcast a call that is expected to revert, so the rejection is on-chain
  local label=$1; shift
  local out
  out=$($CAST send "$@" --gas-limit "${GAS:-600000}" --private-key "$KEY" --rpc-url "$RPC" --json 2>&1 || true)
  echo "$label $(echo "$out" | python3 -c 'import json,sys
try:
  r=json.load(sys.stdin); print(r["transactionHash"], "status", r["status"])
except Exception as e: print("not broadcast:", sys.stdin.read()[:200])')"
}

case $STEP in
  open) # 0.04 BTC collateral, 2,300 MUSD borrowed (~130% ICR at $81.8k)
    send "openTrove" "$BORROWER_OPS" "openTrove(uint256,address,address)" 2300000000000000000000 $ZERO $ZERO --value 0.04ether ;;
  reserve) # 400 MUSD reserve, trigger 120% (below the loan's ratio, so no rescue yet)
    send "approve" "$MUSD" "approve(address,uint256)" $VIGIL 400000000000000000000
    send "deposit" "$VIGIL" "deposit(address,uint256)" "$ME" 400000000000000000000
    send "setTrigger(120%)" "$VIGIL" "setTrigger(uint256)" 1200000000000000000 ;;
  arm) # sign Mezo's RepayMUSD for 300 MUSD and hand it to the live service
    NONCE=$($CAST call $SIG_OPS "getNonce(address)(uint256)" "$ME" --rpc-url "$RPC" | cut -d' ' -f1)
    DEADLINE=$(( $(date +%s) + 7*86400 ))
    AMOUNT=300000000000000000000
    cat > "$STATE/typed.json" <<JSON
{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],
"RepayMUSD":[{"name":"amount","type":"uint256"},{"name":"borrower","type":"address"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}]},
"primaryType":"RepayMUSD",
"domain":{"name":"BorrowerOperationsSignatures","version":"1","chainId":31611,"verifyingContract":"$SIG_OPS"},
"message":{"amount":"$AMOUNT","borrower":"$ME","nonce":"$NONCE","deadline":"$DEADLINE"}}
JSON
    SIG=$($CAST wallet sign --data --from-file "$STATE/typed.json" --private-key "$KEY")
    echo "$SIG" > "$STATE/sig"; echo "$DEADLINE" > "$STATE/deadline"
    curl -sS -X POST "$VIGIL_URL/api/rescue" -H 'content-type: application/json' \
      -d "{\"borrower\":\"$ME\",\"amount\":\"$AMOUNT\",\"nonce\":\"$NONCE\",\"deadline\":\"$DEADLINE\",\"signature\":\"$SIG\"}"
    echo ;;
  reject-above) # loan is above its 120% trigger: VigilReserve must refuse
    send_expect_revert "rescue(above trigger)" "$VIGIL" "rescue(address,uint256,uint256,bytes,address,address)" \
      "$ME" 300000000000000000000 "$(cat "$STATE/deadline")" "$(cat "$STATE/sig")" $ZERO $ZERO ;;
  trigger) # raise the trigger to 135%: the loan (~130%) is now below it
    send "setTrigger(135%)" "$VIGIL" "setTrigger(uint256)" 1350000000000000000 ;;
  reject-tamper) # same signature, amount changed to 400: Mezo must refuse
    send_expect_revert "rescue(tampered amount)" "$VIGIL" "rescue(address,uint256,uint256,bytes,address,address)" \
      "$ME" 400000000000000000000 "$(cat "$STATE/deadline")" "$(cat "$STATE/sig")" $ZERO $ZERO ;;
  # ---- Wave 2: redemption-guard rescue (VigilReserve v2)
  borrow) # borrow 350 more MUSD: the loan moves from ~146% to ~126%, near the front of the redemption queue
    send "withdrawMUSD(350)" "$BORROWER_OPS" "withdrawMUSD(uint256,address,address)" 350000000000000000000 $ZERO $ZERO ;;
  v1-withdraw) # take the 100 MUSD left in the Wave 1 reserve back to the wallet
    send "v1 withdraw(100)" "$VIGIL_V1" "withdraw(uint256,address)" 100000000000000000000 "$ME" ;;
  guard-reserve) # 400 MUSD reserve in v2, ratio trigger off, redemption guard 20,000 MUSD (less than is ahead now)
    send "approve" "$MUSD" "approve(address,uint256)" $VIGIL 400000000000000000000
    send "deposit" "$VIGIL" "deposit(address,uint256)" "$ME" 400000000000000000000
    send "setTrigger(off)" "$VIGIL" "setTrigger(uint256)" 0
    send "setRedemptionGuard(20,000)" "$VIGIL" "setRedemptionGuard(uint256)" 20000000000000000000000 ;;
  reject-guard) # more debt than the guard is ahead: VigilReserve must refuse (queue walk needs more gas)
    GAS=3000000 send_expect_revert "rescue(guard not hit)" "$VIGIL" "rescue(address,uint256,uint256,bytes,address,address)" \
      "$ME" 300000000000000000000 "$(cat "$STATE/deadline")" "$(cat "$STATE/sig")" $ZERO $ZERO ;;
  guard) # raise the guard to 60,000 MUSD: less than that is ahead, so the live keeper may rescue
    send "setRedemptionGuard(60,000)" "$VIGIL" "setRedemptionGuard(uint256)" 60000000000000000000000 ;;
esac
