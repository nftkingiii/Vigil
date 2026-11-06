import { isAddress, type Address } from "viem";

const vigilReserve = process.env.VIGIL_RESERVE ?? "0xF968043b58Bf9993FE3ADC1157C7D186242DE0EB";
if (!isAddress(vigilReserve)) throw new Error("VIGIL_RESERVE is not an address");
const vigilSafeModule = process.env.VIGIL_SAFE_MODULE ?? "0x1F5a0031Bfd7db38249eC8a4dcbc0FDA0e96c7B3";
if (!isAddress(vigilSafeModule)) throw new Error("VIGIL_SAFE_MODULE is not an address");

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  rpcUrl: process.env.MEZO_RPC_URL ?? "https://rpc.test.mezo.org",
  vigilReserve: vigilReserve as Address,
  /** Rescue module for Mezo Passport (Safe) accounts, and the block it was deployed at. */
  vigilSafeModule: vigilSafeModule as Address,
  vigilSafeModuleBlock: BigInt(process.env.VIGIL_SAFE_MODULE_BLOCK ?? "16594948"),
  dataDir: process.env.DATA_DIR ?? "./data",
  port: Number(process.env.PORT ?? 3000),
  publicUrl: (process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  /** Seconds between full snapshots of every trove. */
  snapshotIntervalSec: Number(process.env.SNAPSHOT_INTERVAL_SEC ?? 60),
  /** Git revision reported by /health so the live service can be matched to a commit. */
  revision: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_REVISION ?? "dev",
  /** Keeper submits rescues only when this is "true". */
  keeperEnabled: (process.env.KEEPER_ENABLED ?? "true") === "true",
};
