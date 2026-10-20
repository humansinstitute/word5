import { Database } from "bun:sqlite";
import { SimplePool, type Event } from "nostr-tools";

export const OUTBOX_MAX_ATTEMPTS = 12;
const OUTBOX_LEASE_MS = 60_000;
const OUTBOX_TIMEOUT_MS = 15_000;

export type RelayDelivery = {
  eventId: string;
  relay: string;
  status: "pending" | "published" | "failed";
  attempts: number;
  reason: string | null;
};

export type RelaySend = (event: Event, relay: string) => Promise<boolean>;

function cleanRelays(relays: string[]): string[] {
  return [...new Set(relays.map((relay) => relay.trim()).filter((relay) => /^wss:\/\//.test(relay)))].sort();
}

export class RelayOutbox {
  constructor(readonly db: Database, private readonly send: RelaySend = sendToRelay,
    private readonly timeoutMs = OUTBOX_TIMEOUT_MS) {
    db.exec(`CREATE TABLE IF NOT EXISTS relay_event_outbox (
      event_id TEXT NOT NULL, relay TEXT NOT NULL, event_json TEXT NOT NULL,
      category TEXT NOT NULL, address TEXT,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_ms INTEGER NOT NULL DEFAULT 0, last_error TEXT, published_at_utc TEXT,
      PRIMARY KEY(event_id, relay)
    );
    CREATE INDEX IF NOT EXISTS relay_event_outbox_due
      ON relay_event_outbox(status,next_attempt_ms,event_id);
    CREATE INDEX IF NOT EXISTS relay_event_outbox_address
      ON relay_event_outbox(address,event_id);`);
  }

  enqueue(event: Event, relays: string[], category: string, address: string | null = null): RelayDelivery[] {
    const targets = cleanRelays(relays);
    const eventJson = JSON.stringify(event);
    this.db.transaction(() => {
      const insert = this.db.query(`INSERT OR IGNORE INTO relay_event_outbox
        (event_id,relay,event_json,category,address,status,next_attempt_ms)
        VALUES (?1,?2,?3,?4,?5,'pending',0)`);
      for (const relay of targets) insert.run(event.id, relay, eventJson, category, address);
    })();
    return this.deliveries(event.id);
  }

  deliveries(eventId: string): RelayDelivery[] {
    return this.db.query(`SELECT event_id AS eventId,relay,status,attempts,last_error AS reason
      FROM relay_event_outbox WHERE event_id=?1 ORDER BY relay`).all(eventId) as RelayDelivery[];
  }

  record(eventId: string, results: Array<{ relay: string; status: "ok" | "failed"; reason?: string }>, now = Date.now()): void {
    const update = this.db.query(`UPDATE relay_event_outbox SET status=?1,last_error=?2,
      published_at_utc=?3,next_attempt_ms=?4 WHERE event_id=?5 AND relay=?6`);
    this.db.transaction(() => {
      for (const result of results) {
        const ok = result.status === "ok" || /duplicate|already.*(?:have|exist|stored)/i.test(result.reason || "");
        update.run(ok ? "published" : "pending", ok ? null : result.reason || "relay did not confirm event",
          ok ? new Date(now).toISOString() : null, ok ? now : now + OUTBOX_LEASE_MS, eventId, result.relay);
      }
    })();
  }

  async flush(now = Date.now(), limit = 50): Promise<{ attempted: number; published: number; pending: number; failed: number }> {
    let attempted = 0, published = 0;
    for (let index = 0; index < limit; index++) {
      const row = this.db.transaction(() => {
        this.db.query(`UPDATE relay_event_outbox SET status='failed'
          WHERE status='pending' AND attempts>=?1 AND next_attempt_ms<=?2`).run(OUTBOX_MAX_ATTEMPTS, now);
        const candidate = this.db.query(`SELECT event_id AS eventId,relay,event_json AS eventJson,attempts
          FROM relay_event_outbox WHERE status='pending' AND attempts<?1 AND next_attempt_ms<=?2
          ORDER BY next_attempt_ms,event_id,relay LIMIT 1`).get(OUTBOX_MAX_ATTEMPTS, now) as
          { eventId: string; relay: string; eventJson: string; attempts: number } | null;
        if (candidate) this.db.query(`UPDATE relay_event_outbox SET attempts=attempts+1,next_attempt_ms=?1
          WHERE event_id=?2 AND relay=?3 AND status='pending'`).run(now + OUTBOX_LEASE_MS, candidate.eventId, candidate.relay);
        return candidate;
      }).immediate();
      if (!row) break;
      attempted++;
      let ok = false, reason: string | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        ok = await Promise.race([
          this.send(JSON.parse(row.eventJson), row.relay),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), this.timeoutMs); }),
        ]);
        if (!ok) reason = "relay did not confirm event";
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      } finally { clearTimeout(timer); }
      const attempts = row.attempts + 1;
      const status = ok ? "published" : attempts >= OUTBOX_MAX_ATTEMPTS ? "failed" : "pending";
      this.db.query(`UPDATE relay_event_outbox SET status=?1,last_error=?2,published_at_utc=?3,next_attempt_ms=?4
        WHERE event_id=?5 AND relay=?6`).run(status, ok ? null : reason,
          ok ? new Date(now).toISOString() : null,
          now + Math.max(OUTBOX_LEASE_MS, 60_000 * 2 ** Math.min(10, attempts - 1)), row.eventId, row.relay);
      if (ok) published++;
    }
    const counts = this.db.query(`SELECT
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM relay_event_outbox`)
      .get() as { pending: number | null; failed: number | null };
    return { attempted, published, pending: counts.pending || 0, failed: counts.failed || 0 };
  }

  status() {
    return this.db.query(`SELECT category,status,COUNT(*) AS count FROM relay_event_outbox
      GROUP BY category,status ORDER BY category,status`).all();
  }
}

async function sendToRelay(event: Event, relay: string): Promise<boolean> {
  const pool = new SimplePool();
  try {
    const [delivery] = pool.publish([relay], event);
    if (!delivery) return false;
    try { await delivery; return true; }
    catch (error) {
      return /duplicate|already.*(?:have|exist|stored)/i.test(String(error));
    }
  } finally { pool.close([relay]); }
}
