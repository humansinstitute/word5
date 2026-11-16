import { Database } from "bun:sqlite";
import { finalizeEvent, nip19, SimplePool, type Event } from "nostr-tools";
import { getCurrentPeriodId, getDateForPeriod, getGameNumberForPeriod, PERIOD_MS } from "./word5";

export const RECAP_DELAY_MS = 21 * 60_000;
export const NOON_OFFSET_MS = 12 * 60 * 60_000;
export const ROLLING_PERIODS = 21;
export const MAX_RECAP_ATTEMPTS = 6;
const PUBLISH_TIMEOUT_MS = 15_000;
const LEASE_MS = 60_000;
type Row = { period_id: number; event_json: string | null; status: string; attempts: number; next_attempt_ms: number };

export function recapDueAt(period: number): number {
  return (period + 1) * PERIOD_MS + RECAP_DELAY_MS;
}

export function noonRecapDueAt(period: number): number {
  return period * PERIOD_MS + NOON_OFFSET_MS;
}

export class ScoreAnnouncer {
  constructor(private readonly db: Database, private readonly secretKey: Uint8Array | null,
    private readonly relays: string[],
    private readonly publish: (event: Event, relays: string[]) => Promise<boolean> = publishScoreRecap,
    private readonly timeoutMs = PUBLISH_TIMEOUT_MS) {
    // Keep the legacy daily table and signed events untouched on upgrade.
    for (const table of ["game_score_announcements", "game_score_noon_announcements"]) db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      period_id INTEGER PRIMARY KEY, event_json TEXT,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_ms INTEGER NOT NULL DEFAULT 0, published_at_utc TEXT
    )`);
  }

  async run(now = Date.now()): Promise<string> {
    if (!this.secretKey || !this.relays.length) return "disabled";
    const daily = await this.runSchedule(now, false);
    const noon = await this.runSchedule(now, true);
    return [daily, noon].includes("published") ? "published"
      : [daily, noon].includes("retry") ? "retry" : daily;
  }

  private async runSchedule(now: number, noon: boolean): Promise<string> {
    const table = noon ? "game_score_noon_announcements" : "game_score_announcements";
    const dueAt = noon ? noonRecapDueAt : recapDueAt;
    this.db.query(`UPDATE ${table} SET status='failed' WHERE status='pending' AND attempts>=? AND next_attempt_ms<=?`)
      .run(MAX_RECAP_ATTEMPTS, now);
    const period = getCurrentPeriodId(now) - (noon ? 0 : 1);
    // Create only the latest eligible snapshot, never generate a history backlog.
    // Noon catchup is limited to today after noon; persisted retries retain IDs.
    if (now >= dueAt(period)) {
      this.db.transaction(() => {
        if (this.db.query(`SELECT 1 FROM ${table} WHERE period_id=?`).get(period)) return;
        const rows = this.db.query(`SELECT pubkey, SUM(points) AS points, COUNT(*) AS games,
          SUM(CASE WHEN result!='X' THEN 1 ELSE 0 END) AS wins
          FROM game_submissions WHERE period_id BETWEEN ? AND ? AND verified_completion=1 AND published_at IS NOT NULL
          GROUP BY pubkey ORDER BY points DESC, wins DESC, games DESC, pubkey ASC LIMIT 10`)
          .all(noon ? period - ROLLING_PERIODS + 1 : period, period) as { pubkey: string; points: number; games: number; wins: number }[];
        const event = rows.length ? finalizeEvent({ kind: 1, created_at: Math.floor(now / 1000),
          tags: [["t", "word5"], ["game", "word5"], ["period", String(period)],
            ["puzzle", String(getGameNumberForPeriod(period))], ["date", getDateForPeriod(period)],
            ...(noon ? [["recap", "noon-21-period"], ["from", getDateForPeriod(period - ROLLING_PERIODS + 1)],
              ["snapshot", new Date(now).toISOString()]] : []),
            ...rows.map(row => ["p", row.pubkey])],
          content: (noon ? `🏆 #word5 rolling leaderboard — 21 UTC puzzle periods\n${getDateForPeriod(period - ROLLING_PERIODS + 1)} through ${getDateForPeriod(period)} (inclusive)\nSnapshot: ${new Date(now).toISOString()} — today’s puzzle is still in progress.\n\nTop ${rows.length} publicly posted players:\n` : `🏆 #word5 daily honours — Game ${getGameNumberForPeriod(period)} (${getDateForPeriod(period)} UTC)\n\nYesterday’s top ${rows.length} publicly posted ${rows.length === 1 ? "score" : "scores"}:\n`) +
            rows.map((row, index) => `${index + 1}. nostr:${nip19.npubEncode(row.pubkey)} — ${row.points} points · ${row.games} games · ${row.wins} wins`).join("\n") +
            "\n\nFive letters. Six guesses. Can you climb today’s leaderboard? Play today and post your score!\nhttps://otherstuff.ai/word5/",
        }, this.secretKey!) : null;
        this.db.query(`INSERT INTO ${table} (period_id,event_json,status,next_attempt_ms) VALUES (?,?,?,?)`)
          .run(period, event ? JSON.stringify(event) : null, event ? "pending" : "empty", now);
      }).immediate();
    }
    // Claim before network I/O; competing runners reuse the single persisted ID.
    const row = this.db.transaction(() => {
      const candidate = this.db.query(`SELECT * FROM ${table}
        WHERE status='pending' AND attempts<? AND next_attempt_ms<=? ORDER BY period_id LIMIT 1`)
        .get(MAX_RECAP_ATTEMPTS, now) as Row | null;
      if (candidate) this.db.query(`UPDATE ${table} SET attempts=attempts+1,next_attempt_ms=? WHERE period_id=?`)
        .run(now + LEASE_MS, candidate.period_id);
      return candidate;
    }).immediate();
    if (!row) return now < dueAt(period) ? "not-due" : "idle";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let confirmed = false;
    try {
      confirmed = await Promise.race([this.publish(JSON.parse(row.event_json!), this.relays),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.timeoutMs); })]);
    } catch { /* Relay errors retry the exact persisted event; never log credentials. */ }
    finally { clearTimeout(timer); }
    const attempts = row.attempts + 1;
    this.db.query(`UPDATE ${table} SET status=?,published_at_utc=?,next_attempt_ms=? WHERE period_id=?`)
      .run(confirmed ? "published" : attempts >= MAX_RECAP_ATTEMPTS ? "failed" : "pending",
        confirmed ? new Date(now).toISOString() : null,
        now + Math.max(LEASE_MS, 60_000 * 2 ** (attempts - 1)), row.period_id);
    return confirmed ? "published" : "retry";
  }

  status(now = Date.now()) {
    return { enabled: Boolean(this.secretKey && this.relays.length), rolloverTimezone: "UTC",
      delayMinutes: 21, nextWakeAt: new Date(this.nextWakeAt(now)).toISOString(),
      noon: { schedule: "12:00 UTC daily", windowPeriods: ROLLING_PERIODS,
        includesCurrentPeriod: true, nextWakeAt: new Date(this.scheduleWakeAt(now, true)).toISOString(),
        latest: this.db.query("SELECT period_id,status,attempts,published_at_utc FROM game_score_noon_announcements ORDER BY period_id DESC LIMIT 1").get() },
      latest: this.db.query("SELECT period_id,status,attempts,published_at_utc FROM game_score_announcements ORDER BY period_id DESC LIMIT 1").get() };
  }

  nextWakeAt(now = Date.now()): number {
    return Math.min(this.scheduleWakeAt(now, false), this.scheduleWakeAt(now, true));
  }

  private scheduleWakeAt(now: number, noon: boolean): number {
    const table = noon ? "game_score_noon_announcements" : "game_score_announcements";
    const dueAt = noon ? noonRecapDueAt : recapDueAt;
    const period = getCurrentPeriodId(now) - (noon ? 0 : 1);
    const daily = now < dueAt(period) ? dueAt(period) : dueAt(period + 1);
    const pending = this.db.query(`SELECT MIN(next_attempt_ms) AS due FROM ${table}
      WHERE status='pending'`).get() as { due: number | null };
    return pending.due === null ? daily : Math.min(daily, Math.max(now, pending.due));
  }
}

export function startScoreAnnouncements(announcer: ScoreAnnouncer,
  clock = Date.now, schedule = (callback: () => void, delay: number) => setTimeout(callback, delay)) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    let delay = 60_000;
    try { await announcer.run(clock()); delay = Math.max(1, announcer.nextWakeAt(clock()) - clock()); }
    catch { console.error("Word5 score recap failed; retrying scheduler in one minute"); }
    if (!stopped) timer = schedule(() => { void tick(); }, delay);
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}

async function publishScoreRecap(event: Event, relays: string[]): Promise<boolean> {
  const pool = new SimplePool();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // First acceptance suffices, even if another relay hangs. Duplicate acceptance
    // is also success; retries always send the same event ID.
    return await Promise.race([
      Promise.any(pool.publish(relays, event).map(p => p.catch(error => {
        if (/duplicate|already.*(?:have|exist|stored)/i.test(String(error))) return "duplicate";
        throw error;
      }))).then(() => true).catch(() => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), PUBLISH_TIMEOUT_MS); }),
    ]);
  } finally { clearTimeout(timer); pool.close(relays); }
}
