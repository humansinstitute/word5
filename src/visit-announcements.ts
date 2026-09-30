import { Database } from "bun:sqlite";
import { finalizeEvent, SimplePool, type Event } from "nostr-tools";
import { getCurrentPeriodId, getDateForPeriod } from "./word5";

export class VisitAnnouncer {
  private busy = false;

  constructor(
    private readonly db: Database,
    private readonly secretKey: Uint8Array | null,
    private readonly relays: string[],
    private readonly publish: (event: Event, relays: string[]) => Promise<boolean> = publishToRelays,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS game_visit_announcements (
      period_id INTEGER PRIMARY KEY,
      event_json TEXT NOT NULL,
      published_at_utc TEXT
    );
    CREATE TABLE IF NOT EXISTS game_visit_milestones (
      period_id INTEGER NOT NULL,
      threshold INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      published_at_utc TEXT,
      PRIMARY KEY (period_id, threshold)
    )`);
  }

  async announceYesterday(now = new Date()): Promise<"disabled" | "empty" | "published" | "already-published" | "retry"> {
    if (!this.secretKey || !this.relays.length) return "disabled";
    if (this.busy) return "retry";
    this.busy = true;
    try {
      const periodId = getCurrentPeriodId(now.getTime()) - 1;
      const existing = this.db.query("SELECT event_json, published_at_utc FROM game_visit_announcements WHERE period_id = ?")
        .get(periodId) as { event_json: string; published_at_utc: string | null } | null;
      if (existing?.published_at_utc) return "already-published";
      const count = this.db.query("SELECT COUNT(*) AS people FROM game_visitors WHERE period_id = ?")
        .get(periodId) as { people: number };
      if (!count.people) return "empty";
      const previous = this.db.query("SELECT MAX(people) AS peak FROM (SELECT COUNT(*) AS people FROM game_visitors WHERE period_id < ? GROUP BY period_id)")
        .get(periodId) as { peak: number | null };
      const milestone = milestoneCrossed(count.people, previous.peak || 0);

      // Keep the signed event stable across retries and process restarts. Relays
      // deduplicate the same event ID if a publish succeeds before we record it.
      const event: Event = existing ? JSON.parse(existing.event_json) : finalizeEvent({
        kind: 1,
        created_at: Math.floor(now.getTime() / 1000),
        tags: [["t", "word5"], ["game", "word5"], ["date", getDateForPeriod(periodId)]],
        content: `${count.people.toLocaleString("en-US")} people played Word5 yesterday!${milestone ? ` 🎉 New daily milestone: ${milestone.toLocaleString("en-US")} players.` : ""}`,
      }, this.secretKey);
      if (!existing) this.db.query("INSERT INTO game_visit_announcements (period_id, event_json) VALUES (?, ?)")
        .run(periodId, JSON.stringify(event));
      if (!await this.publish(event, this.relays)) return "retry";
      this.db.query("UPDATE game_visit_announcements SET published_at_utc = ? WHERE period_id = ?")
        .run(new Date().toISOString(), periodId);
      return "published";
    } finally {
      this.busy = false;
    }
  }

  async announceCurrentMilestone(now = new Date()): Promise<"disabled" | "empty" | "published" | "already-published" | "retry"> {
    if (!this.secretKey || !this.relays.length) return "disabled";
    if (this.busy) return "retry";
    this.busy = true;
    try {
      const periodId = getCurrentPeriodId(now.getTime());
      const count = this.db.query("SELECT COUNT(*) AS people FROM game_visitors WHERE period_id = ?")
        .get(periodId) as { people: number };
      const threshold = currentMilestone(count.people);
      if (!threshold) return "empty";
      const existing = this.db.query("SELECT event_json, published_at_utc FROM game_visit_milestones WHERE period_id = ? AND threshold = ?")
        .get(periodId, threshold) as { event_json: string; published_at_utc: string | null } | null;
      if (existing?.published_at_utc) return "already-published";
      const event: Event = existing ? JSON.parse(existing.event_json) : finalizeEvent({
        kind: 1,
        created_at: Math.floor(now.getTime() / 1000),
        tags: [["t", "word5"], ["game", "word5"], ["date", getDateForPeriod(periodId)]],
        content: `Big day! Word5 just reached ${threshold.toLocaleString("en-US")} players for today's puzzle!`,
      }, this.secretKey);
      if (!existing) this.db.query("INSERT INTO game_visit_milestones (period_id, threshold, event_json) VALUES (?, ?, ?)")
        .run(periodId, threshold, JSON.stringify(event));
      if (!await this.publish(event, this.relays)) return "retry";
      this.db.query("UPDATE game_visit_milestones SET published_at_utc = ? WHERE period_id = ? AND threshold = ?")
        .run(new Date().toISOString(), periodId, threshold);
      return "published";
    } finally {
      this.busy = false;
    }
  }
}

export function milestoneCrossed(people: number, previousPeak: number): number | null {
  const thresholds = [100, 256, 512, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000];
  return thresholds.filter((threshold) => previousPeak < threshold && people >= threshold).at(-1) || null;
}

export function currentMilestone(people: number): number | null {
  const thresholds = [100, 256, 512, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000];
  return thresholds.filter((threshold) => people >= threshold).at(-1) || null;
}

async function publishToRelays(event: Event, relays: string[]): Promise<boolean> {
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, event));
    return results.some((result) => result.status === "fulfilled");
  } finally {
    pool.close(relays);
  }
}
