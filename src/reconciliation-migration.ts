import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { SocialHistory, normalizePublicScoreEvent } from './social-history';
import { acceptedOutcomes, baselineProposal, bestDecision, playerReport, CONTRACT, initReconciliation } from './reconciliation';
import {getEventHash,verifyEvent,type Event} from 'nostr-tools';
export const sha256=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex');
export type Decision={decisionId:string;pubkey:string;maxStreak:number;sourceEventId:string|null;provenance:string;reason:string;effectiveAt:number;actor:string;reviewedAt:number;supersedes:string|null};
export type MigrationInput={cutoff:number;events:Event[];decisions:Decision[];correctionReviews?:{eventId:string;reason:string;actor:string;reviewedAt:number}[]};
export function validateInput(input:MigrationInput) {
  if(!Number.isSafeInteger(input.cutoff)||input.cutoff<0)throw new Error('Invalid fixed cutoff');
  const seen=new Set<string>();
  for(const e of input.events){normalizePublicScoreEvent(e,'reconciliation');if(e.created_at>input.cutoff)throw new Error('Event after cutoff');if(seen.has(e.id))throw new Error('Duplicate input event');seen.add(e.id);}
  for(const d of input.decisions){
    if(!/^[0-9a-f]{64}$/.test(d.actor)||!Number.isSafeInteger(d.reviewedAt)||d.reviewedAt<0||d.reviewedAt>input.cutoff||!/^[0-9a-f]{64}$/.test(d.pubkey)||!Number.isSafeInteger(d.maxStreak)||d.maxStreak<0||!d.reason||!d.provenance||!d.decisionId||!Number.isSafeInteger(d.effectiveAt)||d.effectiveAt>input.cutoff)throw new Error('Invalid reviewed decision');
    if(d.provenance==='self-published'&&!d.sourceEventId)throw new Error('Self-published decision requires evidence');
  }
}
export function manifest(db:Database,input:MigrationInput) {
  validateInput(input);initReconciliation(db);
  const history=new SocialHistory(db),now=input.cutoff*1000;
  const players=[...new Set([...input.events.map(e=>e.pubkey),...input.decisions.map(d=>d.pubkey),...(db.query('SELECT DISTINCT pubkey FROM game_submissions WHERE observed_at_ms IS NULL OR observed_at_ms<=?').all(now) as any[]).map(r=>r.pubkey)])].sort();
  const before=acceptedOutcomes(db,now);
  const publicBeforeProjection=acceptedOutcomes(db,now,true);
  const publicBefore=new Map(players.map(pk=>[pk,playerReport(db,pk,now,true,true,publicBeforeProjection)]));
  const beforeReports=new Map(players.map(pk=>[pk,playerReport(db,pk,now,true,false,before)]));
  const beforeBest=new Map(players.map(pk=>[pk,bestDecision(db,pk,now)]));
  const existing=new Set((db.query('SELECT event_id AS id FROM public_score_history').all() as any[]).map(r=>r.id));
  const snapshotsBefore=new Set((db.query('SELECT event_id AS id FROM player_stats_snapshots').all() as any[]).map(r=>r.id));
  const decisionsBefore=new Set((db.query('SELECT decision_id AS id FROM lifetime_best_decisions').all() as any[]).map(r=>r.id));
  const anchorsBefore=new Set((db.query('SELECT event_id AS id FROM reviewed_correction_anchors').all() as any[]).map(r=>r.id));
  const added:string[]=[];
  for(const e of input.events) {
    const existingRaw=db.query('SELECT event_json FROM raw_events WHERE event_id=?').get(e.id) as any;
    if(existingRaw){let original:any;try{original=JSON.parse(existingRaw.event_json);}catch{throw new Error('Unreadable existing raw evidence');}if(getEventHash(original)!==e.id||!verifyEvent(original))throw new Error('Existing raw evidence integrity conflict');}
    if(history.archive(e,'reconciliation').inserted)added.push(e.id);
  }
  for(const d of input.decisions) {
    if(d.sourceEventId){const r=db.query('SELECT pubkey,max_streak FROM public_score_history WHERE event_id=?').get(d.sourceEventId) as any;if(!r||r.pubkey!==d.pubkey||r.max_streak!==d.maxStreak)throw new Error('Decision does not match signed evidence');}
    const old=bestDecision(db,d.pubkey,now);
    if(old&&old.decisionId!==d.decisionId&&d.supersedes!==old.decisionId)throw new Error('Decision must explicitly supersede accepted baseline');
    const source=d.sourceEventId?db.query('SELECT created_at FROM public_score_history WHERE event_id=?').get(d.sourceEventId) as any:null;
    db.query(`INSERT OR IGNORE INTO lifetime_best_decisions(decision_id,pubkey,max_streak,source_event_id,provenance,reason,effective_at,supersedes,accepted_by,reviewed_at,source_hash,source_created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(d.decisionId,d.pubkey,d.maxStreak,d.sourceEventId,d.provenance,d.reason,d.effectiveAt,d.supersedes,d.actor,d.reviewedAt,d.sourceEventId,source?.created_at??null);
    const stored=db.query('SELECT * FROM lifetime_best_decisions WHERE decision_id=?').get(d.decisionId) as any;
    if(stored.accepted_by!==d.actor||stored.reviewed_at!==d.reviewedAt||stored.pubkey!==d.pubkey||stored.max_streak!==d.maxStreak||stored.source_event_id!==d.sourceEventId||stored.reason!==d.reason||stored.effective_at!==d.effectiveAt||stored.provenance!==d.provenance||stored.supersedes!==d.supersedes||stored.revoked_at)throw new Error('Decision ID content mismatch or revoked');
  }
  for(const r of input.correctionReviews||[]) {
    const event=db.query("SELECT created_at FROM public_score_history WHERE event_id=? AND event_type='correction'").get(r.eventId);
    if(!event||!r.reason||!/^[0-9a-f]{64}$/.test(r.actor)||!Number.isSafeInteger(r.reviewedAt)||r.reviewedAt>input.cutoff)throw new Error('Correction review requires signed correction and reason');
    db.query("INSERT OR IGNORE INTO reviewed_correction_anchors(event_id,reason,accepted_by,reviewed_at,source_hash,source_created_at) VALUES(?,?,?,?,?,?)").run(r.eventId,r.reason,r.actor,r.reviewedAt,r.eventId,(event as any).created_at);
    const stored=db.query('SELECT * FROM reviewed_correction_anchors WHERE event_id=?').get(r.eventId) as any;
    if(stored.revoked_at||stored.accepted_by!==r.actor||stored.reviewed_at!==r.reviewedAt||stored.reason!==r.reason)throw new Error('Correction approval identity mismatch or revoked');
  }
  const after=acceptedOutcomes(db,now);
  const summary=(rows:any[],pk:string)=>{const games=rows.filter(r=>r.pubkey===pk);let run=0,best=0,last:number|null=null;for(const r of games){run=r.result==='X'?0:last===r.periodId-1?run+1:1;best=Math.max(best,run);last=r.periodId;}return {games:games.length,wins:games.filter(r=>r.result!=='X').length,points:games.reduce((s,r)=>s+r.points,0),demonstratedBest:best};};
  const publicAfterProjection=acceptedOutcomes(db,now,true);
  return {contract:CONTRACT,cutoff:input.cutoff,inputSha256:sha256(JSON.stringify(input)),insertedEventIds:added,insertedDecisionIds:input.decisions.map(d=>d.decisionId).filter(id=>!decisionsBefore.has(id)),insertedAnchorIds:(input.correctionReviews||[]).map(r=>r.eventId).filter(id=>!anchorsBefore.has(id)),insertedSnapshotIds:(db.query('SELECT event_id AS id FROM player_stats_snapshots ORDER BY event_id').all() as any[]).map(r=>r.id).filter(id=>!snapshotsBefore.has(id)),existingEvents:input.events.filter(e=>existing.has(e.id)).length,
    serverVerifiedRowsPreserved:db.query('SELECT COUNT(*) AS count FROM game_submissions WHERE verified_completion=1 AND (observed_at_ms IS NULL OR observed_at_ms<=?)').get(now),
    players:players.map(pubkey=>({pubkey,publicBefore:publicBefore.get(pubkey),publicAfter:playerReport(db,pubkey,now,true,true,publicAfterProjection),before:{...summary(before.outcomes,pubkey),report:beforeReports.get(pubkey),acceptedLifetimeBest:beforeBest.get(pubkey)},after:{...summary(after.outcomes,pubkey),report:playerReport(db,pubkey,now,true,false,after),acceptedLifetimeBest:bestDecision(db,pubkey,now)},proposal:baselineProposal(db.query(`SELECT event_id AS eventId,created_at AS createdAt,event_type AS eventType,streak,max_streak AS maxStreak FROM public_score_history WHERE pubkey=?`).all(pubkey),now)})),conflicts:after.conflicts};
}
/** Preview executes on a disposable copy. Apply checks the exact reviewed before/after manifest inside one transaction. */
export function applyMigration(db:Database,input:MigrationInput,reviewed:any,batchId:string) {
  initReconciliation(db);
  return db.transaction(()=>{
    const old=db.query('SELECT input_sha256,manifest_json,rolled_back_at FROM reconciliation_batches WHERE batch_id=?').get(batchId) as any;
    if(old){if(old.input_sha256!==sha256(JSON.stringify(input))||old.rolled_back_at)throw new Error('Batch identity mismatch or rolled back');return JSON.parse(old.manifest_json);}
    const result=manifest(db,input);
    if(JSON.stringify(result)!==JSON.stringify(reviewed))throw new Error('Preview changed: regenerate and review; no rows applied');
    db.query('INSERT INTO reconciliation_batches(batch_id,input_sha256,cutoff,manifest_json) VALUES(?,?,?,?)').run(batchId,result.inputSha256,input.cutoff,JSON.stringify(result));
    for(const id of result.insertedSnapshotIds)db.query('INSERT INTO reconciliation_snapshot_imports VALUES(?,?)').run(batchId,id);
    for(const id of result.insertedEventIds)db.query('INSERT INTO reconciliation_imports VALUES(?,?)').run(batchId,id);
    for(const id of result.insertedDecisionIds)db.query('UPDATE lifetime_best_decisions SET batch_id=? WHERE decision_id=? AND batch_id IS NULL').run(batchId,id);
    for(const id of result.insertedAnchorIds)db.query('UPDATE reviewed_correction_anchors SET batch_id=? WHERE event_id=? AND batch_id IS NULL').run(batchId,id);
    return result;
  })();
}
/** Revoke decisions and remove only this batch's imported public projection, never raw evidence or completions. */
export function rollbackMigration(db:Database,batchId:string) {
  return db.transaction(()=>{
    const batch=db.query('SELECT * FROM reconciliation_batches WHERE batch_id=?').get(batchId) as any;
    if(!batch)throw new Error('Unknown batch');if(batch.rolled_back_at)return;
    db.query(`UPDATE lifetime_best_decisions SET revoked_at=CURRENT_TIMESTAMP WHERE batch_id=?`).run(batchId);
    db.query(`UPDATE reviewed_correction_anchors SET revoked_at=CURRENT_TIMESTAMP WHERE batch_id=?`).run(batchId);
    db.query(`DELETE FROM player_stats_snapshots WHERE event_id IN(SELECT event_id FROM reconciliation_snapshot_imports WHERE batch_id=?)
      AND event_id NOT IN(SELECT public_event_id FROM game_submissions WHERE public_event_id IS NOT NULL)`).run(batchId);
    db.query(`DELETE FROM public_score_history WHERE source='reconciliation' AND event_id IN(SELECT event_id FROM reconciliation_imports WHERE batch_id=?)
      AND event_id NOT IN(SELECT public_event_id FROM game_submissions WHERE public_event_id IS NOT NULL)`).run(batchId);
    db.query('UPDATE reconciliation_batches SET rolled_back_at=CURRENT_TIMESTAMP WHERE batch_id=?').run(batchId);
  })();
}
