/**
 * Mezo Passport accounts are Safe v1.4.1 smart accounts (OrangeKit) owned by a BitcoinSafeOwner,
 * which checks a BIP-137 Bitcoin message signature. To opt in to Vigil a Passport user signs ONE
 * Safe transaction with their Bitcoin wallet: a MultiSendCallOnly batch that enables
 * VigilSafeModule and saves their rescue settings. This file builds that transaction, turns the
 * wallet's signMessage output into the signature the Safe expects (the same format OrangeKit's own
 * SDK submits), and leaves relaying to the caller. Mirrors contracts/test/PassportOptIn.t.sol.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { concat, encodeAbiParameters, encodeFunctionData, encodePacked, type Hex, parseAbi, ripemd160, sha256, size, toHex } from "viem";

export const PASSPORT = {
  factory: "0x7E80bd5A2E8Fca0B160254D43aC9f43AC2cC1052", // OrangeKitSafeFactory (proxy)
  multiSendCallOnly: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2", // Safe v1.4.1 canonical
} as const;

export const factoryAbi = parseAbi([
  "function predictAddresses(bytes20 truncatedBitcoinAddress) view returns (address safe, address bitcoinSafeOwner)",
  "function deploySafe(bytes20 truncatedBitcoinAddress) returns (address safe, address bitcoinSafeOwner)",
]);

export const safeAbi = parseAbi([
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function isModuleEnabled(address module) view returns (bool)",
  "function enableModule(address module)",
  "function disableModule(address prevModule, address module)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
]);

export const multiSendAbi = parseAbi(["function multiSend(bytes transactions) payable"]);

export type BitcoinAddressType = "p2pkh" | "p2wpkh" | "p2sh-p2wpkh";

/** The address types BitcoinSafeOwner accepts (Taproot is not supported by Passport). */
export function addressType(address: string): BitcoinAddressType | null {
  const a = address.trim();
  if (/^(bc1q|tb1q|bcrt1q)[02-9ac-hj-np-z]{38}$/.test(a)) return "p2wpkh"; // 20-byte witness program
  if (/^[1mn][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return "p2pkh";
  if (/^[23][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return "p2sh-p2wpkh";
  return null;
}

const hash160 = (b: Hex): Hex => ripemd160(sha256(b));

/** 33-byte compressed key from a 33- or 65-byte hex public key. */
export function compressedKey(pubkey: string): Hex {
  const point = secp256k1.ProjectivePoint.fromHex(pubkey.replace(/^0x/, ""));
  return toHex(point.toRawBytes(true));
}

/** 64-byte x||y of a public key (no 04 prefix), as BitcoinSafeOwner wants it. */
export function uncompressedXY(pubkey: string): Hex {
  const point = secp256k1.ProjectivePoint.fromHex(pubkey.replace(/^0x/, ""));
  return toHex(point.toRawBytes(false).slice(1));
}

/** The 20 bytes OrangeKit's factory derives the account from (its CREATE2 salt input). */
export function truncatedBitcoinAddress(pubkey: string, type: BitcoinAddressType): Hex {
  const pkh = hash160(compressedKey(pubkey));
  return type === "p2sh-p2wpkh" ? hash160(concat(["0x0014", pkh])) : pkh;
}

/**
 * OrangeKit's normalizeV: put a BIP-137 header byte in the range for the address type, and set
 * the high bit, which tells BitcoinSafeOwner the wallet signed the digest as a hex string.
 */
export function normalizeV(v: number, type: BitcoinAddressType): number {
  const base = (v >= 27 ? v - 27 : v) % 4;
  const rangeMin = type === "p2wpkh" ? 39 : type === "p2sh-p2wpkh" ? 35 : 31;
  return (base + rangeMin) | 0x80;
}

/**
 * Safe contract signature for a wallet's signMessage(safeTxHash hex) result: {owner}{offset 65}
 * {type 0}{length 129}{r}{s}{v}{x}{y}, exactly what OrangeKit's SDK submits.
 */
export function safeSignature(owner: Hex, walletSigBase64: string, pubkey: string, type: BitcoinAddressType): Hex {
  const raw = Buffer.from(walletSigBase64, "base64");
  if (raw.length !== 65) throw new Error("expected a 65-byte Bitcoin message signature");
  const v = normalizeV(raw[0]!, type);
  const btcSig = concat([toHex(raw.subarray(1, 33)), toHex(raw.subarray(33, 65)), toHex(v, { size: 1 }), uncompressedXY(pubkey)]);
  const head = encodePacked(["bytes32", "uint256", "uint8", "uint256"], [
    encodeAbiParameters([{ type: "address" }], [owner]),
    65n,
    0,
    BigInt(size(btcSig)),
  ]);
  return concat([head, btcSig]);
}

/** MultiSendCallOnly payload: each call is {0}{to}{value}{len}{data}. */
export function multiSendData(calls: { to: Hex; data: Hex }[]): Hex {
  const packed = concat(
    calls.map((c) => encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, c.to, 0n, BigInt(size(c.data)), c.data])),
  );
  return encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packed] });
}

/** The text a Bitcoin wallet signs: the Safe tx hash as 64 lowercase hex characters. */
export const messageFor = (safeTxHash: Hex) => safeTxHash.slice(2).toLowerCase();
