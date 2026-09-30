import { Database } from "bun:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { getCurrentPeriodId, getDateForPeriod } from "./word5";

const perthClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Australia/Perth",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", hourCycle: "h23",
});

function perthParts(now: Date) {
  const parts = Object.fromEntries(perthClock.formatToParts(now).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export class VisitTracker {
  private readonly key: Buffer;

  constructor(private readonly db: Database, dbPath: string) {
    const keyPath = `${dbPath}.visitor-key`;
    try {
      writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error("Invalid visitor key");
    db.exec(`
      CREATE TABLE IF NOT EXISTS game_visitors (
        period_id INTEGER NOT NULL,
        visitor_hash TEXT NOT NULL,
        puzzle_date TEXT NOT NULL,
        first_seen_utc TEXT NOT NULL,
        last_seen_utc TEXT NOT NULL,
        first_perth_date TEXT NOT NULL,
        last_perth_date TEXT NOT NULL,
        visit_count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (period_id, visitor_hash)
      );
      CREATE TABLE IF NOT EXISTS game_visit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period_id INTEGER NOT NULL,
        visitor_hash TEXT NOT NULL,
        perth_date TEXT NOT NULL,
        perth_hour INTEGER NOT NULL,
        visited_at_utc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS game_visit_events_period_hour
        ON game_visit_events(period_id, perth_date, perth_hour);
      CREATE TABLE IF NOT EXISTS game_day_visitors (
        perth_date TEXT NOT NULL,
        visitor_hash TEXT NOT NULL,
        first_seen_utc TEXT NOT NULL,
        PRIMARY KEY (perth_date, visitor_hash)
      );
    `);
  }

  record(sessionPubkey: unknown, now = new Date()) {
    if (typeof sessionPubkey !== "string" || !/^[a-f0-9]{64}$/i.test(sessionPubkey)) {
      throw new Error("Valid session public key required");
    }
    const periodId = getCurrentPeriodId(now.getTime());
    const visitorHash = createHmac("sha256", this.key)
      .update(`${periodId}:${sessionPubkey.toLowerCase()}`).digest("hex");
    const puzzleDate = getDateForPeriod(periodId);
    const perth = perthParts(now);
    const dayHash = createHmac("sha256", this.key)
      .update(`day:${perth.date}:${sessionPubkey.toLowerCase()}`).digest("hex");
    const timestamp = now.toISOString();
    this.db.transaction(() => {
      this.db.query(`
        INSERT INTO game_visitors
          (period_id, visitor_hash, puzzle_date, first_seen_utc, last_seen_utc, first_perth_date, last_perth_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(period_id, visitor_hash) DO UPDATE SET
          last_seen_utc = excluded.last_seen_utc,
          last_perth_date = excluded.last_perth_date,
          visit_count = visit_count + 1
      `).run(periodId, visitorHash, puzzleDate, timestamp, timestamp, perth.date, perth.date);
      this.db.query(`
        INSERT INTO game_visit_events (period_id, visitor_hash, perth_date, perth_hour, visited_at_utc)
        VALUES (?, ?, ?, ?, ?)
      `).run(periodId, visitorHash, perth.date, perth.hour, timestamp);
      this.db.query(`
        INSERT OR IGNORE INTO game_day_visitors (perth_date, visitor_hash, first_seen_utc)
        VALUES (?, ?, ?)
      `).run(perth.date, dayHash, timestamp);
    })();
    return { ok: true, puzzleDate };
  }

  yesterday(now = new Date()) {
    const periodId = getCurrentPeriodId(now.getTime()) - 1;
    const row = this.db.query("SELECT COUNT(*) AS people FROM game_visitors WHERE period_id = ?")
      .get(periodId) as { people: number };
    return { puzzleDate: getDateForPeriod(periodId), people: row.people, timezone: "Australia/Perth" };
  }
}
