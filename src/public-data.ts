import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { finalizeEvent, getPublicKey, type Event } from "nostr-tools";
import { getCurrentPeriodId, getDateForPeriod, getGameNumberForPeriod, PERIOD_MS } from "./word5";
import { RelayOutbox } from "./relay-outbox";
import type { SocialHistory } from "./social-history";

export const WORD5_PUBLIC_DATA_KIND = 30763;
export const WORD5_PUBLIC_SCHEMA = "word5.leaderboard.v1";
export const TOP_STREAKS_D = "word5:streaks:all-time:v1";
export const DAILY_D = (periodId: number) => `word5:daily:${periodId}:v1`;
const DAILY_CUTOFF_DELAY_MS = 21 * 60_000;

type SnapshotSpec = {
  address: string;
  dataset: "top-streaks" | "daily-scores";
  basis: "signed-public-history" | "server-verified";
  cutoff: Record<string, string | number>;
  rows: Array<Record<string, unknown>>;
  tags?: string[][];
};

export class PublicDataPublisher {
  readonly serverPubkey: string | null;

  constructor(readonly db: Database, private readonly secretKey: Uint8Array | null,
    private readonly relays: string[], private readonly socialHistory: SocialHistory,
    readonly outbox: RelayOutbox) {
    this.serverPubkey = secretKey ? getPublicKey(secretKey) : null;
    db.exec(`CREATE TABLE IF NOT EXISTS public_snapshot_events (
      event_id TEXT PRIMARY KEY, address TEXT NOT NULL, payload_hash TEXT NOT NULL,
      event_json TEXT NOT NULL, generated_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(address,payload_hash)
    );
    CREATE INDEX IF NOT EXISTS public_snapshot_events_address
      ON public_snapshot_events(address,created_at);`);
  }

  ensure(now = Date.now()): Event[] {
    if (!this.secretKey || !this.relays.length) return [];
    const generated: Event[] = [];
    const top = this.socialHistory.topStreaks(200).rows.map((row: any, index: number) => ({
      rank: index + 1, pubkey: row.pubkey, maxStreak: row.maxStreak,
      streak: row.streak, played: row.played, won: row.won,
      sourceEventId: row.eventId,
      latestCorrectionEventId: row.latestCorrectionEventId || null,
    }));
    const newestHistory = this.db.query("SELECT MAX(created_at) AS value FROM public_score_history").get() as { value: number | null };
    const topEvent = this.ensureSnapshot({ address: TOP_STREAKS_D, dataset: "top-streaks",
      basis: "signed-public-history", cutoff: { sourceCreatedAt: newestHistory.value || 0 }, rows: top }, now);
    if (topEvent) generated.push(topEvent);

    const dailyPeriod = getCurrentPeriodId(now) - 1;
    const cutoffMs = (dailyPeriod + 1) * PERIOD_MS + DAILY_CUTOFF_DELAY_MS;
    if (now >= cutoffMs) {
      const rows = this.db.query(`SELECT pubkey,points,result,hard_mode AS hardMode,public_event_id AS sourceEventId
        FROM game_submissions WHERE period_id=?1 AND verified_completion=1
        AND published_at IS NOT NULL AND public_event_id IS NOT NULL
        ORDER BY points DESC,result ASC,pubkey ASC`).all(dailyPeriod) as Array<Record<string, unknown>>;
      const ranked = rows.map((row, index) => ({ rank: index + 1, ...row, hardMode: Boolean(row.hardMode) }));
      const dailyEvent = this.ensureSnapshot({ address: DAILY_D(dailyPeriod), dataset: "daily-scores",
        basis: "server-verified", cutoff: { periodId: dailyPeriod, puzzle: getGameNumberForPeriod(dailyPeriod),
          date: getDateForPeriod(dailyPeriod), cutoffAt: Math.floor(cutoffMs / 1000) }, rows: ranked,
        tags: [["period", String(dailyPeriod)], ["date", getDateForPeriod(dailyPeriod)],
          ["puzzle", String(getGameNumberForPeriod(dailyPeriod))]] }, now);
      if (dailyEvent) generated.push(dailyEvent);
    }
    return generated;
  }

  private ensureSnapshot(spec: SnapshotSpec, now: number): Event | null {
    const canonical = JSON.stringify({ schema: WORD5_PUBLIC_SCHEMA, dataset: spec.dataset,
      basis: spec.basis, cutoff: spec.cutoff, rows: spec.rows });
    const payloadHash = createHash("sha256").update(canonical).digest("hex");
    const existing = this.db.query(`SELECT event_json AS eventJson FROM public_snapshot_events
      WHERE address=?1 AND payload_hash=?2`).get(spec.address, payloadHash) as { eventJson: string } | null;
    if (existing) {
      const event = JSON.parse(existing.eventJson) as Event;
      this.outbox.enqueue(event, this.relays, "word5-public-snapshot", spec.address);
      return null;
    }
    const previous = this.db.query(`SELECT MAX(created_at) AS createdAt FROM public_snapshot_events WHERE address=?1`)
      .get(spec.address) as { createdAt: number | null };
    const generatedAt = Math.floor(now / 1000);
    const createdAt = Math.max(generatedAt, (previous.createdAt || 0) + 1);
    const content = JSON.stringify({ schema: WORD5_PUBLIC_SCHEMA, dataset: spec.dataset, basis: spec.basis,
      generatedAt, cutoff: spec.cutoff, rows: spec.rows });
    const event = finalizeEvent({ kind: WORD5_PUBLIC_DATA_KIND, created_at: createdAt,
      tags: [["d", spec.address], ["t", "word5"], ["t", "word5scoreboard"],
        ["schema", WORD5_PUBLIC_SCHEMA], ["dataset", spec.dataset], ["basis", spec.basis],
        ["generated_at", String(generatedAt)], ...spec.tags || []], content }, this.secretKey!);
    this.db.query(`INSERT OR IGNORE INTO public_snapshot_events
      (event_id,address,payload_hash,event_json,generated_at,created_at) VALUES (?1,?2,?3,?4,?5,?6)`)
      .run(event.id, spec.address, payloadHash, JSON.stringify(event), generatedAt, createdAt);
    // A competing process may have inserted the same payload first. Always use
    // the stored winner, and recreate missing outbox rows after a crash.
    const stored = this.db.query(`SELECT event_json AS eventJson FROM public_snapshot_events
      WHERE address=?1 AND payload_hash=?2`).get(spec.address, payloadHash) as { eventJson: string };
    const persistedEvent = JSON.parse(stored.eventJson) as Event;
    this.outbox.enqueue(persistedEvent, this.relays, "word5-public-snapshot", spec.address);
    return persistedEvent.id === event.id ? persistedEvent : null;
  }

  async run(now = Date.now()) {
    const generated = this.ensure(now);
    return { generated: generated.map((event) => event.id), delivery: await this.outbox.flush(now) };
  }

  status() {
    return { enabled: Boolean(this.secretKey && this.relays.length), kind: WORD5_PUBLIC_DATA_KIND,
      schema: WORD5_PUBLIC_SCHEMA, serverPubkey: this.serverPubkey, outbox: this.outbox.status() };
  }
}

export function startPublicDataPublisher(publisher: PublicDataPublisher,
  schedule = (callback: () => void, delay: number) => setTimeout(callback, delay)) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try { await publisher.run(); }
    catch (error) { console.error("Word5 public data publisher failed:", error instanceof Error ? error.message : String(error)); }
    if (!stopped) timer = schedule(() => { void tick(); }, 60_000);
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}
