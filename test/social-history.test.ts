import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools";
import { SocialHistory } from "../src/social-history";
import { Word5Service } from "../src/word5";

function database() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE raw_events(event_id TEXT PRIMARY KEY,pubkey TEXT NOT NULL,kind INTEGER NOT NULL,
    created_at INTEGER NOT NULL,event_json TEXT NOT NULL,received_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE player_stats_snapshots(event_id TEXT PRIMARY KEY REFERENCES raw_events(event_id),pubkey TEXT NOT NULL,
    period_id INTEGER NOT NULL,stats_json TEXT NOT NULL,accepted_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
  return db;
}

function score(secret: Uint8Array, createdAt: number, puzzle: number, maxStreak: number, options: {
  streak?: number; played?: number; won?: number; correction?: boolean; schema?: string; period?: number; result?: string; date?: string;
} = {}): Event {
  const played = options.played ?? Math.max(maxStreak, 20);
  const won = options.won ?? played;
  const streak = options.streak ?? maxStreak;
  const correction = options.correction || false;
  const tags = [
    ["t", "word5"], ["puzzle", String(puzzle)], ["played", String(played)], ["won", String(won)],
    ["streak", String(streak)], ["maxStreak", String(maxStreak)],
  ];
  if (options.period !== undefined) tags.push(["period", String(options.period)]);
  if (options.date) tags.push(["date", options.date]);
  const result = options.result ?? "3";
  if (correction) tags.push(["schema", "word5.stats.v1"], ["type", "stats-correction"]);
  else tags.push(["schema", options.schema ?? "word5.score.v1"], ["result", result]);
  return finalizeEvent({ kind: 1, pubkey: getPublicKey(secret), created_at: createdAt, tags,
    content: correction ? "Word5 stats correction" : `WORD5 #${puzzle} ${result}/6` }, secret);
}

describe("server-backed social history", () => {
  test("bootstraps the signed one-year seed idempotently and recovers Daniel at 114", () => {
    const rootDir = resolve(import.meta.dir, "..");
    const dbPath = join(mkdtempSync(join(tmpdir(), "word5-seed-")), "word5.sqlite");
    const first = new Word5Service({ rootDir, dbPath, relays: [], gamestrRelays: [] });
    expect(first.bootstrapResult).toEqual({ imported: 1793, existing: 0, rejected: 0 });
    const daniel = first.socialHistory.topStreaks(200).rows.find((row: any) => row.pubkey === "ee6ea13ab9fe5c4a68eaf9b1a34fe014a66b40117c50ee2a614f4cda959b6e74");
    expect(daniel).toMatchObject({
      pubkey: "ee6ea13ab9fe5c4a68eaf9b1a34fe014a66b40117c50ee2a614f4cda959b6e74",
      maxStreak: 114,
      eventId: "8071c8522dd3a5b746ecf67e54b5226850f482ec4ccb9de2414759139cc7fba0",
    });
    first.db.close();
    const second = new Word5Service({ rootDir, dbPath, relays: [], gamestrRelays: [] });
    expect(second.bootstrapResult).toEqual({ imported: 0, existing: 1793, rejected: 0 });
    expect(second.db.query("SELECT COUNT(*) AS count FROM public_score_history").get()).toEqual({ count: 1793 });
  }, 15_000);

  test("validates signatures and schemas before archival", () => {
    const history = new SocialHistory(database());
    const valid = score(generateSecretKey(), 1000, 1, 2);
    expect(history.archive(valid).inserted).toBe(true);
    expect(() => history.archive({ ...valid, content: `${valid.content}!` })).toThrow("Invalid signed");
    const unsupported = score(generateSecretKey(), 1001, 2, 2, { schema: "word5.score.v2" });
    expect(() => history.archive(unsupported)).toThrow("Unsupported");
  });

  test("applies latest correction semantics before selecting each historical maximum", () => {
    const history = new SocialHistory(database());
    const secret = generateSecretKey();
    history.archive(score(secret, 1000, 10, 50, { streak: 50, played: 60, won: 55 }));
    const correction = score(secret, 2000, 20, 2, { correction: true, streak: 2 });
    history.archive(correction);
    history.archive(score(secret, 3000, 21, 40, { streak: 20, played: 50, won: 45 }));
    const plausible = score(secret, 4000, 30, 12, { streak: 3 });
    history.archive(plausible);
    expect(history.topStreaks().rows[0]).toMatchObject({
      maxStreak: 12, eventId: plausible.id, latestCorrectionEventId: correction.id,
    });
  });

  test("filters history by author and time and enforces bounds", () => {
    const history = new SocialHistory(database());
    const first = generateSecretKey(), second = generateSecretKey();
    const a = score(first, 1000, 1, 2), b = score(first, 2000, 2, 3), c = score(second, 2000, 2, 4);
    for (const event of [a, b, c]) history.archive(event);
    expect(history.history({ authors: [a.pubkey], since: 1500, until: 2500, limit: 10 }).rows.map((row: any) => row.eventId)).toEqual([b.id]);
    expect(() => history.history({ since: 0, until: 401 * 86400 })).toThrow("400 days");
    expect(() => history.history({ authors: Array.from({ length: 101 }, (_, index) => index.toString(16).padStart(64, "0")) })).toThrow("at most 100");
    expect(() => history.history({ limit: 2001 })).toThrow("1-2000");
  });

  test("catch-up dedupes overlap and resumes from its persisted cursor after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "word5-catchup-"));
    const path = join(dir, "history.sqlite");
    let db = new Database(path);
    db.exec(`CREATE TABLE raw_events(event_id TEXT PRIMARY KEY,pubkey TEXT NOT NULL,kind INTEGER NOT NULL,
      created_at INTEGER NOT NULL,event_json TEXT NOT NULL,received_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE player_stats_snapshots(event_id TEXT PRIMARY KEY REFERENCES raw_events(event_id),pubkey TEXT NOT NULL,
      period_id INTEGER NOT NULL,stats_json TEXT NOT NULL,accepted_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
    let history = new SocialHistory(db);
    const event = score(generateSecretKey(), 10_000, 10, 4);
    const calls: number[] = [];
    const fetcher = async (_relays: string[], since: number) => { calls.push(since); return [event]; };
    expect(await history.catchUp(["wss://relay.test"], fetcher, 11_000)).toMatchObject({ imported: 1, cursor: 10_000 });
    db.close();
    db = new Database(path);
    history = new SocialHistory(db);
    expect(await history.catchUp(["wss://relay.test"], fetcher, 12_000)).toMatchObject({ imported: 0, cursor: 10_000 });
    expect(calls[1]).toBe(Math.max(0, 10_000 - 2 * 86400));
    expect(db.query("SELECT COUNT(*) AS count FROM public_score_history").get()).toEqual({ count: 1 });
  });

  test("archives a confirmed publication and valid snapshot without a server signer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "word5-publication-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "answers.txt"), "apple\nbrave\ncrane\n");
    const service = new Word5Service({ rootDir: dir, dbPath: join(dir, "word5.sqlite"), relays: ["wss://relay.test"], gamestrRelays: [] });
    const secret = generateSecretKey();
    const period = Math.floor(Date.now() / 86400000);
    // Use the service's deterministic answer rather than relying on fixture order.
    const actual = (await import("../src/word5")).getWordForPeriod(service.answers, period);
    const completion = finalizeEvent({ kind: 30078, pubkey: getPublicKey(secret), created_at: period * 86400 + 100,
      tags: [["schema", "word5.completion.v1"]], content: JSON.stringify({ game: "word5", periodId: period,
        puzzle: period % 1000, date: new Date(period * 86400000).toISOString().slice(0, 10), result: "1", guesses: [actual], hardMode: false }) }, secret);
    service.complete(completion, period * 86400000 + 200000);
    const post = score(secret, period * 86400 + 110, period % 1000, 7, { streak: 3, period, result: "1",
      date: new Date(period * 86400000).toISOString().slice(0, 10) });
    await service.markPublished(post, async () => [{ relay: "wss://relay.test", status: "ok" }]);
    expect(service.secretKey).toBeNull();
    expect(service.db.query("SELECT COUNT(*) AS count FROM public_score_history").get()).toEqual({ count: 1 });
    expect(service.db.query("SELECT COUNT(*) AS count FROM player_stats_snapshots").get()).toEqual({ count: 1 });
  });
});
