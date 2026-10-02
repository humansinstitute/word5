import { Database } from "bun:sqlite";
import { finalizeEvent, nip19, SimplePool, type Event } from "nostr-tools";
import { getCurrentPeriodId, getDateForPeriod, getGameNumberForPeriod, PERIOD_MS } from "./word5";

export const RECAP_DELAY_MS = 21 * 60_000;
export const MAX_RECAP_ATTEMPTS = 6;
const PUBLISH_TIMEOUT_MS = 15_000;
const LEASE_MS = 60_000;
type Row = { period_id: number; event_json: string | null; status: string; attempts: number; next_attempt_ms: number };

export function recapDueAt(period: number): number {
  return (period + 1) * PERIOD_MS + RECAP_DELAY_MS;
}

export class ScoreAnnouncer {
  constructor(private readonly db: Database, private readonly secretKey: Uint8Array | null,
    private readonly relays: string[],
    private readonly publish: (event: Event, relays: string[]) => Promise<boolean> = publishScoreRecap,
    private readonly timeoutMs = PUBLISH_TIMEOUT_MS) {
    db.exec(`CREATE TABLE IF NOT EXISTS game_score_announcements (
      period_id INTEGER PRIMARY KEY, event_json TEXT,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_ms INTEGER NOT NULL DEFAULT 0, published_at_utc TEXT
    )`);
  }

  async run(now = Date.now()): Promise<string> {
    if (!this.secretKey || !this.relays.length) return "disabled";
    this.db.query("UPDATE game_score_announcements SET status='failed' WHERE status='pending' AND attempts>=? AND next_attempt_ms<=?")
      .run(MAX_RECAP_ATTEMPTS, now);
    const yesterday = getCurrentPeriodId(now) - 1;
    // Only create the latest completed game's recap, never flood old history on
    // first activation. Already signed pending events survive later rollovers.
    if (now >= recapDueAt(yesterday)) {
      this.db.transaction(() => {
        if (this.db.query("SELECT 1 FROM game_score_announcements WHERE period_id=?").get(yesterday)) return;
        const rows = this.db.query(`SELECT pubkey, SUM(points) AS points, COUNT(*) AS games,
          SUM(CASE WHEN result!='X' THEN 1 ELSE 0 END) AS wins
          FROM game_submissions WHERE period_id=? AND verified_completion=1 AND published_at IS NOT NULL
          GROUP BY pubkey ORDER BY points DESC, wins DESC, games DESC, pubkey ASC LIMIT 10`)
          .all(yesterday) as { pubkey: string; points: number }[];
        const event = rows.length ? finalizeEvent({ kind: 1, created_at: Math.floor(now / 1000),
          tags: [["t", "word5"], ["game", "word5"], ["period", String(yesterday)],
            ["puzzle", String(getGameNumberForPeriod(yesterday))], ["date", getDateForPeriod(yesterday)],
            ...rows.map(row => ["p", row.pubkey])],
          content: `🏆 Word5 daily honours — Game ${getGameNumberForPeriod(yesterday)} (${getDateForPeriod(yesterday)} UTC)\n\nYesterday’s top ${rows.length} publicly posted ${rows.length === 1 ? "score" : "scores"}:\n` +
            rows.map((row, index) => `${index + 1}. nostr:${nip19.npubEncode(row.pubkey)} — ${row.points} points`).join("\n") +
            "\n\nFive letters. Six guesses. Can you climb today’s leaderboard? Play today and post your score!\nhttps://otherstuff.ai/word5/",
        }, this.secretKey!) : null;
        this.db.query("INSERT INTO game_score_announcements (period_id,event_json,status,next_attempt_ms) VALUES (?,?,?,?)")
          .run(yesterday, event ? JSON.stringify(event) : null, event ? "pending" : "empty", now);
      }).immediate();
    }
    // Claim before network I/O; competing runners reuse the single persisted ID.
    const row = this.db.transaction(() => {
      const candidate = this.db.query(`SELECT * FROM game_score_announcements
        WHERE status='pending' AND attempts<? AND next_attempt_ms<=? ORDER BY period_id LIMIT 1`)
        .get(MAX_RECAP_ATTEMPTS, now) as Row | null;
      if (candidate) this.db.query(`UPDATE game_score_announcements SET attempts=attempts+1,next_attempt_ms=? WHERE period_id=?`)
        .run(now + LEASE_MS, candidate.period_id);
      return candidate;
    }).immediate();
    if (!row) return now < recapDueAt(yesterday) ? "not-due" : "idle";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let confirmed = false;
    try {
      confirmed = await Promise.race([this.publish(JSON.parse(row.event_json!), this.relays),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.timeoutMs); })]);
    } catch { /* Relay errors retry the exact persisted event; never log credentials. */ }
    finally { clearTimeout(timer); }
    const attempts = row.attempts + 1;
    this.db.query(`UPDATE game_score_announcements SET status=?,published_at_utc=?,next_attempt_ms=? WHERE period_id=?`)
      .run(confirmed ? "published" : attempts >= MAX_RECAP_ATTEMPTS ? "failed" : "pending",
        confirmed ? new Date(now).toISOString() : null,
        now + Math.max(LEASE_MS, 60_000 * 2 ** (attempts - 1)), row.period_id);
    return confirmed ? "published" : "retry";
  }

  status(now = Date.now()) {
    return { enabled: Boolean(this.secretKey && this.relays.length), rolloverTimezone: "UTC",
      delayMinutes: 21, nextWakeAt: new Date(this.nextWakeAt(now)).toISOString(),
      latest: this.db.query("SELECT period_id,status,attempts,published_at_utc FROM game_score_announcements ORDER BY period_id DESC LIMIT 1").get() };
  }

  nextWakeAt(now = Date.now()): number {
    const yesterday = getCurrentPeriodId(now) - 1;
    const daily = now < recapDueAt(yesterday) ? recapDueAt(yesterday) : recapDueAt(yesterday + 1);
    const pending = this.db.query(`SELECT MIN(next_attempt_ms) AS due FROM game_score_announcements
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
