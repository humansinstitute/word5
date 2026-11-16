import { Database } from "bun:sqlite";
import { acceptedOutcomes, baselineProposal, bestDecision, playerReport, CONTRACT, initReconciliation } from "./reconciliation";
import { existsSync, readFileSync } from "node:fs";
import { getEventHash, SimplePool, validateEvent, verifyEvent, type Event } from "nostr-tools";

const SCORE_BY_RESULT: Record<string, number> = { "1": 10, "2": 7, "3": 5, "4": 3, "5": 2, "6": 1, X: 0 };
const MAX_AUTHORS = 100;
const MAX_HISTORY_LIMIT = 2000;
const MAX_WINDOW_SECONDS = 400 * 86400;
export const SOCIAL_HISTORY_SEED = "assets/word5-social-history.ndjson.gz";

export type ArchivedScore = {
  eventId: string;
  pubkey: string;
  kind: number;
  createdAt: number;
  eventType: "score" | "correction";
  puzzle: number | null;
  periodId: number | null;
  result: string;
  points: number | null;
  hardMode: boolean;
  played: number | null;
  won: number | null;
  streak: number | null;
  maxStreak: number | null;
  source: string;
  relays: string[];
};

export type HistoryQuery = { authors?: string[]; since?: number; until?: number; limit?: number };
export type RelayFetch = (relays: string[], since: number, until: number) => Promise<Event[]>;

function tagText(event: Event, name: string): string {
  const value = event.tags.find((tag) => tag[0] === name)?.[1];
  return typeof value === "string" ? value : "";
}

function integerTag(event: Event, name: string): number | null {
  const text = tagText(event, name);
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parsePuzzle(event: Event): number | null {
  const tagged = integerTag(event, "puzzle");
  if (tagged !== null) return tagged;
  const match = String(event.content || "").match(/WORD5\s*#(\d+)/i);
  const value = match ? Number(match[1]) : null;
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseResult(event: Event): string {
  const tagged = tagText(event, "result").toUpperCase();
  if (Object.hasOwn(SCORE_BY_RESULT, tagged)) return tagged;
  const match = String(event.content || "").match(/WORD5\s*#\d+\s+([1-6X])\/6/i);
  return match?.[1]?.toUpperCase() || "";
}

function isRelevant(event: Event): boolean {
  return event.tags.some((tag) => (tag[0] === "t" || tag[0] === "game") && String(tag[1] || "").toLowerCase() === "word5") ||
    tagText(event, "schema").startsWith("word5.") || /WORD5\s*#\d+/i.test(String(event.content || ""));
}

export function normalizePublicScoreEvent(event: Event, source = "relay", relays: string[] = []): ArchivedScore {
  if (!event || ![1, 5555].includes(Number(event.kind)) || !validateEvent(event) ||
      getEventHash(event) !== event.id || !verifyEvent(event)) {
    throw new Error("Invalid signed public Word5 event");
  }
  if (!isRelevant(event)) throw new Error("Event is not Word5 social history");
  const schema = tagText(event, "schema");
  const eventType = schema === "word5.stats.v1" || tagText(event, "type") === "stats-correction"
    ? "correction" : "score";
  if (schema && !["word5.score.v1", "word5.stats.v1"].includes(schema)) throw new Error("Unsupported Word5 social schema");
  const played = integerTag(event, "played");
  const won = integerTag(event, "won");
  const streak = integerTag(event, "streak");
  const maxStreak = integerTag(event, "maxStreak");
  const completeStats = [played, won, streak, maxStreak].every((value) => value !== null);
  const validStats = completeStats && won! <= played! && streak! <= maxStreak! && streak! <= won! && maxStreak! <= 100000;
  if (eventType === "correction" && !validStats) throw new Error("Missing or invalid Word5 correction stats");
  const puzzle = parsePuzzle(event);
  const result = parseResult(event);
  if (eventType === "score" && (puzzle === null || !result)) throw new Error("Unsupported Word5 score format");
  return {
    eventId: event.id, pubkey: event.pubkey, kind: event.kind, createdAt: event.created_at, eventType,
    puzzle, periodId: integerTag(event, "period"), result, points: eventType === "score" ? SCORE_BY_RESULT[result]! : null,
    hardMode: tagText(event, "hardMode") === "true", played: validStats ? played : null, won: validStats ? won : null,
    streak: validStats ? streak : null, maxStreak: validStats ? maxStreak : null,
    source, relays: [...new Set(relays.filter((relay) => /^wss:\/\//.test(relay)))].sort(),
  };
}

export function initSocialHistoryDb(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS public_score_history (
      event_id TEXT PRIMARY KEY REFERENCES raw_events(event_id), pubkey TEXT NOT NULL, kind INTEGER NOT NULL,
      created_at INTEGER NOT NULL, event_type TEXT NOT NULL, puzzle INTEGER, period_id INTEGER, result TEXT NOT NULL,
      points INTEGER, hard_mode INTEGER NOT NULL, played INTEGER, won INTEGER,
      streak INTEGER, max_streak INTEGER, source TEXT NOT NULL, relays_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS public_score_history_author_time ON public_score_history(pubkey, created_at);
    CREATE INDEX IF NOT EXISTS public_score_history_time ON public_score_history(created_at);
    CREATE TABLE IF NOT EXISTS social_history_sync_state (
      name TEXT PRIMARY KEY, cursor_created_at INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export class SocialHistory {
  constructor(readonly db: Database) { initSocialHistoryDb(db); initReconciliation(db); }

  archive(event: Event, source = "relay", relays: string[] = []): { inserted: boolean; row: ArchivedScore } {
    const row = normalizePublicScoreEvent(event, source, relays);
    const result = this.db.transaction(() => {
      this.db.query(`INSERT OR IGNORE INTO raw_events (event_id,pubkey,kind,created_at,event_json)
        VALUES (?1,?2,?3,?4,?5)`).run(event.id, event.pubkey, event.kind, event.created_at, JSON.stringify(event));
      const inserted = this.db.query(`INSERT OR IGNORE INTO public_score_history
        (event_id,pubkey,kind,created_at,event_type,puzzle,period_id,result,points,hard_mode,played,won,streak,max_streak,source,relays_json)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`)
        .run(row.eventId, row.pubkey, row.kind, row.createdAt, row.eventType, row.puzzle, row.periodId, row.result,
          row.points, row.hardMode ? 1 : 0, row.played, row.won, row.streak, row.maxStreak, row.source, JSON.stringify(row.relays));
      if (row.periodId !== null && row.played !== null) {
        this.db.query(`INSERT OR IGNORE INTO player_stats_snapshots(event_id,pubkey,period_id,stats_json)
          VALUES(?1,?2,?3,?4)`).run(row.eventId, row.pubkey, row.periodId,
            JSON.stringify({ played: row.played, won: row.won, streak: row.streak, maxStreak: row.maxStreak }));
      }
      return inserted;
    })();
    return { inserted: result.changes > 0, row };
  }

  bootstrap(seedPath: string): { imported: number; existing: number; rejected: number } {
    if (!existsSync(seedPath)) return { imported: 0, existing: 0, rejected: 0 };
    const compressed = readFileSync(seedPath);
    const text = new TextDecoder().decode(Bun.gunzipSync(compressed));
    let imported = 0, existing = 0, rejected = 0;
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as { event: Event; relays?: string[] };
        const result = this.archive(record.event, "bootstrap", record.relays || []);
        result.inserted ? imported++ : existing++;
      } catch { rejected++; }
    }
    return { imported, existing, rejected };
  }

  history(query: HistoryQuery = {}) {
    const authors = [...new Set(query.authors || [])];
    if (authors.length > MAX_AUTHORS || authors.some((author) => !/^[0-9a-f]{64}$/.test(author))) {
      throw new Error(`authors must contain at most ${MAX_AUTHORS} lowercase hex pubkeys`);
    }
    const now = Math.floor(Date.now() / 1000);
    const since = query.since ?? now - 30 * 86400;
    const until = query.until ?? now;
    if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until) || since < 0 || until < since || until - since > MAX_WINDOW_SECONDS) {
      throw new Error("history window must be valid and no longer than 400 days");
    }
    const limit = query.limit ?? 500;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) throw new Error(`limit must be 1-${MAX_HISTORY_LIMIT}`);
    const authorClause = authors.length ? `AND pubkey IN (${authors.map(() => "?").join(",")})` : "";
    const {outcomes,conflicts}=acceptedOutcomes(this.db,until*1000,true);
    const startPeriod=Math.floor(since/86400),endPeriod=Math.floor(until/86400);
    const rows=outcomes.filter(r=>r.periodId>=startPeriod&&r.periodId<=endPeriod&&(!authors.length||authors.includes(r.pubkey)))
      .sort((a,b)=>b.periodId-a.periodId||a.pubkey.localeCompare(b.pubkey)).slice(0,limit)
      .map(r=>({...r,puzzle:r.periodId%1000,relays:[]}));
    return {contract:CONTRACT,visibility:'public-only',since,until,limit,rows,conflicts};
  }

  topStreaks(limit = 50, now=Date.now()) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be 1-200");
    const players=this.db.query("SELECT DISTINCT pubkey FROM public_score_history UNION SELECT pubkey FROM lifetime_best_decisions WHERE revoked_at IS NULL").all() as any[];
    const projection=acceptedOutcomes(this.db,now,true);
    const rows=players.map(({pubkey})=>{
      const decision=bestDecision(this.db,pubkey,now);
      const evidence=this.db.query(`SELECT event_id AS eventId,created_at AS createdAt,event_type AS eventType,streak,max_streak AS maxStreak FROM public_score_history WHERE pubkey=?`).all(pubkey) as any[];
      const proposal=baselineProposal(evidence,now);
      const report=playerReport(this.db,pubkey,now,false,true,projection);
      return {pubkey,maxStreak:report.stats.maxStreak,played:report.stats.played,won:report.stats.won,streak:report.stats.streak,
        baselineMaxStreak:decision?.maxStreak??null,source:report.stats.maxStreak>(decision?.maxStreak??0)?'reconciled-public-history':decision?.provenance??'recovered-public-sequence',eventId:decision?.sourceEventId??null,decisionId:decision?.decisionId??null,
        proposedMaxStreak:proposal.candidate?.maxStreak??null,reviewRequired:!decision||proposal.reviewRequired||Boolean(proposal.candidate&&proposal.candidate.maxStreak!==decision.maxStreak&&proposal.candidate.eventId!==decision.sourceEventId),
        latestCorrectionEventId:proposal.correction?.eventId??null,relays:[]};
    }).filter(r=>r.maxStreak>0).sort((a,b)=>b.maxStreak-a.maxStreak||a.pubkey.localeCompare(b.pubkey));
    return {contract:CONTRACT,visibility:'public-only',rows:rows.slice(0,limit)};
  }

  /** Explicit operator repair uses separate per-relay cursors and never rewinds normal catch-up. */
  async repair(relays:string[],since:number,until:number,fetcher:RelayFetch=fetchRelayScores) {
    if(!Number.isSafeInteger(since)||!Number.isSafeInteger(until)||since<0||until<since)throw new Error('Invalid repair bounds');
    const results:any[]=[];
    for(const relay of relays) {
      const name=`repair:${relay}:${since}:${until}`;
      const state=this.db.query('SELECT cursor_created_at AS cursor FROM social_history_sync_state WHERE name=?').get(name) as any;
      const start=Math.max(since,state?state.cursor+1:since),end=Math.min(until,start+86400-1);
      if(start>until){results.push({relay,status:'range-queried-retention-unknown'});continue;}
      try {
        const events=await fetcher([relay],start,end);
        if(events.length>=5000){results.push({relay,start,end,status:'saturated-no-cursor-advance'});continue;}
        let imported=0,rejected=0;
        for(const event of events)try{if(event.created_at<start||event.created_at>end)throw new Error('outside repair range');if(this.archive(event,'historical-repair',[relay]).inserted)imported++;}catch{rejected++;}
        this.db.query(`INSERT INTO social_history_sync_state(name,cursor_created_at) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET cursor_created_at=excluded.cursor_created_at,updated_at=CURRENT_TIMESTAMP`).run(name,end);
        results.push({relay,start,end,imported,rejected,status:'window-queried-retention-unknown'});
      }catch{results.push({relay,start,end,status:'failed-no-cursor-advance'});}
    }
    return {since,until,results};
  }

  async catchUp(relays: string[], fetcher: RelayFetch = fetchRelayScores, now = Math.floor(Date.now() / 1000)) {
    if (!relays.length) return { fetched: 0, imported: 0, rejected: 0, cursor: null };
    let fetched=0,imported=0,rejected=0;const cursors:Record<string,number>={};
    for(const relay of relays) {
      const name=`scores:${relay}`;
      const state=this.db.query("SELECT cursor_created_at AS cursor FROM social_history_sync_state WHERE name=?").get(name) as any;
      const cursor=state?.cursor??now-7*86400;
      // Bounded per-relay windows; failed fetches never advance another relay's cursor.
      const since=Math.max(0,cursor-86400),until=Math.min(now,since+3*86400);
      try {
        const events=await fetcher([relay],since,until);fetched+=events.length;
        if(events.length>=5000)continue; // retention/completeness unknown: do not skip a full page
        for(const event of events)try {
          if(event.created_at<since||event.created_at>until)throw new Error('outside window');
          if(this.archive(event,'relay',[relay]).inserted)imported++;
        }catch{rejected++;}
        this.db.query(`INSERT INTO social_history_sync_state(name,cursor_created_at) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET cursor_created_at=MAX(cursor_created_at,excluded.cursor_created_at),updated_at=CURRENT_TIMESTAMP`).run(name,until);
        cursors[relay]=until;
      }catch{cursors[relay]=cursor;}
    }
    return {fetched,imported,rejected,cursors,coverage:'Relay completion does not establish retention; historical repair uses separate cursors.'};
  }
}

export async function fetchRelayScores(relays: string[], since: number, until: number): Promise<Event[]> {
  const pool = new SimplePool();
  try {
    return await pool.querySync(relays, { kinds: [1,5555], "#t": ["word5"], since, until, limit:5000 }, {maxWait:12_000});
  } finally { pool.close(relays); }
}
