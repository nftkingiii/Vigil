import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(join(config.dataDir, "vigil.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS watches (
    chat_id     INTEGER NOT NULL,
    borrower    TEXT    NOT NULL,
    alert_icr   TEXT    NOT NULL,          -- 1e18 fixed point, decimal string
    last_level  TEXT    NOT NULL DEFAULT 'ok',
    last_rank   INTEGER,
    price_paused INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, borrower)
  );
  CREATE TABLE IF NOT EXISTS rescues (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    borrower    TEXT    NOT NULL,
    amount      TEXT    NOT NULL,
    nonce       TEXT    NOT NULL,
    deadline    INTEGER NOT NULL,
    signature   TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'armed', -- armed | executed | void | failed
    detail      TEXT,
    tx_hash     TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS rescues_by_borrower ON rescues (borrower, status);
`);

// Added after launch: databases created earlier lack these columns.
for (const ddl of [`ALTER TABLE rescues ADD COLUMN warning TEXT`]) {
  try {
    db.exec(ddl);
  } catch (e) {
    if (!/duplicate column/i.test(String(e))) throw e;
  }
}

export interface Watch {
  chatId: number;
  borrower: string;
  alertIcr: bigint;
  lastLevel: string;
  lastRank: number | null;
  pricePaused: boolean;
}

export interface Rescue {
  id: number;
  borrower: string;
  amount: bigint;
  nonce: bigint;
  deadline: number;
  signature: `0x${string}`;
  status: "armed" | "executed" | "void" | "failed";
  detail: string | null;
  txHash: string | null;
  /** Codes of the issues last reported to the borrower (rescueHealth.issueKey), "" when none. */
  warning: string;
  createdAt: string;
}

type Row = Record<string, unknown>;

const toWatch = (r: Row): Watch => ({
  chatId: Number(r.chat_id),
  borrower: String(r.borrower),
  alertIcr: BigInt(String(r.alert_icr)),
  lastLevel: String(r.last_level),
  lastRank: r.last_rank == null ? null : Number(r.last_rank),
  pricePaused: Number(r.price_paused) === 1,
});

const toRescue = (r: Row): Rescue => ({
  id: Number(r.id),
  borrower: String(r.borrower),
  amount: BigInt(String(r.amount)),
  nonce: BigInt(String(r.nonce)),
  deadline: Number(r.deadline),
  signature: String(r.signature) as `0x${string}`,
  status: String(r.status) as Rescue["status"],
  detail: r.detail == null ? null : String(r.detail),
  txHash: r.tx_hash == null ? null : String(r.tx_hash),
  warning: r.warning == null ? "" : String(r.warning),
  createdAt: String(r.created_at),
});

export const watches = {
  upsert(chatId: number, borrower: string, alertIcr: bigint) {
    db.prepare(
      `INSERT INTO watches (chat_id, borrower, alert_icr) VALUES (?, ?, ?)
       ON CONFLICT (chat_id, borrower) DO UPDATE SET alert_icr = excluded.alert_icr`,
    ).run(chatId, borrower.toLowerCase(), alertIcr.toString());
  },
  remove(chatId: number, borrower?: string): number {
    const res = borrower
      ? db.prepare(`DELETE FROM watches WHERE chat_id = ? AND borrower = ?`).run(chatId, borrower.toLowerCase())
      : db.prepare(`DELETE FROM watches WHERE chat_id = ?`).run(chatId);
    return Number(res.changes);
  },
  forChat(chatId: number): Watch[] {
    return db.prepare(`SELECT * FROM watches WHERE chat_id = ? ORDER BY created_at`).all(chatId).map(toWatch);
  },
  forBorrower(borrower: string): Watch[] {
    return db.prepare(`SELECT * FROM watches WHERE borrower = ?`).all(borrower.toLowerCase()).map(toWatch);
  },
  all(): Watch[] {
    return db.prepare(`SELECT * FROM watches`).all().map(toWatch);
  },
  setState(chatId: number, borrower: string, level: string, rank: number | null, pricePaused: boolean) {
    db.prepare(
      `UPDATE watches SET last_level = ?, last_rank = ?, price_paused = ? WHERE chat_id = ? AND borrower = ?`,
    ).run(level, rank, pricePaused ? 1 : 0, chatId, borrower.toLowerCase());
  },
  count(): number {
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM watches`).get() as Row).n);
  },
};

export const rescues = {
  /** Arming a new rescue replaces any earlier armed one: only the latest nonce can ever be valid. */
  arm(r: { borrower: string; amount: bigint; nonce: bigint; deadline: number; signature: string }): number {
    db.prepare(`UPDATE rescues SET status = 'void', detail = 'replaced', updated_at = datetime('now')
                WHERE borrower = ? AND status = 'armed'`).run(r.borrower.toLowerCase());
    const res = db
      .prepare(`INSERT INTO rescues (borrower, amount, nonce, deadline, signature) VALUES (?, ?, ?, ?, ?)`)
      .run(r.borrower.toLowerCase(), r.amount.toString(), r.nonce.toString(), r.deadline, r.signature);
    return Number(res.lastInsertRowid);
  },
  armed(): Rescue[] {
    return db.prepare(`SELECT * FROM rescues WHERE status = 'armed'`).all().map(toRescue);
  },
  latest(borrower: string): Rescue | null {
    const row = db
      .prepare(`SELECT * FROM rescues WHERE borrower = ? ORDER BY id DESC LIMIT 1`)
      .get(borrower.toLowerCase());
    return row ? toRescue(row as Row) : null;
  },
  history(limit = 20): Rescue[] {
    return db.prepare(`SELECT * FROM rescues ORDER BY id DESC LIMIT ?`).all(limit).map(toRescue);
  },
  setWarning(id: number, warning: string) {
    db.prepare(`UPDATE rescues SET warning = ?, updated_at = datetime('now') WHERE id = ?`).run(warning, id);
  },
  finish(id: number, status: Rescue["status"], detail: string | null, txHash: string | null = null) {
    db.prepare(`UPDATE rescues SET status = ?, detail = ?, tx_hash = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, detail, txHash, id);
  },
};
