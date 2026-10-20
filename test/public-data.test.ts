import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools";
import { DAILY_D, PublicDataPublisher, TOP_STREAKS_D, WORD5_PUBLIC_DATA_KIND } from "../src/public-data";
import { RelayOutbox } from "../src/relay-outbox";
import { getDateForPeriod, Word5Service } from "../src/word5";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "word5-public-data-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "answers.txt"), "apple\nbrave\ncrane\n");
  const serverSecret = generateSecretKey();
  const dbPath = join(dir, "word5.sqlite");
  const service = new Word5Service({ rootDir: dir, dbPath,
    word5Nsec: Buffer.from(serverSecret).toString("hex"), relays: [], gamestrRelays: [] });
  return { service, serverSecret, dir, dbPath };
}

function publicScore(secret: Uint8Array, period: number, maxStreak: number) {
  return finalizeEvent({ kind: 1, created_at: period * 86400 + 100, tags: [["t", "word5"], ["game", "word5"],
    ["schema", "word5.score.v1"], ["period", String(period)], ["puzzle", String(period % 1000)],
    ["date", getDateForPeriod(period)], ["result", "1"], ["played", String(maxStreak + 1)],
    ["won", String(maxStreak)], ["streak", String(maxStreak)], ["maxStreak", String(maxStreak)]],
    content: `WORD5 #${period % 1000} 1/6` }, secret);
}

describe("public Word5 relay data", () => {
  test("publishes versioned addressable snapshots with explicit evidence and source IDs", () => {
    const { service, serverSecret } = fixture();
    const player = generateSecretKey();
    const period = 20_001;
    const source = publicScore(player, period, 114);
    service.socialHistory.archive(source, "test", ["wss://history.test"]);
    service.db.query(`INSERT INTO game_submissions
      (event_id,pubkey,period_id,puzzle,puzzle_date,result,points,hard_mode,guesses_json,verified_completion,published_at,public_event_id)
      VALUES (?1,?2,?3,?4,?5,'1',10,0,'[]',1,'yes',?6)`)
      .run("private-completion-id", getPublicKey(player), period, period % 1000, getDateForPeriod(period), source.id);
    const outbox = new RelayOutbox(service.db, async () => true);
    const publisher = new PublicDataPublisher(service.db, serverSecret, ["wss://a.test", "wss://b.test"], service.socialHistory, outbox);
    const now = (period + 1) * 86400000 + 21 * 60000;
    const events = publisher.ensure(now);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.kind).toBe(WORD5_PUBLIC_DATA_KIND);
      expect(event.pubkey).toBe(getPublicKey(serverSecret));
      expect(verifyEvent(event)).toBe(true);
      expect(event.tags).toContainEqual(["schema", "word5.leaderboard.v1"]);
      expect(outbox.deliveries(event.id).map((row) => row.relay)).toEqual(["wss://a.test", "wss://b.test"]);
    }
    const top = events.find((event) => event.tags.some((tag) => tag[1] === TOP_STREAKS_D))!;
    const topContent = JSON.parse(top.content);
    expect(topContent.basis).toBe("signed-public-history");
    expect(topContent.rows[0]).toMatchObject({ rank: 1, pubkey: source.pubkey, maxStreak: 114, sourceEventId: source.id });
    const daily = events.find((event) => event.tags.some((tag) => tag[1] === DAILY_D(period)))!;
    const dailyContent = JSON.parse(daily.content);
    expect(dailyContent.basis).toBe("server-verified");
    expect(dailyContent.cutoff).toMatchObject({ periodId: period, date: getDateForPeriod(period) });
    expect(dailyContent.rows[0]).toMatchObject({ rank: 1, pubkey: source.pubkey, points: 10, sourceEventId: source.id });
    expect(JSON.stringify(dailyContent)).not.toContain("private-completion-id");
    expect(publisher.ensure(now + 1000)).toEqual([]);
  });

  test("persists exact signed bytes before I/O and retries failed relays after restart", async () => {
    const { service, serverSecret } = fixture();
    const sent: Event[] = [];
    let outbox = new RelayOutbox(service.db, async (event) => { sent.push(event); return false; });
    let publisher = new PublicDataPublisher(service.db, serverSecret, ["wss://only.test"], service.socialHistory, outbox);
    const now = Date.parse("2026-10-20T00:21:00Z");
    const [event] = publisher.ensure(now);
    expect(event).toBeDefined();
    expect(outbox.deliveries(event!.id)[0].status).toBe("pending");
    expect((await outbox.flush(now)).published).toBe(0);
    outbox = new RelayOutbox(service.db, async (retried) => { sent.push(retried); return true; });
    publisher = new PublicDataPublisher(service.db, serverSecret, ["wss://only.test"], service.socialHistory, outbox);
    publisher.ensure(now + 60_000);
    expect((await outbox.flush(now + 60_000)).published).toBe(2);
    expect(sent).toHaveLength(4);
    expect(sent.slice(2).map((item) => item.id).sort()).toEqual(sent.slice(0, 2).map((item) => item.id).sort());
    expect(JSON.stringify(sent.slice(2).find((item) => item.id === event!.id))).toBe(JSON.stringify(event!));
    expect(outbox.deliveries(event!.id)[0].status).toBe("published");
  });

  test("GameStr uses the identical event ID across normal and GameStr relay sets", async () => {
    const { service, serverSecret, dir, dbPath } = fixture();
    service.relays.push("wss://word5.test");
    service.gamestrRelays.push("wss://gamestr.test", "wss://word5.test");
    const player = generateSecretKey();
    const period = Math.floor(Date.now() / 86400000);
    const source = publicScore(player, period, 2);
    service.db.query(`INSERT INTO raw_events(event_id,pubkey,kind,created_at,event_json) VALUES ('completion',?1,30078,?2,'{}')`)
      .run(source.pubkey, source.created_at);
    service.db.query(`INSERT INTO game_submissions
      (event_id,pubkey,period_id,puzzle,puzzle_date,result,points,hard_mode,guesses_json,verified_completion)
      VALUES ('completion',?1,?2,?3,?4,'1',10,0,'[]',1)`).run(source.pubkey, period, period % 1000, getDateForPeriod(period));
    const calls: Array<{ relays: string[]; events: Event[] }> = [];
    await service.markPublished(source, async (relays, events) => {
      calls.push({ relays: [...relays], events: [...events] });
      return relays.map((relay) => ({ relay, status: "ok" as const }));
    });
    const stored = service.db.query("SELECT event_id AS eventId,event_json AS eventJson FROM gamestr_scores").get() as any;
    const targets = service.relayOutbox.deliveries(stored.eventId);
    expect(targets.map((row) => row.relay)).toEqual(["wss://gamestr.test", "wss://word5.test"]);
    expect(targets.every((row) => row.status === "published")).toBe(true);
    expect(calls.at(-1)!.events[0].id).toBe(stored.eventId);
    expect(JSON.parse(stored.eventJson).pubkey).toBe(getPublicKey(serverSecret));
    service.db.query("DELETE FROM relay_event_outbox").run();
    service.db.close();
    const restarted = new Word5Service({ rootDir: dir, dbPath,
      word5Nsec: Buffer.from(serverSecret).toString("hex"), relays: ["wss://word5.test"], gamestrRelays: ["wss://gamestr.test"] });
    expect(restarted.relayOutbox.deliveries(stored.eventId).map((row) => row.relay)).toEqual(["wss://gamestr.test", "wss://word5.test"]);
  });
});
