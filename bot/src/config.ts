import { isAddress, type Address } from "viem";

const vigilReserve = process.env.VIGIL_RESERVE ?? "0x772dC64C23e579CaBA63D4f824379Cad19D2B2c4";
if (!isAddress(vigilReserve)) throw new Error("VIGIL_RESERVE is not an address");

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  rpcUrl: process.env.MEZO_RPC_URL ?? "https://rpc.test.mezo.org",
  vigilReserve: vigilReserve as Address,
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
