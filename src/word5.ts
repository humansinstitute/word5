import { Database } from "bun:sqlite";
import {
  finalizeEvent,
  getEventHash,
  getPublicKey,
  nip19,
  SimplePool,
  validateEvent,
  verifyEvent,
  type Event,
  type UnsignedEvent,
} from "nostr-tools";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const WORD_LENGTH = 5;
const MAX_GUESSES = 6;
const ROTATION_HOURS = 24;
export const PERIOD_MS = ROTATION_HOURS * 60 * 60 * 1000;
const SCORE_BY_RESULT: Record<string, number> = {
  "1": 10,
  "2": 7,
  "3": 5,
  "4": 3,
  "5": 2,
  "6": 1,
  X: 0,
};

export type SubmitBody = {
  event: Event;
  game?: {
    periodId?: number;
    guesses?: string[];
    hardMode?: boolean;
    won?: boolean;
    stats?: {
      played?: number;
      won?: number;
      streak?: number;
      maxStreak?: number;
    };
  };
  relays?: string[];
  repost?: boolean;
};

export type SubmitResult = {
  ok: true;
  submission: {
    eventId: string;
    pubkey: string;
    puzzle: number;
    periodId: number;
    date: string;
    result: string;
    points: number;
    hardMode: boolean;
  };
  signedStats: SignedStats | null;
  attestation: Event | null;
  repost: Event | null;
  gamestrScore: Event | null;
  relayResults: Array<{ relay: string; status: "ok" | "failed"; reason?: string }>;
};

type SignedStats = {
  played: number;
  won: number;
  streak: number;
  maxStreak: number;
};

type ParsedWord5Event = {
  puzzle: number;
  periodId: number | null;
  date: string | null;
  result: string;
  hardMode: boolean;
};

type ServerOptions = {
  rootDir: string;
  dbPath?: string;
  word5Nsec?: string;
  relays?: string[];
  gamestrRelays?: string[];
};

function hashDate(dateStr: string): number {
  let hash = 0;
  for (let i = 0; i < dateStr.length; i++) {
    const char = dateStr.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function seededRandom(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function getCurrentPeriodId(now = Date.now()): number {
  const msPerPeriod = ROTATION_HOURS * 60 * 60 * 1000;
  return Math.floor(now / msPerPeriod);
}

export function getDateForPeriod(periodId: number): string {
  const msPerPeriod = ROTATION_HOURS * 60 * 60 * 1000;
  return new Date(periodId * msPerPeriod).toISOString().split("T")[0]!;
}

export function getGameNumberForPeriod(periodId: number): number {
  return periodId % 1000;
}

export function getWordForPeriod(answers: string[], periodId: number): string {
  if (!answers.length) throw new Error("answer list is empty");
  const dateStr = getDateForPeriod(periodId);
  const seed = hashDate(`${dateStr}_word5_daily`);
  const rng = seededRandom(seed);
  return answers[Math.floor(rng() * answers.length)]!.toUpperCase();
}

function tagValue(event: Event, name: string): string | null {
  const tag = event.tags.find((candidate) => candidate[0] === name);
  return typeof tag?.[1] === "string" ? tag[1] : null;
}

function parseEvent(event: Event): ParsedWord5Event | null {
  const hasWord5Tag = event.tags.some(
    (tag) =>
      (tag[0] === "t" && String(tag[1] || "").toLowerCase() === "word5") ||
      (tag[0] === "game" && tag[1] === "word5"),
  );
  if (!hasWord5Tag) return null;

  let puzzle = Number.parseInt(tagValue(event, "puzzle") || "", 10) || 0;
  if (!puzzle) {
    const match = event.content.match(/WORD5\s*#(\d+)/i);
    puzzle = match ? Number.parseInt(match[1]!, 10) : 0;
  }

  let result = (tagValue(event, "result") || "").toUpperCase();
  if (!result) {
    const match = event.content.match(/WORD5\s*#\d+\s+([1-6X])\/6/i);
    result = match ? match[1]!.toUpperCase() : "";
  }

  if (!puzzle || !Object.prototype.hasOwnProperty.call(SCORE_BY_RESULT, result)) {
    return null;
  }

  return {
    puzzle,
    periodId: Number.parseInt(tagValue(event, "period") || "", 10) || null,
    date: tagValue(event, "date"),
    result,
    hardMode: tagValue(event, "hardMode") === "true",
  };
}

function parseSignedStats(event: Event): SignedStats | null {
  const played = Number.parseInt(tagValue(event, "played") || "", 10);
  const won = Number.parseInt(tagValue(event, "won") || "", 10);
  const streak = Number.parseInt(tagValue(event, "streak") || "", 10);
  const maxStreak = Number.parseInt(tagValue(event, "maxStreak") || "", 10);
  const values = [played, won, streak, maxStreak];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  return { played, won, streak, maxStreak };
}

function eventIncludesSchema(event: Event): boolean {
  const schema = tagValue(event, "schema");
  return !schema || schema === "word5.score.v1";
}

function normalizeGuesses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((guess) => String(guess || "").trim().toUpperCase())
    .filter((guess) => /^[A-Z]{5}$/.test(guess))
    .slice(0, MAX_GUESSES);
}

function resolveSecretKey(nsec: string | undefined): Uint8Array | null {
  const trimmed = String(nsec || "").trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
      throw new Error("WORD5_NSEC is not a valid nsec");
    }
    return decoded.data;
  }

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Uint8Array.from(trimmed.match(/.{1,2}/g)!.map((byte) => Number.parseInt(byte, 16)));
  }

  throw new Error("WORD5_NSEC must be nsec1... or 64-char hex");
}

function loadAnswers(rootDir: string): string[] {
  const text = readFileSync(join(rootDir, "assets", "answers.txt"), "utf8");
  return text
    .split(/\r?\n/)
    .map((word) => word.trim().toUpperCase())
    .filter((word) => /^[A-Z]{5}$/.test(word));
}

function initDb(db: Database): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS raw_events (
      event_id TEXT PRIMARY KEY,
      pubkey TEXT NOT NULL,
      kind INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS game_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE REFERENCES raw_events(event_id),
      pubkey TEXT NOT NULL,
      period_id INTEGER NOT NULL,
      puzzle INTEGER NOT NULL,
      puzzle_date TEXT NOT NULL,
      result TEXT NOT NULL,
      points INTEGER NOT NULL,
      hard_mode INTEGER NOT NULL DEFAULT 0,
      guesses_json TEXT NOT NULL,
      stats_json TEXT,
      accepted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pubkey, period_id)
    );
    CREATE TABLE IF NOT EXISTS word5_attestations (
      event_id TEXT PRIMARY KEY,
      user_event_id TEXT NOT NULL UNIQUE REFERENCES raw_events(event_id),
      event_json TEXT NOT NULL,
      published_at TEXT
    );
    CREATE TABLE IF NOT EXISTS reposts (
      event_id TEXT PRIMARY KEY,
      user_event_id TEXT NOT NULL UNIQUE REFERENCES raw_events(event_id),
      event_json TEXT NOT NULL,
      published_at TEXT
    );
    CREATE TABLE IF NOT EXISTS player_stats_snapshots (
      event_id TEXT PRIMARY KEY REFERENCES raw_events(event_id),
      pubkey TEXT NOT NULL,
      period_id INTEGER NOT NULL,
      stats_json TEXT NOT NULL,
      accepted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS gamestr_scores (
      event_id TEXT PRIMARY KEY,
      user_event_id TEXT NOT NULL UNIQUE REFERENCES raw_events(event_id),
      event_json TEXT NOT NULL,
      published_at TEXT
    );
    CREATE TABLE IF NOT EXISTS relay_publish_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_event_id TEXT NOT NULL REFERENCES raw_events(event_id),
      event_id TEXT NOT NULL,
      relay TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const columns = db.query("PRAGMA table_info(game_submissions)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "published_at")) {
    db.exec("ALTER TABLE game_submissions ADD COLUMN published_at TEXT");
  }
  if (!columns.some((column) => column.name === "verified_completion")) {
    db.exec("ALTER TABLE game_submissions ADD COLUMN verified_completion INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.some((column) => column.name === "public_event_id")) {
    db.exec("ALTER TABLE game_submissions ADD COLUMN public_event_id TEXT");
  }
}

function signEvent(unsigned: UnsignedEvent, secretKey: Uint8Array): Event {
  return finalizeEvent(unsigned, secretKey);
}

function buildAttestation({
  event,
  parsed,
  periodId,
  date,
  secretKey,
}: {
  event: Event;
  parsed: ParsedWord5Event;
  periodId: number;
  date: string;
  secretKey: Uint8Array;
}): Event {
  const word5Pubkey = getPublicKey(secretKey);
  const content = [
    `Word5 verified result for ${event.id}`,
    `date: ${date}`,
    `puzzle: ${parsed.puzzle}`,
    `player: ${event.pubkey}`,
    `result: ${parsed.result}`,
  ].join("\n");
  return signEvent(
    {
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: word5Pubkey,
      tags: [
        ["d", `word5-verify-${event.id}`],
        ["t", "word5"],
        ["game", "word5"],
        ["schema", "word5.verification.v1"],
        ["e", event.id],
        ["p", event.pubkey],
        ["period", String(periodId)],
        ["date", date],
        ["puzzle", String(parsed.puzzle)],
        ["result", parsed.result],
        ["hardMode", parsed.hardMode ? "true" : "false"],
      ],
      content,
    },
    secretKey,
  );
}

function buildRepost(event: Event, secretKey: Uint8Array): Event {
  const word5Pubkey = getPublicKey(secretKey);
  return signEvent(
    {
      kind: 6,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: word5Pubkey,
      tags: [
        ["e", event.id],
        ["p", event.pubkey],
        ["t", "word5"],
        ["game", "word5"],
      ],
      content: JSON.stringify(event),
    },
    secretKey,
  );
}

function buildGamestrScore({
  event,
  parsed,
  periodId,
  date,
  points,
  signedStats,
  secretKey,
}: {
  event: Event;
  parsed: ParsedWord5Event;
  periodId: number;
  date: string;
  points: number;
  signedStats: SignedStats | null;
  secretKey: Uint8Array;
}): Event {
  const word5Pubkey = getPublicKey(secretKey);
  const tags = [
    ["d", `word5:${event.pubkey}:${periodId}`],
    ["game", "word5"],
    ["score", String(points)],
    ["p", event.pubkey],
    ["state", "active"],
    ["level", String(parsed.puzzle)],
    ["mode", parsed.hardMode ? "hard" : "normal"],
    ["difficulty", parsed.hardMode ? "hard" : "normal"],
    ["result", parsed.result],
    ["period", String(periodId)],
    ["date", date],
    ["source_event", event.id],
    ["t", "puzzle"],
    ["t", "word"],
  ];
  if (signedStats) {
    tags.push(
      ["played", String(signedStats.played)],
      ["won", String(signedStats.won)],
      ["streak", String(signedStats.streak)],
      ["maxStreak", String(signedStats.maxStreak)],
    );
  }
  return signEvent(
    {
      kind: 30762,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: word5Pubkey,
      tags,
      content: `Word5 server-authoritative score: ${points} points for puzzle ${parsed.puzzle}`,
    },
    secretKey,
  );
}

async function publishEvents(relays: string[], events: Event[]): Promise<Array<{ relay: string; status: "ok" | "failed"; reason?: string }>> {
  if (!relays.length || !events.length) return [];
  const pool = new SimplePool();
  const rows: Array<{ relay: string; status: "ok" | "failed"; reason?: string }> = [];
  try {
    for (const event of events) {
      const settled = await Promise.allSettled(pool.publish(relays, event));
      for (let i = 0; i < relays.length; i++) {
        const item = settled[i];
        rows.push({
          relay: relays[i]!,
          status: item?.status === "fulfilled" ? "ok" : "failed",
          reason: item?.status === "rejected" ? String(item.reason?.message || item.reason || "publish failed") : undefined,
        });
      }
    }
  } finally {
    try {
      pool.close(relays);
    } catch (_) {}
  }
  return rows;
}

export class Word5Service {
  readonly db: Database;
  readonly answers: string[];
  readonly relays: string[];
  readonly gamestrRelays: string[];
  readonly secretKey: Uint8Array | null;
  readonly validWords: Set<string>;

  constructor(options: ServerOptions) {
    this.answers = loadAnswers(options.rootDir);
    const wordsPath = join(options.rootDir, "assets", "wla.txt");
    this.validWords = new Set([...this.answers, ...(existsSync(wordsPath) ? readFileSync(wordsPath, "utf8").split(/\r?\n/).map((word) => word.trim().toUpperCase()) : [])]);
    const dbPath = options.dbPath || join(options.rootDir, "data", "word5.sqlite");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    initDb(this.db);
    this.relays = options.relays || [];
    this.gamestrRelays = options.gamestrRelays || ["wss://main.relay.gamestr.io"];
    this.secretKey = resolveSecretKey(options.word5Nsec);
  }

  getDay(now = Date.now()) {
    const periodId = getCurrentPeriodId(now);
    const date = getDateForPeriod(periodId);
    const puzzle = getGameNumberForPeriod(periodId);
    const word = getWordForPeriod(this.answers, periodId);
    const wordHash = new Bun.CryptoHasher("sha256").update(`${date}:${word}`).digest("hex");
    return {
      periodId,
      date,
      puzzle,
      wordHash,
      attestationEnabled: Boolean(this.secretKey),
    };
  }

  // This event is signed for identity and integrity, then sent only to this server.
  // Its answer-revealing guesses must never be published to a Nostr relay.
  complete(event: Event, now = Date.now()) {
    if (!event || !validateEvent(event) || !verifyEvent(event) || getEventHash(event) !== event.id) {
      throw new Error("Invalid signed completion event");
    }
    if (event.kind !== 30078 || tagValue(event, "schema") !== "word5.completion.v1") {
      throw new Error("Expected a private Word5 completion event");
    }
    let game: Record<string, unknown>;
    try { game = JSON.parse(event.content); } catch { throw new Error("Malformed completion payload"); }
    if (!game || typeof game !== "object" || Array.isArray(game) ||
        Object.keys(game).sort().join(",") !== "date,game,guesses,hardMode,periodId,puzzle,result" ||
        game.game !== "word5" || typeof game.hardMode !== "boolean") {
      throw new Error("Malformed completion payload");
    }
    const periodId = game.periodId as number;
    const current = getCurrentPeriodId(now);
    const eventPeriod = getCurrentPeriodId(event.created_at * 1000);
    const gracePrevious = periodId === current - 1 && now - current * 86_400_000 <= 120_000;
    if (!Number.isSafeInteger(periodId) || periodId !== eventPeriod ||
        (periodId !== current && !gracePrevious) || event.created_at * 1000 > now + 30_000) {
      throw new Error("Completion is outside the current puzzle period");
    }
    if (game.puzzle !== periodId % 1000 || game.date !== getDateForPeriod(periodId)) {
      throw new Error("Puzzle period mismatch");
    }
    if (!Array.isArray(game.guesses) || game.guesses.length < 1 || game.guesses.length > MAX_GUESSES ||
        game.guesses.some((guess) => typeof guess !== "string" || !/^[A-Z]{5}$/.test(guess) || !this.validWords.has(guess))) {
      throw new Error("Missing or invalid ordered guesses");
    }
    const target = getWordForPeriod(this.answers, periodId);
    const guesses = game.guesses as string[];
    if (guesses.slice(0, -1).includes(target)) throw new Error("Guesses continue after the answer");
    const result = guesses.at(-1) === target ? String(guesses.length) : guesses.length === MAX_GUESSES ? "X" : null;
    if (!result || game.result !== result) throw new Error("Completion result mismatch");
    const points = SCORE_BY_RESULT[result]!;
    this.db.transaction(() => {
      this.db.query(`INSERT OR IGNORE INTO raw_events (event_id,pubkey,kind,created_at,event_json) VALUES (?1,?2,?3,?4,?5)`)
        .run(event.id, event.pubkey, event.kind, event.created_at, JSON.stringify(event));
      this.db.query(`INSERT OR IGNORE INTO game_submissions
        (event_id,pubkey,period_id,puzzle,puzzle_date,result,points,hard_mode,guesses_json,verified_completion)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1)`)
        .run(event.id, event.pubkey, periodId, game.puzzle as number, game.date as string, result, points, game.hardMode ? 1 : 0, JSON.stringify(guesses));
      // A pre-upgrade public post may already occupy today's row. Upgrade it only
      // when the newly validated completion agrees with its recorded outcome.
      this.db.query(`UPDATE game_submissions SET event_id=?1, points=?2, guesses_json=?3,
        verified_completion=1, accepted_at=CURRENT_TIMESTAMP
        WHERE pubkey=?4 AND period_id=?5 AND verified_completion=0
        AND result=?6 AND hard_mode=?7`)
        .run(event.id, points, JSON.stringify(guesses), event.pubkey, periodId, result, game.hardMode ? 1 : 0);
    })();
    const row = this.db.query(`SELECT event_id AS eventId, pubkey, period_id AS periodId, result, points,
      verified_completion AS verifiedCompletion, published_at AS publishedAt FROM game_submissions
      WHERE pubkey=?1 AND period_id=?2`).get(event.pubkey, periodId) as Record<string, unknown>;
    if (row.eventId !== event.id) throw new Error("Score already submitted for this player and period");
    return { ok: true, submission: row };
  }

  async markPublished(event: Event, publish = publishEvents) {
    if (!event || !validateEvent(event) || !verifyEvent(event) || getEventHash(event) !== event.id || event.kind !== 1) {
      throw new Error("Invalid signed public Word5 post");
    }
    const parsed = parseEvent(event);
    const periodText = tagValue(event, "period");
    if (!parsed || !periodText || !/^\d+$/.test(periodText)) throw new Error("Missing public score period");
    const periodId = Number(periodText);
    const row = this.db.query(`SELECT event_id AS eventId, result, hard_mode AS hardMode, published_at AS publishedAt
      FROM game_submissions WHERE pubkey=?1 AND period_id=?2 AND verified_completion=1`)
      .get(event.pubkey, periodId) as { eventId: string; result: string; hardMode: number; publishedAt: string | null } | null;
    if (!row || tagValue(event, "schema") !== "word5.score.v1" || parsed.puzzle !== periodId % 1000 ||
        parsed.date !== getDateForPeriod(periodId) || parsed.result !== row.result || parsed.hardMode !== Boolean(row.hardMode)) {
      throw new Error("Public post does not match a completed score");
    }
    if (row.publishedAt) return { ok: true, published: true, eventId: event.id };
    if (!this.relays.length) throw new Error("No score publication relays configured");
    const results = await publish(this.relays, [event]);
    if (!results.some((result) => result.status === "ok" || /duplicate|already exists/i.test(result.reason || ""))) {
      throw new Error("No relay confirmed the public post");
    }
    const update = this.db.query(`UPDATE game_submissions SET published_at=CURRENT_TIMESTAMP, public_event_id=?1
      WHERE pubkey=?2 AND period_id=?3 AND verified_completion=1 AND published_at IS NULL`)
      .run(event.id, event.pubkey, periodId);
    if (update.changes === 0) return { ok: true, published: true, eventId: event.id };
    // Only a confirmed public post may trigger server-signed relay side effects.
    let attestation: Event | null = null;
    if (this.secretKey) {
      const date = getDateForPeriod(periodId);
      const signedStats = parseSignedStats(event);
      attestation = buildAttestation({ event, parsed, periodId, date, secretKey: this.secretKey });
      const repost = parsed.result !== "X" ? buildRepost(event, this.secretKey) : null;
      const gamestr = buildGamestrScore({ event, parsed, periodId, date,
        points: SCORE_BY_RESULT[parsed.result]!, signedStats, secretKey: this.secretKey });
      this.db.transaction(() => {
        this.db.query(`INSERT OR IGNORE INTO raw_events (event_id,pubkey,kind,created_at,event_json) VALUES (?1,?2,?3,?4,?5)`)
          .run(event.id, event.pubkey, event.kind, event.created_at, JSON.stringify(event));
        this.db.query(`INSERT OR IGNORE INTO word5_attestations (event_id,user_event_id,event_json) VALUES (?1,?2,?3)`)
          .run(attestation!.id, event.id, JSON.stringify(attestation));
        if (repost) this.db.query(`INSERT OR IGNORE INTO reposts (event_id,user_event_id,event_json) VALUES (?1,?2,?3)`)
          .run(repost.id, event.id, JSON.stringify(repost));
        this.db.query(`INSERT OR IGNORE INTO gamestr_scores (event_id,user_event_id,event_json) VALUES (?1,?2,?3)`)
          .run(gamestr.id, event.id, JSON.stringify(gamestr));
        if (signedStats) this.db.query(`INSERT OR IGNORE INTO player_stats_snapshots (event_id,pubkey,period_id,stats_json) VALUES (?1,?2,?3,?4)`)
          .run(event.id, event.pubkey, periodId, JSON.stringify(signedStats));
      })();
      try {
        await publish(this.relays, [attestation, ...(repost ? [repost] : [])]);
        await publish(this.gamestrRelays, [gamestr]);
      } catch (error) {
        console.warn("Word5 public score relay side effect failed:", error);
      }
    }
    return { ok: true, published: true, eventId: event.id, attestation };
  }

  scores(days: 1 | 7 | 21 = 7, publishedOnly = false, limit = 50, now = Date.now()) {
    const current = getCurrentPeriodId(now);
    const rows = this.db.query(`SELECT pubkey, COUNT(*) AS games, SUM(points) AS points,
      SUM(CASE WHEN result!='X' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN published_at IS NOT NULL THEN 1 ELSE 0 END) AS publishedGames
      FROM game_submissions WHERE verified_completion=1 AND period_id BETWEEN ?1 AND ?2
      AND (?3=0 OR published_at IS NOT NULL)
      GROUP BY pubkey ORDER BY points DESC, wins DESC, games DESC, pubkey ASC LIMIT ?4`)
      .all(current - days + 1, current, publishedOnly ? 1 : 0, Math.max(1, Math.min(200, limit)));
    return { days, publishedOnly, rows };
  }

  validateSubmission(body: SubmitBody): {
    event: Event;
    parsed: ParsedWord5Event;
    periodId: number;
    date: string;
    guesses: string[];
  } {
    const event = body?.event;
    if (!event || typeof event !== "object") throw new Error("Missing signed nostr event");
    if (!validateEvent(event) || !verifyEvent(event)) throw new Error("Invalid nostr event signature");
    if (getEventHash(event) !== event.id) throw new Error("Nostr event id does not match event body");
    if (event.kind !== 1 && event.kind !== 5555) throw new Error("Word5 only accepts kind 1 or kind 5555 score events");
    if (!eventIncludesSchema(event)) throw new Error("Unsupported Word5 score schema");

    const parsed = parseEvent(event);
    if (!parsed) throw new Error("Event is not a valid Word5 score event");

    const periodId = Number(body.game?.periodId || parsed.periodId || getCurrentPeriodId());
    const date = getDateForPeriod(periodId);
    const puzzle = periodId % 1000;
    if (parsed.puzzle !== puzzle) throw new Error(`Puzzle mismatch: expected ${puzzle}`);
    if (parsed.date && parsed.date !== date) throw new Error(`Puzzle date mismatch: expected ${date}`);

    const guesses = normalizeGuesses(body.game?.guesses);
    if (guesses.length) {
      const target = getWordForPeriod(this.answers, periodId);
      const won = guesses[guesses.length - 1] === target;
      const expectedResult = won ? String(guesses.length) : guesses.length >= MAX_GUESSES ? "X" : "";
      if (!expectedResult) throw new Error("Submitted guesses do not complete the puzzle");
      if (expectedResult !== parsed.result) throw new Error(`Result mismatch: expected ${expectedResult}`);
    }

    return { event, parsed, periodId, date, guesses };
  }

  async submit(body: SubmitBody): Promise<SubmitResult> {
    const { event, parsed, periodId, date, guesses } = this.validateSubmission(body);
    const previous = this.db.query("SELECT event_id FROM game_submissions WHERE pubkey=?1 AND period_id=?2")
      .get(event.pubkey, periodId) as { event_id: string } | null;
    if (previous && previous.event_id !== event.id) throw new Error("Score already submitted for this player and period");
    const relayList = Array.from(new Set([...(body.relays || []), ...this.relays].filter((relay) => /^wss:\/\//.test(relay))));
    const gamestrRelayList = Array.from(new Set([...this.gamestrRelays, ...relayList].filter((relay) => /^wss:\/\//.test(relay))));
    const signedStats = parseSignedStats(event);
    const statsForStorage = signedStats || body.game?.stats || null;
    const shouldRepost = body.repost !== false && parsed.result !== "X";
    const points = SCORE_BY_RESULT[parsed.result];
    const attestation = this.secretKey
      ? buildAttestation({ event, parsed, periodId, date, secretKey: this.secretKey })
      : null;
    const repost = this.secretKey && shouldRepost ? buildRepost(event, this.secretKey) : null;
    const gamestrScore = this.secretKey
      ? buildGamestrScore({ event, parsed, periodId, date, points, signedStats, secretKey: this.secretKey })
      : null;

    const insertRaw = this.db.query(`
      INSERT OR IGNORE INTO raw_events (event_id, pubkey, kind, created_at, event_json)
      VALUES (?1, ?2, ?3, ?4, ?5)
    `);
    const insertSubmission = this.db.query(`
      INSERT INTO game_submissions (
        event_id, pubkey, period_id, puzzle, puzzle_date, result, points, hard_mode, guesses_json, stats_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT(pubkey, period_id) DO NOTHING
    `);
    const insertAttestation = this.db.query(`
      INSERT OR REPLACE INTO word5_attestations (event_id, user_event_id, event_json)
      VALUES (?1, ?2, ?3)
    `);
    const insertRepost = this.db.query(`
      INSERT OR REPLACE INTO reposts (event_id, user_event_id, event_json)
      VALUES (?1, ?2, ?3)
    `);
    const insertStatsSnapshot = this.db.query(`
      INSERT OR REPLACE INTO player_stats_snapshots (event_id, pubkey, period_id, stats_json)
      VALUES (?1, ?2, ?3, ?4)
    `);
    const insertGamestrScore = this.db.query(`
      INSERT OR REPLACE INTO gamestr_scores (event_id, user_event_id, event_json)
      VALUES (?1, ?2, ?3)
    `);

    this.db.transaction(() => {
      insertRaw.run(event.id, event.pubkey, event.kind, event.created_at, JSON.stringify(event));
      insertSubmission.run(
        event.id,
        event.pubkey,
        periodId,
        parsed.puzzle,
        date,
        parsed.result,
        SCORE_BY_RESULT[parsed.result],
        parsed.hardMode ? 1 : 0,
        JSON.stringify(guesses),
        statsForStorage ? JSON.stringify(statsForStorage) : null,
      );
      if (attestation) insertAttestation.run(attestation.id, event.id, JSON.stringify(attestation));
      if (repost) insertRepost.run(repost.id, event.id, JSON.stringify(repost));
      if (signedStats) insertStatsSnapshot.run(event.id, event.pubkey, periodId, JSON.stringify(signedStats));
      if (gamestrScore) insertGamestrScore.run(gamestrScore.id, event.id, JSON.stringify(gamestrScore));
    })();

    const word5Publishable = [attestation, repost].filter(Boolean) as Event[];
    const gamestrPublishable = [gamestrScore].filter(Boolean) as Event[];
    const word5RelayResults = await publishEvents(relayList, word5Publishable);
    const gamestrRelayResults = await publishEvents(gamestrRelayList, gamestrPublishable);
    const relayResults = [...word5RelayResults, ...gamestrRelayResults];
    if (relayResults.length) {
      const insertRelay = this.db.query(`
        INSERT INTO relay_publish_results (user_event_id, event_id, relay, status, reason)
        VALUES (?1, ?2, ?3, ?4, ?5)
      `);
      this.db.transaction(() => {
        const insertBatch = (events: Event[], results: Array<{ relay: string; status: "ok" | "failed"; reason?: string }>) => {
          for (const eventToPublish of events) {
            for (const result of results) {
              insertRelay.run(event.id, eventToPublish.id, result.relay, result.status, result.reason || null);
            }
          }
        };
        insertBatch(word5Publishable, word5RelayResults);
        insertBatch(gamestrPublishable, gamestrRelayResults);
      })();
    }

    return {
      ok: true,
      submission: {
        eventId: event.id,
        pubkey: event.pubkey,
        puzzle: parsed.puzzle,
        periodId,
        date,
        result: parsed.result,
        points: SCORE_BY_RESULT[parsed.result],
        hardMode: parsed.hardMode,
      },
      signedStats,
      attestation,
      repost,
      gamestrScore,
      relayResults,
    };
  }

  leaderboard(limit = 50) {
    const rows = this.db
      .query(
        `
        SELECT pubkey, COUNT(*) AS games, SUM(points) AS points,
               SUM(CASE WHEN result != 'X' THEN 1 ELSE 0 END) AS wins,
               MAX(accepted_at) AS lastAcceptedAt
        FROM game_submissions
        GROUP BY pubkey
        ORDER BY points DESC, wins DESC, games DESC, lastAcceptedAt ASC
        LIMIT ?1
      `,
      )
      .all(Math.max(1, Math.min(200, limit)));
    return { rows };
  }
}
