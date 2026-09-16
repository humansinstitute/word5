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
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const WORD_LENGTH = 5;
const MAX_GUESSES = 6;
const ROTATION_HOURS = 24;
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
  attestation: Event | null;
  repost: Event | null;
  relayResults: Array<{ relay: string; status: "ok" | "failed"; reason?: string }>;
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
  readonly secretKey: Uint8Array | null;

  constructor(options: ServerOptions) {
    this.answers = loadAnswers(options.rootDir);
    const dbPath = options.dbPath || join(options.rootDir, "data", "word5.sqlite");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    initDb(this.db);
    this.relays = options.relays || [];
    this.secretKey = resolveSecretKey(options.word5Nsec);
  }

  getDay(now = Date.now()) {
    const periodId = getCurrentPeriodId(now);
    const date = getDateForPeriod(periodId);
    const puzzle = periodId % 1000;
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
    const relayList = Array.from(new Set([...(body.relays || []), ...this.relays].filter((relay) => /^wss:\/\//.test(relay))));
    const shouldRepost = body.repost !== false && parsed.result !== "X";
    const attestation = this.secretKey
      ? buildAttestation({ event, parsed, periodId, date, secretKey: this.secretKey })
      : null;
    const repost = this.secretKey && shouldRepost ? buildRepost(event, this.secretKey) : null;

    const insertRaw = this.db.query(`
      INSERT OR IGNORE INTO raw_events (event_id, pubkey, kind, created_at, event_json)
      VALUES (?1, ?2, ?3, ?4, ?5)
    `);
    const insertSubmission = this.db.query(`
      INSERT INTO game_submissions (
        event_id, pubkey, period_id, puzzle, puzzle_date, result, points, hard_mode, guesses_json, stats_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT(pubkey, period_id) DO UPDATE SET
        event_id = excluded.event_id,
        result = excluded.result,
        points = excluded.points,
        hard_mode = excluded.hard_mode,
        guesses_json = excluded.guesses_json,
        stats_json = excluded.stats_json,
        accepted_at = CURRENT_TIMESTAMP
    `);
    const insertAttestation = this.db.query(`
      INSERT OR REPLACE INTO word5_attestations (event_id, user_event_id, event_json)
      VALUES (?1, ?2, ?3)
    `);
    const insertRepost = this.db.query(`
      INSERT OR REPLACE INTO reposts (event_id, user_event_id, event_json)
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
        body.game?.stats ? JSON.stringify(body.game.stats) : null,
      );
      if (attestation) insertAttestation.run(attestation.id, event.id, JSON.stringify(attestation));
      if (repost) insertRepost.run(repost.id, event.id, JSON.stringify(repost));
    })();

    const publishable = [attestation, repost].filter(Boolean) as Event[];
    const relayResults = await publishEvents(relayList, publishable);
    if (relayResults.length) {
      const insertRelay = this.db.query(`
        INSERT INTO relay_publish_results (user_event_id, event_id, relay, status, reason)
        VALUES (?1, ?2, ?3, ?4, ?5)
      `);
      this.db.transaction(() => {
        for (const eventToPublish of publishable) {
          for (const result of relayResults) {
            insertRelay.run(event.id, eventToPublish.id, result.relay, result.status, result.reason || null);
          }
        }
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
      attestation,
      repost,
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
