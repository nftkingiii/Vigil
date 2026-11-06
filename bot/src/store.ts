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
  CREATE TABLE IF NOT EXISTS feedback (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL,
    text        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// Added after launch: databases created earlier lack these columns.
for (const ddl of [
  `ALTER TABLE rescues ADD COLUMN warning TEXT`,
  `ALTER TABLE watches ADD COLUMN redemption_alert TEXT`, // MUSD of debt ahead, 1e18; NULL = off
  `ALTER TABLE watches ADD COLUMN below_redemption INTEGER NOT NULL DEFAULT 0`,
]) {
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
  /** Alert when less than this much MUSD of other debt is ahead in the redemption queue. */
  redemptionAlert: bigint | null;
  belowRedemption: boolean;
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
  redemptionAlert: r.redemption_alert == null ? null : BigInt(String(r.redemption_alert)),
  belowRedemption: Number(r.below_redemption) === 1,
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
  setRedemptionAlert(chatId: number, amount: bigint | null): number {
    const res = db
      .prepare(`UPDATE watches SET redemption_alert = ?, below_redemption = 0 WHERE chat_id = ?`)
      .run(amount === null ? null : amount.toString(), chatId);
    return Number(res.changes);
  },
  setBelowRedemption(chatId: number, borrower: string, below: boolean) {
    db.prepare(`UPDATE watches SET below_redemption = ? WHERE chat_id = ? AND borrower = ?`).run(below ? 1 : 0, chatId, borrower.toLowerCase());
  },
  count(): number {
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM watches`).get() as Row).n);
  },
  borrowerList(): string[] {
    return (db.prepare(`SELECT DISTINCT borrower FROM watches`).all() as Row[]).map((r) => String(r.borrower));
  },
  borrowers(): number {
    return Number((db.prepare(`SELECT COUNT(DISTINCT borrower) AS n FROM watches`).get() as Row).n);
  },
};

db.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);

/** Small persistent key-value state (e.g. the last warning sent for a Passport account). */
export const kv = {
  get(k: string): string | null {
    const row = db.prepare(`SELECT v FROM kv WHERE k = ?`).get(k) as Row | undefined;
    return row ? String(row.v) : null;
  },
  set(k: string, v: string) {
    db.prepare(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).run(k, v);
  },
};

export const feedback = {
  add(chatId: number, text: string): number {
    return Number(db.prepare(`INSERT INTO feedback (chat_id, text) VALUES (?, ?)`).run(chatId, text.slice(0, 2000)).lastInsertRowid);
  },
  count(): number {
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM feedback`).get() as Row).n);
  },
  /** Feedback texts only (no chat ids), newest first, for the operator's write-up. */
  texts(limit = 200): { text: string; createdAt: string }[] {
    return (db.prepare(`SELECT text, created_at FROM feedback ORDER BY id DESC LIMIT ?`).all(limit) as Row[]).map((r) => ({
      text: String(r.text),
      createdAt: String(r.created_at),
    }));
  },
};

export const rescues = {
  /**
   * Arm a signed repay. Stepped rescues use consecutive Mezo nonces, so several can be armed at
   * once; a new signature for a nonce that already has one replaces it.
   */
  arm(r: { borrower: string; amount: bigint; nonce: bigint; deadline: number; signature: string }): number {
    db.prepare(`UPDATE rescues SET status = 'void', detail = 'replaced', updated_at = datetime('now')
                WHERE borrower = ? AND status = 'armed' AND nonce = ?`).run(r.borrower.toLowerCase(), r.nonce.toString());
    const res = db
      .prepare(`INSERT INTO rescues (borrower, amount, nonce, deadline, signature) VALUES (?, ?, ?, ?, ?)`)
      .run(r.borrower.toLowerCase(), r.amount.toString(), r.nonce.toString(), r.deadline, r.signature);
    return Number(res.lastInsertRowid);
  },
  armed(): Rescue[] {
    return db.prepare(`SELECT * FROM rescues WHERE status = 'armed'`).all().map(toRescue);
  },
  /** A borrower's armed steps, in the order they can run (by nonce). */
  armedFor(borrower: string): Rescue[] {
    return db
      .prepare(`SELECT * FROM rescues WHERE status = 'armed' AND borrower = ?`)
      .all(borrower.toLowerCase())
      .map(toRescue)
      .sort((a, b) => (a.nonce < b.nonce ? -1 : 1));
  },
  latest(borrower: string): Rescue | null {
    const row = db
      .prepare(`SELECT * FROM rescues WHERE borrower = ? ORDER BY id DESC LIMIT 1`)
      .get(borrower.toLowerCase());
    return row ? toRescue(row as Row) : null;
  },
  stats(): { armed: number; executed: number; repaid: bigint; borrowers: number } {
    const rows = db.prepare(`SELECT status, amount, borrower FROM rescues`).all() as Row[];
    let repaid = 0n;
    for (const r of rows) if (r.status === "executed") repaid += BigInt(String(r.amount));
    return {
      armed: rows.filter((r) => r.status === "armed").length,
      executed: rows.filter((r) => r.status === "executed").length,
      repaid,
      borrowers: new Set(rows.map((r) => String(r.borrower))).size,
    };
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
