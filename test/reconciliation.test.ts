import {describe,test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {finalizeEvent,generateSecretKey,getPublicKey} from 'nostr-tools';
import {Word5Service,getDateForPeriod,getWordForPeriod} from '../src/word5';
import {acceptedOutcomes,baselineProposal,playerReport,publicBoard} from '../src/reconciliation';
import {manifest,applyMigration,rollbackMigration,type MigrationInput} from '../src/reconciliation-migration';
function fixture(){
 const rootDir=mkdtempSync(join(tmpdir(),'word5-reconcile-'));mkdirSync(join(rootDir,'assets'));writeFileSync(join(rootDir,'assets/answers.txt'),'apple\nbrave\ncrane\n');
 const service=new Word5Service({rootDir,dbPath:':memory:',relays:[],gamestrRelays:[]});const key=generateSecretKey(),pubkey=getPublicKey(key),period=20770,now=period*86400000+200000;
 const score=(p=period,result='2',kind=1,stats:string[][]=[])=>finalizeEvent({kind,created_at:p*86400+10,tags:[['t','word5'],['period',String(p)],['puzzle',String(p%1000)],['result',result],...stats],content:''},key);
 const completion=(p=period)=>finalizeEvent({kind:30078,created_at:p*86400+100,tags:[['schema','word5.completion.v1']],content:JSON.stringify({game:'word5',periodId:p,puzzle:p%1000,date:getDateForPeriod(p),result:'1',guesses:[getWordForPeriod(service.answers,p)],hardMode:false})},key);
 return {service,key,pubkey,period,now,score,completion};
}
function preview(db:Database,input:MigrationInput){const copy=Database.deserialize(db.serialize());try{return manifest(copy,input);}finally{copy.close();}}
describe('reconciliation invariants',()=>{
 test('duplicates count once; ambiguous legacy outcomes stay unresolved; validated completion wins privately',()=>{
  const f=fixture();const a=f.score(),b=f.score(f.period,'2',5555),c=f.score(f.period,'X');
  for(const e of [a,b])f.service.socialHistory.archive(e);
  expect(acceptedOutcomes(f.service.db,f.now).outcomes).toHaveLength(1);
  f.service.socialHistory.archive(c);
  expect(acceptedOutcomes(f.service.db,f.now).outcomes).toHaveLength(0);
  expect(acceptedOutcomes(f.service.db,f.now).conflicts).toHaveLength(1);
  const before=f.service.publicPlayerHistory(f.pubkey,f.now);
  f.service.complete(f.completion(),f.now);
  expect(f.service.playerHistory(f.pubkey,f.now).stats).toMatchObject({played:1,won:1});
  expect(f.service.publicPlayerHistory(f.pubkey,f.now)).toEqual(before);
  expect(acceptedOutcomes(f.service.db,f.now,true).conflicts[0]).not.toHaveProperty('verifiedEventId');
  expect(f.service.db.query('SELECT COUNT(*) AS n FROM raw_events').get()).toEqual({n:4});
 });
 test('unpublished completion cannot change any public scores, history, baseline or board response',()=>{
  const f=fixture();f.service.socialHistory.archive(f.score(f.period-1));
  const snapshot=()=>JSON.stringify([f.service.publicPlayerHistory(f.pubkey,f.now),f.service.socialHistory.history({since:(f.period-21)*86400,until:f.now/1000,limit:100}),f.service.scores(21,false,50,f.now),publicBoard(f.service.db,21,f.now,[f.pubkey])]);
  const before=snapshot();f.service.complete(f.completion(),f.now);expect(snapshot()).toBe(before);
  const auth=(key=f.key)=>finalizeEvent({kind:30078,created_at:Math.floor(f.now/1000),tags:[['schema','word5.history-request.v1']],content:''},key);
  expect(f.service.authenticatedHistory(auth(),f.now).stats.played).toBe(2);
  expect(f.service.authenticatedHistory(auth(generateSecretKey()),f.now).stats.played).toBe(0);
  expect(()=>f.service.authenticatedHistory({...auth(),pubkey:'0'.repeat(64)},f.now)).toThrow();
  expect(()=>f.service.authenticatedHistory({...auth(),content:f.pubkey},f.now)).toThrow();
 });
 test('owner baseline156 survives incomplete history independently from counts, distribution and current run',()=>{
  const f=fixture();const input:MigrationInput={cutoff:f.now/1000,events:[f.score()],decisions:[{decisionId:'owner156',pubkey:f.pubkey,maxStreak:156,sourceEventId:null,provenance:'owner-confirmed',reason:'explicit owner confirmation fixture',effectiveAt:f.now/1000,actor:f.pubkey,reviewedAt:f.now/1000,supersedes:null}]};
  applyMigration(f.service.db,input,preview(f.service.db,input),'batch1');
  const report=f.service.playerHistory(f.pubkey,f.now,true);
  expect(report.stats).toEqual({played:1,won:1,streak:1,maxStreak:156});expect(report.distribution).toEqual([0,1,0,0,0,0]);
  expect(f.service.playerHistory(f.pubkey,f.now+3*86400000).stats).toEqual({played:1,won:1,streak:0,maxStreak:156});
  const huge=f.score(f.period+1,'1',1,[['played','900'],['won','900'],['streak','900'],['maxStreak','900']]);f.service.socialHistory.archive(huge);
  expect(f.service.playerHistory(f.pubkey,f.now+86400000).stats.maxStreak).toBe(156);
 });
 test('latest correction excludes older higher best; later downward conflicting claims require review',()=>{
  const proposal=baselineProposal([{eventId:'a',eventType:'score',createdAt:86400,streak:100,maxStreak:100},{eventId:'b',eventType:'correction',createdAt:172800,streak:1,maxStreak:2},{eventId:'c',eventType:'score',createdAt:259200,streak:2,maxStreak:4},{eventId:'d',eventType:'score',createdAt:345600,streak:1,maxStreak:3}],400000000);
  expect(proposal.candidate.eventId).toBe('d');expect(proposal.reviewRequired).toBe(true);expect(proposal.conflictingEventIds).toEqual(['c']);
 });
 test('unreviewed correction cannot reset counters or inflate accepted best',()=>{
  const f=fixture();f.service.complete(f.completion(),f.now);
  const correction=finalizeEvent({kind:5555,created_at:f.period*86400+150,tags:[['t','word5'],['schema','word5.stats.v1'],['played','900'],['won','900'],['streak','900'],['maxStreak','900']],content:''},f.key);
  f.service.socialHistory.archive(correction);expect(f.service.playerHistory(f.pubkey,f.now).stats).toEqual({played:1,won:1,streak:1,maxStreak:1});
 });
 test('reviewed transactional import is idempotent; changed preview fails atomically; rollback retains raw evidence and new completions',()=>{
  const f=fixture();const e=f.score(f.period-1);const input:MigrationInput={cutoff:f.now/1000,events:[e],decisions:[]};const reviewed=preview(f.service.db,input);
  expect(f.service.db.query('SELECT COUNT(*) AS n FROM public_score_history').get()).toEqual({n:0});
  expect(()=>applyMigration(f.service.db,input,{...reviewed,cutoff:1},'bad')).toThrow('Preview changed');
  expect(f.service.db.query('SELECT COUNT(*) AS n FROM raw_events').get()).toEqual({n:0});
  expect(applyMigration(f.service.db,input,reviewed,'b')).toEqual(reviewed);expect(applyMigration(f.service.db,input,reviewed,'b')).toEqual(reviewed);
  f.service.complete(f.completion(),f.now);rollbackMigration(f.service.db,'b');rollbackMigration(f.service.db,'b');
  expect(f.service.playerHistory(f.pubkey,f.now).stats.played).toBe(1);
  expect(f.service.db.query('SELECT COUNT(*) AS n FROM raw_events').get()).toEqual({n:2});
  expect(f.service.db.query('SELECT COUNT(*) AS n FROM game_submissions WHERE verified_completion=1').get()).toEqual({n:1});
 });
 test('rolling public windows use UTC puzzle days rather than publication time or modulo puzzle',()=>{
  const f=fixture();for(const p of [f.period-21,f.period-20,f.period])f.service.socialHistory.archive(f.score(p));
  const board=publicBoard(f.service.db,21,f.now);expect(board.rows[0]).toMatchObject({games:2,points:14});
  expect(f.service.scores(21,true,50,f.now).rows).toEqual(board.rows);
 });
 test('offline completion retry works after many days without relay acknowledgement or duplication',()=>{
  const f=fixture();const e=f.completion();expect(f.service.complete(e,f.now+40*86400000).ok).toBe(true);expect(f.service.complete(e,f.now+41*86400000).ok).toBe(true);
  expect(f.service.playerHistory(f.pubkey,f.now+41*86400000).stats.played).toBe(1);expect(f.service.scores(21,false,50,f.now).rows).toEqual([]);
 });
});

test('operator snapshot binds exact body, URL and identity; backup preserves private ledger with integrity',async()=>{
 const {ReconciliationSnapshot}=await import('../src/reconciliation-snapshot');const {createHash}=await import('node:crypto');
 const f=fixture();f.service.complete(f.completion(),f.now);const url='https://word5.test/api/reconciliation/snapshot';const operator=new ReconciliationSnapshot(f.service.db,[f.pubkey],url,'fixture-instance');
 const draft={kind:27235,created_at:Math.floor(f.now/1000),tags:[['u',url],['method','POST'],['payload',createHash('sha256').update(JSON.stringify({app:'word5',instance:'fixture-instance'})).digest('hex')],['nonce',crypto.randomUUID()]],content:''};
 const auth=finalizeEvent(draft,f.key);
 expect(()=>operator.export(auth,JSON.stringify({pubkey:f.pubkey}),f.now)).toThrow();
 expect(()=>operator.export(finalizeEvent(structuredClone(draft),generateSecretKey()),JSON.stringify({app:'word5',instance:'fixture-instance'}),f.now)).toThrow();
 expect(()=>operator.export(auth,'{\"instance\":\"fixture-instance\",\"app\":\"word5\"}',f.now)).toThrow();
 expect(()=>operator.export(auth,JSON.stringify({app:'word5',instance:'fixture-instance'})+'\n',f.now)).toThrow();
 const snapshot=operator.export(auth,JSON.stringify({app:'word5',instance:'fixture-instance'}),f.now);expect(snapshot.sha256).toBe(createHash('sha256').update(snapshot.bytes).digest('hex'));
 const copy=Database.deserialize(snapshot.bytes);expect(copy.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});expect(copy.query('SELECT COUNT(*) AS n FROM game_submissions WHERE verified_completion=1').get()).toEqual({n:1});copy.close();
 expect(()=>operator.export(auth,JSON.stringify({app:'word5',instance:'fixture-instance'}),f.now)).toThrow();
});

test('post-cutoff completion can arrive between preview and import without losing or invalidating it',()=>{
 const f=fixture();const input:MigrationInput={cutoff:f.now/1000,events:[f.score(f.period-1)],decisions:[]};const reviewed=preview(f.service.db,input);
 f.service.complete(f.completion(f.period+1),f.now+86400000);
 applyMigration(f.service.db,input,reviewed,'concurrent');expect(f.service.playerHistory(f.pubkey,f.now+86400000).stats.played).toBe(2);
 rollbackMigration(f.service.db,'concurrent');expect(f.service.playerHistory(f.pubkey,f.now+86400000).stats.played).toBe(1);
});

test('display puzzle zero at the thousand-period rollover is a valid public outcome',()=>{
 const f=fixture();f.service.socialHistory.archive(f.score(21000,'3'));
 expect(acceptedOutcomes(f.service.db,21000*86400000+30000,true).outcomes[0]).toMatchObject({periodId:21000,result:'3',points:5});
});
