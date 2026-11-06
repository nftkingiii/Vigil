import assert from "node:assert/strict";
import { test } from "node:test";
import { addressType, multiSendData, normalizeV, safeSignature, truncatedBitcoinAddress } from "../src/passport.ts";

// A fixed secp256k1 key (generator point G) so expectations are reproducible.
const G = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

test("address types BitcoinSafeOwner accepts; Taproot is refused", () => {
  assert.equal(addressType("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"), "p2wpkh");
  assert.equal(addressType("mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn"), "p2pkh");
  assert.equal(addressType("2N2JD6wb56AfK4tfmM6PwdVmoYk2dCKf4Br"), "p2sh-p2wpkh");
  assert.equal(addressType("tb1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297"), null);
});

test("truncated address: hash160 of the key, or of the P2SH-P2WPKH redeem script", () => {
  // hash160(G) is the well-known 751e76e8199196d454941c45d1b3a323f1433bd6.
  assert.equal(truncatedBitcoinAddress(G, "p2wpkh"), "0x751e76e8199196d454941c45d1b3a323f1433bd6");
  assert.equal(truncatedBitcoinAddress(G, "p2pkh"), "0x751e76e8199196d454941c45d1b3a323f1433bd6");
  assert.notEqual(truncatedBitcoinAddress(G, "p2sh-p2wpkh"), "0x751e76e8199196d454941c45d1b3a323f1433bd6");
});

test("normalizeV follows OrangeKit: BIP-137 range for the type, plus the hex-string high bit", () => {
  assert.equal(normalizeV(31, "p2pkh"), 31 | 0x80);
  assert.equal(normalizeV(32, "p2wpkh"), 40 | 0x80);
  assert.equal(normalizeV(1, "p2sh-p2wpkh"), 36 | 0x80);
});

test("Safe contract signature layout: owner, offset 65, type 0, length 129, then r s v x y", () => {
  const sig = Buffer.alloc(65, 7);
  sig[0] = 32;
  const out = safeSignature("0x00000000000000000000000000000000000000aa", sig.toString("base64"), G, "p2wpkh");
  const b = Buffer.from(out.slice(2), "hex");
  assert.equal(b.length, 32 + 32 + 1 + 32 + 129);
  assert.equal(b.readUInt8(31), 0xaa); // owner
  assert.equal(b.readUInt8(63), 65); // data offset
  assert.equal(b.readUInt8(64), 0); // contract signature
  assert.equal(b.readUInt8(96), 129); // length
  assert.equal(b.readUInt8(97 + 64), 40 | 0x80); // v after r and s
});

test("MultiSend payload packs each call as operation, to, value, length, data", () => {
  const data = multiSendData([{ to: "0x00000000000000000000000000000000000000bb", data: "0x1234" }]);
  assert.match(data, /^0x8d80ff0a/); // multiSend(bytes)
  assert.ok(data.includes("00000000000000000000000000000000000000bb" + "0".repeat(64) + "0".repeat(63) + "21234"));
});
