import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { getCurrentPeriodId, getDateForPeriod, getWordForPeriod, Word5Service } from "../src/word5";

function fixture(relays: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "word5-completion-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "answers.txt"), "apple\nbrave\ncrane\n");
  writeFileSync(join(dir, "assets", "wla.txt"), "apple\nbrave\ncrane\nother\n");
  const dbPath = join(dir, "scores.sqlite");
  return { dir, dbPath, service: new Word5Service({ rootDir: dir, dbPath, relays, gamestrRelays: [] }) };
}

function completion(service: Word5Service, secret: Uint8Array, periodId: number, guesses?: string[], result?: string, at = periodId * 86400 + 100) {
  const answer = getWordForPeriod(service.answers, periodId);
  const words = guesses ?? [answer];
  return finalizeEvent({
    kind: 30078, pubkey: getPublicKey(secret), created_at: at,
    tags: [["schema", "word5.completion.v1"]],
    content: JSON.stringify({ game: "word5", periodId, puzzle: periodId % 1000,
      date: getDateForPeriod(periodId), result: result ?? (words.at(-1) === answer ? String(words.length) : "X"),
      guesses: words, hardMode: false }),
  }, secret);
}

function publicPost(secret: Uint8Array, periodId: number, result: string) {
  return finalizeEvent({ kind: 1, pubkey: getPublicKey(secret), created_at: periodId * 86400 + 110,
    tags: [["t", "word5"], ["schema", "word5.score.v1"], ["period", String(periodId)], ["puzzle", String(periodId % 1000)],
      ["date", getDateForPeriod(periodId)], ["result", result]],
    content: `WORD5 #${periodId % 1000} ${result}/6`,
  }, secret);
}

const player = () => generateSecretKey();
const period = getCurrentPeriodId();
const now = period * 86400000 + 200000;

describe("private completion scores", () => {
  test("requires signed ordered valid guesses and recomputes the result", () => {
    const { service } = fixture();
    const secret = player();
    const answer = getWordForPeriod(service.answers, period);
    const accepted = completion(service, secret, period, ["OTHER", answer], "2");
    expect(service.complete(accepted, now).submission.points).toBe(7);
    expect(service.scores(1, false, 50, now).rows).toHaveLength(1);
    const cases = [
      completion(service, player(), period, [], "X"),
      completion(service, player(), period, ["ZZZZZ", answer], "2"),
      completion(service, player(), period, [answer, "OTHER"], "X"),
      completion(service, player(), period, ["OTHER"], "X"),
      completion(service, player(), period, ["OTHER", answer], "1"),
    ];
    for (const event of cases) expect(() => service.complete(event, now)).toThrow();
    expect(() => service.complete({ ...accepted, content: accepted.content.replace("OTHER", "BRAVE") }, now)).toThrow();
  });

  test("rejects wrong periods and accepts only a short rollover grace", () => {
    const { service } = fixture();
    const secret = player();
    expect(() => service.complete(completion(service, secret, period + 1), now)).toThrow("period");
    expect(() => service.complete(completion(service, secret, period - 2), now)).toThrow("period");
    const old = completion(service, secret, period - 1, undefined, undefined, (period - 1) * 86400 + 86390);
    expect(service.complete(old, period * 86400000 + 30000).ok).toBe(true);
    const other = completion(service, player(), period - 1, undefined, undefined, (period - 1) * 86400 + 86390);
    expect(() => service.complete(other, period * 86400000 + 121000)).toThrow("period");
  });

  test("retry is idempotent and later improvement cannot replace the first score", () => {
    const { service } = fixture();
    const secret = player();
    const answer = getWordForPeriod(service.answers, period);
    const first = completion(service, secret, period, ["OTHER", answer], "2");
    expect(service.complete(first, now).submission.points).toBe(7);
    expect(service.complete(first, now).submission.eventId).toBe(first.id);
    expect(() => service.complete(completion(service, secret, period, [answer], "1"), now)).toThrow("already submitted");
    expect(service.scores(1, false, 50, now).rows[0]?.points).toBe(7);
  });

  test("a six-guess loss counts as a game worth zero points", () => {
    const { service } = fixture();
    const answer = getWordForPeriod(service.answers, period);
    const miss = ["APPLE", "BRAVE", "CRANE", "OTHER"].find(word => word !== answer)!;
    const event = completion(service, player(), period, Array(6).fill(miss), "X");
    expect(service.complete(event, now).submission.points).toBe(0);
    expect(service.scores(1, false, 50, now).rows[0]).toMatchObject({ games: 1, points: 0, wins: 0 });
  });

  test("all winning guess counts use the established point schedule", () => {
    const { service } = fixture();
    const answer = getWordForPeriod(service.answers, period);
    const miss = ["APPLE", "BRAVE", "CRANE", "OTHER"].find(word => word !== answer)!;
    for (const [count, points] of [[1, 10], [2, 7], [3, 5], [4, 3], [5, 2], [6, 1]]) {
      const event = completion(service, player(), period, [...Array(count - 1).fill(miss), answer], String(count));
      expect(service.complete(event, now).submission.points).toBe(points);
    }
  });

  test("publication requires a matching post and a relay acknowledgement", async () => {
    const { service } = fixture(["wss://example.test"]);
    const secret = player();
    const event = completion(service, secret, period);
    service.complete(event, now);
    const post = publicPost(secret, period, "1");
    await expect(service.markPublished(post, async () => [{ relay: "wss://example.test", status: "failed" }])).rejects.toThrow("No relay");
    expect(service.scores(1, true, 50, now).rows).toHaveLength(0);
    await expect(service.markPublished(publicPost(secret, period, "X"), async () => [])).rejects.toThrow("does not match");
    expect((await service.markPublished(post, async () => [{ relay: "wss://example.test", status: "ok" }])).published).toBe(true);
    expect(service.scores(1, true, 50, now).rows[0]?.publishedGames).toBe(1);
    expect(service.complete(event, now).submission.publishedAt).toBeTruthy();
  });

  test("private completion has no relay side effects; public confirmation may attest", async () => {
    const { dir, dbPath, service: initial } = fixture();
    initial.db.close();
    const serverKey = generateSecretKey();
    const service = new Word5Service({ rootDir: dir, dbPath, word5Nsec: Buffer.from(serverKey).toString("hex"),
      relays: ["wss://example.test"], gamestrRelays: [] });
    const secret = player();
    service.complete(completion(service, secret, period), now);
    expect(service.db.query("SELECT COUNT(*) AS count FROM word5_attestations").get()).toEqual({ count: 0 });
    const published = await service.markPublished(publicPost(secret, period, "1"), async (relays, events) =>
      events.map(() => ({ relay: relays[0] || "wss://example.test", status: "ok" as const })));
    expect(published.attestation?.kind).toBe(30078);
    expect(published.attestation?.content).not.toContain(getWordForPeriod(service.answers, period));
    expect(service.db.query("SELECT COUNT(*) AS count FROM word5_attestations").get()).toEqual({ count: 1 });
  });

  test("migrates existing rows without treating unsigned guesses as verified", () => {
    const { dir, dbPath, service } = fixture();
    service.db.close();
    const db = new Database(dbPath);
    db.exec("DROP TABLE game_submissions");
    db.exec(`CREATE TABLE game_submissions (id INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
      pubkey TEXT NOT NULL, period_id INTEGER NOT NULL, puzzle INTEGER NOT NULL, puzzle_date TEXT NOT NULL,
      result TEXT NOT NULL, points INTEGER NOT NULL, hard_mode INTEGER NOT NULL DEFAULT 0,
      guesses_json TEXT NOT NULL, stats_json TEXT, accepted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pubkey,period_id))`);
    db.query("INSERT INTO game_submissions (event_id,pubkey,period_id,puzzle,puzzle_date,result,points,guesses_json) VALUES ('legacy','legacy-player',?1,?2,?3,'1',10,'[]')")
      .run(period, period % 1000, getDateForPeriod(period));
    db.close();
    const migrated = new Word5Service({ rootDir: dir, dbPath, relays: [], gamestrRelays: [] });
    expect(migrated.db.query("SELECT verified_completion, published_at FROM game_submissions WHERE event_id='legacy'").get()).toEqual({ verified_completion: 0, published_at: null });
    expect(migrated.scores(1, false, 50, now).rows).toHaveLength(0);
  });

  test("rolling boards count puzzle periods, with stable tie ordering", () => {
    const { service } = fixture();
    const a = player(), b = player();
    for (const [secret, offset] of [[a, 0], [a, -6], [a, -20], [b, 0]] as const) {
      const p = period + offset;
      service.complete(completion(service, secret, p), p * 86400000 + 200000);
    }
    expect(service.scores(1, false, 50, now).rows).toHaveLength(2);
    expect(service.scores(7, false, 50, now).rows[0]?.games).toBe(2);
    expect(service.scores(21, false, 50, now).rows[0]?.games).toBe(3);
    const tie = service.scores(1, false, 50, now).rows as Array<{ pubkey: string }>;
    expect(tie.map(row => row.pubkey)).toEqual(tie.map(row => row.pubkey).sort());
  });
});
