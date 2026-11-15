import { Database } from 'bun:sqlite';

export const CONTRACT = 'word5.calculation.v1';
export const POINTS: Record<string, number> = { '1':10, '2':7, '3':5, '4':3, '5':2, '6':1, X:0 };
export type Outcome = { eventId:string; pubkey:string; periodId:number; result:string; createdAt:number; source:string; public:boolean; points:number; evidenceIds:string[] };
export function periodFor(row:any):number {
  const posted = Math.floor(row.createdAt / 86400);
  return row.periodId ?? posted - ((posted % 1000 - row.puzzle % 1000 + 1000) % 1000);
}
export function initReconciliation(db:Database) {
  const gameColumns=db.query("PRAGMA table_info(game_submissions)").all() as {name:string}[];
  if(gameColumns.length&&!gameColumns.some(c=>c.name==='completion_basis'))db.exec("ALTER TABLE game_submissions ADD COLUMN completion_basis TEXT NOT NULL DEFAULT 'legacy-unclassified'");
  if(gameColumns.length&&!gameColumns.some(c=>c.name==='observed_at_ms'))db.exec("ALTER TABLE game_submissions ADD COLUMN observed_at_ms INTEGER");
  db.exec(`CREATE TABLE IF NOT EXISTS lifetime_best_decisions (
    decision_id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, max_streak INTEGER NOT NULL CHECK(max_streak>=0),
    source_event_id TEXT, provenance TEXT NOT NULL, reason TEXT NOT NULL, effective_at INTEGER NOT NULL,
    supersedes TEXT, batch_id TEXT, revoked_at TEXT, accepted_by TEXT, reviewed_at INTEGER, source_hash TEXT, source_created_at INTEGER);
    CREATE INDEX IF NOT EXISTS lifetime_best_player ON lifetime_best_decisions(pubkey,effective_at);
    CREATE TABLE IF NOT EXISTS reviewed_correction_anchors(event_id TEXT PRIMARY KEY,reason TEXT NOT NULL,batch_id TEXT,revoked_at TEXT,accepted_by TEXT,reviewed_at INTEGER,source_hash TEXT,source_created_at INTEGER);
    CREATE TABLE IF NOT EXISTS reconciliation_batches(batch_id TEXT PRIMARY KEY,input_sha256 TEXT NOT NULL,cutoff INTEGER NOT NULL,manifest_json TEXT NOT NULL,applied_at TEXT DEFAULT CURRENT_TIMESTAMP,rolled_back_at TEXT);
    CREATE TABLE IF NOT EXISTS reconciliation_snapshot_imports(batch_id TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(batch_id,event_id));
    CREATE TABLE IF NOT EXISTS reconciliation_imports(batch_id TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(batch_id,event_id));`);
}
/** All public evidence survives. Ambiguous legacy outcomes are excluded pending review. */
export function acceptedOutcomes(db:Database, now=Date.now(), publicOnly=false) {
  const current=Math.floor(now/86400000), groups=new Map<string,any[]>(), conflicts:any[]=[];
  const rows=db.query(`SELECT event_id AS eventId,pubkey,period_id AS periodId,puzzle,result,created_at AS createdAt,source
    FROM public_score_history WHERE event_type='score' AND created_at<=? ORDER BY created_at,event_id`).all(Math.floor(now/1000)) as any[];
  for(const row of rows) {
    const periodId=periodFor(row);
    if(!Number.isSafeInteger(periodId)||periodId<0||periodId>current||periodId%1000!==row.puzzle%1000||periodId>Math.floor(row.createdAt/86400))continue;
    const key=`${row.pubkey}:${periodId}`;groups.set(key,[...(groups.get(key)||[]),{...row,periodId}]);
  }
  const verified=(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='game_submissions'").get() ? db.query(`SELECT g.event_id AS eventId,g.pubkey,g.period_id AS periodId,g.result,r.created_at AS createdAt,
    g.published_at AS publishedAt,g.public_event_id AS publicEventId,g.completion_basis AS completionBasis FROM game_submissions g JOIN raw_events r ON r.event_id=g.event_id
    WHERE g.verified_completion=1 AND g.period_id<=? AND r.created_at<=? AND (g.observed_at_ms IS NULL OR g.observed_at_ms<=?)`).all(current,Math.floor(now/1000),now) : []) as any[];
  const verifiedMap=new Map(verified.filter(r=>!publicOnly||(r.publishedAt&&r.publicEventId)).map(r=>[`${r.pubkey}:${r.periodId}`,r]));
  const outcomes:Outcome[]=[];
  for(const key of new Set([...groups.keys(),...verifiedMap.keys()])) {
    const evidence=groups.get(key)||[], v=verifiedMap.get(key);
    const results=new Set(evidence.map(r=>r.result));
    if(results.size>1 || (v&&evidence.some(r=>r.result!==v.result))) conflicts.push({key,eventIds:evidence.map(r=>r.eventId),...(!publicOnly?{verifiedEventId:v?.eventId??null}:{}),reason:'conflicting-outcomes'});
    // Private validation never licenses publication of its different result.
    const matching=v?evidence.filter(r=>r.result===v.result):evidence;
    if(v && (!publicOnly || matching.length || v.publishedAt)) {
      outcomes.push({...v,eventId:publicOnly?(matching[0]?.eventId||v.publicEventId):v.eventId,
        createdAt:publicOnly?(matching[0]?.createdAt||v.createdAt):v.createdAt,
        source:v.completionBasis==='validated-offline-client-evidence'?'server-validated-offline':'server-verified',public:Boolean(matching.length||v.publishedAt),points:POINTS[v.result]!,evidenceIds:matching.map(r=>r.eventId)});
    } else if(!v && evidence.length && results.size===1) {
      const r=evidence[0];outcomes.push({...r,source:'signed-public-history',public:true,points:POINTS[r.result]!,evidenceIds:evidence.map(r=>r.eventId)});
    }
  }
  return {outcomes:outcomes.sort((a,b)=>a.periodId-b.periodId||a.pubkey.localeCompare(b.pubkey)),conflicts};
}
/** Latest eligible claim after the latest correction, never highest-max. It is a proposal until accepted. */
export function baselineProposal(rows:any[],now=Date.now()) {
  rows=rows.filter(r=>r.createdAt*1000<=now).sort((a,b)=>a.createdAt-b.createdAt||a.eventId.localeCompare(b.eventId));
  const correction=rows.filter(r=>r.eventType==='correction'&&r.maxStreak!==null).at(-1);
  const eligible=rows.filter(r=>r.maxStreak!==null && (!correction || r.createdAt>correction.createdAt || r.eventId===correction.eventId) &&
    (!correction || r.eventType==='correction' || r.streak<=correction.streak+Math.max(0,Math.floor(r.createdAt/86400)-Math.floor(correction.createdAt/86400))+1));
  const candidate=eligible.at(-1)??null;
  const conflicting=eligible.filter(r=>r!==candidate&&r.maxStreak>candidate?.maxStreak);
  return {candidate,correction,reviewRequired:conflicting.length>0,conflictingEventIds:conflicting.map(r=>r.eventId)};
}
export function bestDecision(db:Database,pubkey:string,now=Date.now()) {
  return db.query(`SELECT decision_id AS decisionId,max_streak AS maxStreak,source_event_id AS sourceEventId,provenance,reason,effective_at AS effectiveAt,accepted_by AS acceptedBy,reviewed_at AS reviewedAt,source_hash AS sourceHash,source_created_at AS sourceCreatedAt
    FROM lifetime_best_decisions d WHERE pubkey=?1 AND effective_at<=?2 AND revoked_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM lifetime_best_decisions successor WHERE successor.supersedes=d.decision_id AND successor.revoked_at IS NULL AND successor.effective_at<=?2)
    ORDER BY effective_at DESC,decision_id DESC LIMIT 1`).get(pubkey,Math.floor(now/1000)) as any;
}
export function publicBoard(db:Database, days:number,now=Date.now(),authors:string[]=[]) {
  const current=Math.floor(now/86400000), {outcomes,conflicts}=acceptedOutcomes(db,now,true);
  const selected=outcomes.filter(r=>r.periodId>=current-days+1&&(!authors.length||authors.includes(r.pubkey)));
  const rows=[...new Set(selected.map(r=>r.pubkey))].map(pubkey=>{
    const games=selected.filter(r=>r.pubkey===pubkey);
    return {pubkey,games:games.length,wins:games.filter(r=>r.result!=='X').length,points:games.reduce((s,r)=>s+r.points,0),lastPlayedAt:Math.max(...games.map(r=>r.createdAt)),publishedGames:games.length};
  }).sort((a,b)=>b.points-a.points||b.wins-a.wins||b.games-a.games||a.pubkey.localeCompare(b.pubkey));
  return {contract:CONTRACT,visibility:'public-only',days,startPeriod:current-days+1,endPeriod:current,rows,conflicts:conflicts.filter(c=>!authors.length||authors.some(a=>c.key.startsWith(a+':')))};
}

/** Shared owner/public statistics replay. Best baseline never seeds a current run or fabricated games. */
export function playerReport(db:Database,pubkey:string,now=Date.now(),nativeBaseline=false,publicOnly=false,projection?:ReturnType<typeof acceptedOutcomes>) {
    if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error("Invalid player pubkey");
    const current = Math.floor(now/86400000);
    const publicRows = db.query(`SELECT event_id AS eventId,event_type AS eventType,
      period_id AS periodId,puzzle,result,created_at AS createdAt,played,won,streak,max_streak AS maxStreak
      FROM public_score_history WHERE pubkey=?1 ORDER BY created_at,event_id`).all(pubkey) as any[];
    const verified = (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='game_submissions'").get() ? db.query(`SELECT g.event_id AS eventId,g.period_id AS periodId,g.result,r.created_at AS createdAt
      FROM game_submissions g JOIN raw_events r ON r.event_id=g.event_id
      WHERE g.pubkey=?1 AND g.verified_completion=1 AND (?2=0 OR g.published_at IS NOT NULL) ORDER BY g.period_id`).all(pubkey, publicOnly ? 1 : 0) : []) as any[];
    const accepted = projection ?? acceptedOutcomes(db, now, publicOnly);
    const byPeriod = new Map<number, any>(accepted.outcomes.filter(row=>row.pubkey===pubkey).map(row=>[row.periodId,row]));
    const rows = [...byPeriod.values()].sort((a, b) => a.periodId - b.periodId);
    const correction = publicRows.filter(row => row.eventType === "correction" && row.createdAt * 1000 <= now &&
      db.query("SELECT 1 FROM reviewed_correction_anchors WHERE event_id=? AND revoked_at IS NULL").get(row.eventId)).at(-1);
    const stats = correction ? { played: correction.played, won: correction.won,
      streak: correction.streak, maxStreak: correction.maxStreak } : { played: 0, won: 0, streak: 0, maxStreak: 0 };
    let lastPeriodId: number | null = null;
    const baselinePeriods = new Set<number>();
    if (correction) {
      for (const row of publicRows.filter(row => row.eventType === "score" && row.createdAt <= correction.createdAt)) {
        const posted = Math.floor(row.createdAt / 86400);
        baselinePeriods.add(row.periodId ?? posted - ((posted % 1000 - (row.puzzle % 1000) + 1000) % 1000));
      }
      for (const row of verified) if (row.createdAt <= correction.createdAt) baselinePeriods.add(row.periodId);
      const correctionPeriod = Math.floor(correction.createdAt / 86400);
      const laterSameDay = rows.some(row => row.periodId === correctionPeriod && row.createdAt > correction.createdAt);
      lastPeriodId = correctionPeriod - (laterSameDay ? 1 : 0);
    }
    // Native clients merge private outcomes with the server timeline. Preserve
    // the original correction seed so interleaved games replay from that point,
    // rather than starting from counters already advanced by public games.
    const correctionAnchor = correction ? {
      streak: correction.streak,
      maxStreak: correction.maxStreak,
      lastPeriod: lastPeriodId,
      covered: baselinePeriods.has(Math.floor(correction.createdAt / 86400))
        ? [Math.floor(correction.createdAt / 86400)] : [],
    } : null;
    for (const row of rows) {
      if (correction && (row.periodId < Math.floor(correction.createdAt/86400) || baselinePeriods.has(row.periodId) || row.createdAt <= correction.createdAt)) continue;
      stats.played++;
      if (row.result !== "X") {
        stats.won++;
        stats.streak = lastPeriodId !== null && row.periodId === lastPeriodId + 1 ? stats.streak + 1 : 1;
        stats.maxStreak = Math.max(stats.maxStreak, stats.streak);
      } else stats.streak = 0;
      lastPeriodId = row.periodId;
    }
    if (lastPeriodId === null || current - lastPeriodId > 1) stats.streak = 0;
    const lifetimeBaseline = bestDecision(db, pubkey, now);
    if (lifetimeBaseline) stats.maxStreak = Math.max(stats.maxStreak, lifetimeBaseline.maxStreak);
    return { ok: true, contract: CONTRACT, lifetimeBaseline, pubkey, periodId: current, stats, lastPeriodId,
      lastPuzzle: lastPeriodId === null ? null : lastPeriodId % 1000,
      completed: byPeriod.has(current), currentResult: byPeriod.get(current)?.result ?? null,
      ...(nativeBaseline ? {
        correctionCreatedAt: correction?.createdAt ?? null,
        correctionAnchor,
        outcomes: rows.map(row => [row.periodId, row.result === "X" ? 7 : Number(row.result)]),
        coveredPeriods: [...new Set([...rows.map(row => row.periodId), ...baselinePeriods])].sort((a,b) => a-b),
        distribution: [1,2,3,4,5,6].map(attempt => rows.filter(row => row.result === String(attempt)).length),
      } : {}),
      basis: "server-archive", correctionEventId: correction?.eventId ?? null, historyCount: rows.length };
}
