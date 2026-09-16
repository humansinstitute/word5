import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finalizeEvent, generateSecretKey, getPublicKey, type UnsignedEvent } from "nostr-tools";
import { getCurrentPeriodId, getDateForPeriod, getWordForPeriod, Word5Service } from "../src/word5";

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "word5-server-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "answers.txt"), "apple\nbrave\ncrane\n");
  return {
    dir,
    service: new Word5Service({
      rootDir: dir,
      dbPath: join(dir, "word5.sqlite"),
    }),
  };
}

function makeServiceWithWord5Key() {
  const dir = mkdtempSync(join(tmpdir(), "word5-server-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "answers.txt"), "apple\nbrave\ncrane\n");
  return {
    dir,
    word5Secret: generateSecretKey(),
    service: null as unknown as Word5Service,
  };
}

describe("Word5 server submissions", () => {
  test("accepts a signed matching score event and stores it", async () => {
    const { service } = makeService();
    const playerSecret = generateSecretKey();
    const pubkey = getPublicKey(playerSecret);
    const periodId = getCurrentPeriodId();
    const puzzle = periodId % 1000;
    const date = getDateForPeriod(periodId);
    const answer = getWordForPeriod(service.answers, periodId);
    const content = `WORD5 #${puzzle} 1/6\n\n🟪🟪🟪🟪🟪\n\nhttps://otherstuff.ai/word5/`;
    const unsigned: UnsignedEvent = {
      kind: 1,
      pubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["t", "word5"],
        ["game", "word5"],
        ["schema", "word5.score.v1"],
        ["puzzle", String(puzzle)],
        ["period", String(periodId)],
        ["date", date],
        ["result", "1"],
      ],
      content,
    };
    const event = finalizeEvent(unsigned, playerSecret);

    const result = await service.submit({
      event,
      game: {
        periodId,
        guesses: [answer],
      },
      relays: [],
    });

    expect(result.ok).toBe(true);
    expect(result.submission.eventId).toBe(event.id);
    expect(result.submission.pubkey).toBe(pubkey);
    expect(result.attestation).toBeNull();
    expect(service.leaderboard().rows).toHaveLength(1);
  });

  test("rejects completed guesses that do not match the signed result", async () => {
    const { service } = makeService();
    const playerSecret = generateSecretKey();
    const pubkey = getPublicKey(playerSecret);
    const periodId = getCurrentPeriodId();
    const puzzle = periodId % 1000;
    const date = getDateForPeriod(periodId);
    const unsigned: UnsignedEvent = {
      kind: 1,
      pubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["t", "word5"],
        ["game", "word5"],
        ["schema", "word5.score.v1"],
        ["puzzle", String(puzzle)],
        ["period", String(periodId)],
        ["date", date],
        ["result", "1"],
      ],
      content: `WORD5 #${puzzle} 1/6`,
    };
    const event = finalizeEvent(unsigned, playerSecret);

    await expect(
      service.submit({
        event,
        game: {
          periodId,
          guesses: ["ZZZZZ", "YYYYY", "XXXXX", "WWWWW", "VVVVV", "UUUUU"],
        },
        relays: [],
      }),
    ).rejects.toThrow("Result mismatch");
  });

  test("stores signed stats and creates a GameStr verified score when Word5 nsec is configured", async () => {
    const setup = makeServiceWithWord5Key();
    setup.service = new Word5Service({
      rootDir: setup.dir,
      dbPath: join(setup.dir, "word5.sqlite"),
      word5Nsec: Buffer.from(setup.word5Secret).toString("hex"),
      relays: [],
      gamestrRelays: [],
    });
    const { service } = setup;
    const playerSecret = generateSecretKey();
    const pubkey = getPublicKey(playerSecret);
    const periodId = getCurrentPeriodId();
    const puzzle = periodId % 1000;
    const date = getDateForPeriod(periodId);
    const answer = getWordForPeriod(service.answers, periodId);
    const unsigned: UnsignedEvent = {
      kind: 1,
      pubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["t", "word5"],
        ["game", "word5"],
        ["schema", "word5.score.v1"],
        ["puzzle", String(puzzle)],
        ["period", String(periodId)],
        ["date", date],
        ["result", "1"],
        ["played", "12"],
        ["won", "10"],
        ["streak", "3"],
        ["maxStreak", "5"],
      ],
      content: `WORD5 #${puzzle} 1/6`,
    };
    const event = finalizeEvent(unsigned, playerSecret);

    const result = await service.submit({
      event,
      game: {
        periodId,
        guesses: [answer],
      },
      relays: [],
    });

    expect(result.signedStats).toEqual({ played: 12, won: 10, streak: 3, maxStreak: 5 });
    expect(result.gamestrScore?.kind).toBe(30762);
    expect(result.gamestrScore?.pubkey).toBe(getPublicKey(setup.word5Secret));
    expect(result.gamestrScore?.tags).toContainEqual(["game", "word5"]);
    expect(result.gamestrScore?.tags).toContainEqual(["score", "10"]);
    expect(result.gamestrScore?.tags).toContainEqual(["p", pubkey]);
    expect(result.gamestrScore?.tags).toContainEqual(["source_event", event.id]);

    const snapshot = service.db
      .query("SELECT event_id, pubkey, period_id, stats_json FROM player_stats_snapshots WHERE event_id = ?1")
      .get(event.id) as { event_id: string; pubkey: string; period_id: number; stats_json: string } | null;
    expect(snapshot?.pubkey).toBe(pubkey);
    expect(snapshot?.period_id).toBe(periodId);
    expect(JSON.parse(snapshot?.stats_json || "{}")).toEqual(result.signedStats);
  });
});
