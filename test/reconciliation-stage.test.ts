import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools';
import {Word5Service,getDateForPeriod,getWordForPeriod} from '../src/word5';
import {ReconciliationOperator,activateReviewedMigration,type OperatorConfig} from '../src/reconciliation-runtime/reconciliation-operator';
import {playerReport} from '../src/reconciliation-runtime/reconciliation';
import {sha256,type MigrationInput} from '../src/reconciliation-runtime/reconciliation-migration';
function fixture(legacy=false){
 const root=mkdtempSync(join(tmpdir(),'word5-ops-'));mkdirSync(join(root,'assets'));writeFileSync(join(root,'assets/answers.txt'),'apple\nbrave\ncrane\n');
 const path=join(root,'live.sqlite'),service=new Word5Service({rootDir:root,dbPath:path,relays:[],gamestrRelays:[]}),key=generateSecretKey(),operator=generateSecretKey(),pk=getPublicKey(key),actor=getPublicKey(operator),cutoff=Math.floor(Date.now()/1000)-2,period=Math.floor(cutoff/86400);
 const e=finalizeEvent({kind:1,created_at:(period-2)*86400+10,tags:[['t','word5'],['puzzle',String((period-2)%1000)],['period',String(period-2)],['result','2'],['played','10'],['won','10'],['streak','1'],['maxStreak','7']],content:''},key);service.socialHistory.archive(e);
 const input:MigrationInput={cutoff,events:[e],decisions:[{decisionId:'keep-live-best',pubkey:pk,maxStreak:7,sourceEventId:e.id,provenance:'previous-public-baseline',reason:'Reviewed preservation of existing displayed achievement',effectiveAt:cutoff,actor,reviewedAt:cutoff,supersedes:null}],preservedPublicBests:[{pubkey:pk,maxStreak:7,sourceEventId:e.id,sourceSnapshotSha256:'a'.repeat(64),capturedAt:cutoff}]};
 if(legacy){const columns=(service.db.query('PRAGMA table_info(game_submissions)').all() as any[]).map(r=>r.name);for(const col of ['observed_at_ms','completion_basis'])if(columns.includes(col))service.db.exec(`ALTER TABLE game_submissions DROP COLUMN ${col}`);for(const table of ['lifetime_best_decisions','reviewed_correction_anchors','reconciliation_batches','reconciliation_imports','reconciliation_snapshot_imports'])service.db.exec(`DROP TABLE IF EXISTS ${table}`);}
 const config:OperatorConfig={operators:[actor],instance:'primary-fixture',publicBase:'https://word5.test/',root:join(root,'reconciliation'),mode:'stage',legacyPublicBests:()=>[{pubkey:pk,maxStreak:7,eventId:e.id}]},ops=new ReconciliationOperator(service.db,config);
 const call=(route:string,fields:any,keyOverride=operator)=>{const url=config.publicBase+'api/reconciliation/'+route,raw=JSON.stringify({app:'word5',instance:config.instance,...fields});const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',url],['method','POST'],['payload',sha256(raw)],['nonce',crypto.randomUUID()]],content:''},keyOverride);return ops.handle(new Request(url,{method:'POST',headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64')},body:raw}));};
 return {root,path,service,key,operator,pk,actor,period,cutoff,e,input,config,ops,call};
}
test('old-schema snapshot stage -> reviewed startup activation preserves arriving completion, floors and idempotent restarts',async()=>{
 const f=fixture(true);const preview=await(await f.call('preview',{input:f.input})).json();expect(preview.manifest.lifetimePreservation).toEqual({compared:1,unexpectedDrops:[]});
 expect(f.service.db.query("SELECT 1 FROM sqlite_master WHERE name='lifetime_best_decisions'").get()).toBeNull();
 const staged=await(await f.call('stage',{batchId:'rollout-1',input:f.input,manifest:preview.manifest,manifestSha256:preview.manifestSha256})).json();expect(staged.inputSha256).toBe(preview.manifest.inputSha256);
 // Receipt after cutoff, as written by the exact old service schema during the staged rollout.
 const completion=finalizeEvent({kind:30078,created_at:f.cutoff+1,tags:[['schema','word5.completion.v1']],content:JSON.stringify({game:'word5',periodId:f.period,puzzle:f.period%1000,date:getDateForPeriod(f.period),result:'1',guesses:[getWordForPeriod(f.service.answers,f.period)],hardMode:false})},f.key);
 f.service.db.query('INSERT INTO raw_events(event_id,pubkey,kind,created_at,event_json) VALUES(?,?,?,?,?)').run(completion.id,f.pk,30078,completion.created_at,JSON.stringify(completion));
 f.service.db.query(`INSERT INTO game_submissions(event_id,pubkey,period_id,puzzle,puzzle_date,result,points,guesses_json,verified_completion,accepted_at) VALUES(?,?,?,?,?,'1',10,?,1,datetime(?,'unixepoch'))`).run(completion.id,f.pk,f.period,f.period%1000,getDateForPeriod(f.period),JSON.stringify([getWordForPeriod(f.service.answers,f.period)]),f.cutoff+1);
 const receipt=activateReviewedMigration(f.path,{...f.config,mode:'active'},'rollout-1');expect(receipt.batchId).toBe('rollout-1');
 expect(playerReport(f.service.db,f.pk,Date.now()+30000).stats).toMatchObject({played:2,maxStreak:7});expect(playerReport(f.service.db,f.pk,Date.now(),false,true).stats.played).toBe(1);
 expect(activateReviewedMigration(f.path,{...f.config,mode:'active'},'rollout-1',Date.now()+86400000)).toMatchObject({alreadyApplied:true});
 const active=new ReconciliationOperator(f.service.db,{...f.config,mode:'active'});f.ops.handle=active.handle.bind(active);
 const rolled=await(await f.call('rollback',{batchId:'rollout-1',inputSha256:staged.inputSha256,reason:'Reviewed fixture rollback'})).json();expect(rolled.ownerConfirmedBaselinesPreserved).toBe(true);
 expect(playerReport(f.service.db,f.pk,Date.now()+30000).stats.maxStreak).toBe(7);expect(f.service.db.query('SELECT COUNT(*) AS n FROM game_submissions WHERE verified_completion=1').get()).toEqual({n:1});f.service.db.close();
});
test('operator forbids arbitrary paths/SQL, unapproved floor drops, wrong actors and changed manifests before staging',async()=>{
 const f=fixture();await expect(f.call('preview',{input:f.input,path:'/data'})).rejects.toThrow('Unsupported');
 await expect(f.call('preview',{input:{...f.input,preservedPublicBests:[]}})).rejects.toThrow('preservation');
 await expect(f.call('preview',{input:f.input},generateSecretKey())).rejects.toThrow('authorization');
 const p=await(await f.call('preview',{input:f.input})).json();await expect(f.call('stage',{batchId:'../bad',input:f.input,manifest:p.manifest,manifestSha256:p.manifestSha256})).rejects.toThrow('batch');
 await expect(f.call('stage',{batchId:'bad',input:f.input,manifest:{...p.manifest,cutoff:0},manifestSha256:p.manifestSha256})).rejects.toThrow('hash');
 await expect(f.call('apply',{batchId:'bad',input:f.input,manifest:p.manifest,manifestSha256:p.manifestSha256})).rejects.toThrow('disabled');
 expect(f.service.db.query("SELECT name FROM sqlite_master WHERE name='lifetime_best_decisions'").get()?f.service.db.query('SELECT COUNT(*) AS n FROM lifetime_best_decisions').get():{n:0}).toEqual({n:0});f.service.db.close();
});
test('tampered persisted stage body refuses startup without partial migration',async()=>{
 const f=fixture(),p=await(await f.call('preview',{input:f.input})).json();await f.call('stage',{batchId:'tamper',input:f.input,manifest:p.manifest,manifestSha256:p.manifestSha256});
 const path=join(f.config.root,'pending/tamper.json'),record=JSON.parse(readFileSync(path,'utf8'));record.raw+='\n';writeFileSync(path,JSON.stringify(record));
 expect(()=>activateReviewedMigration(f.path,{...f.config,mode:'active'},'tamper')).toThrow('authorization');expect(f.service.db.query("SELECT name FROM sqlite_master WHERE name='lifetime_best_decisions'").get()?f.service.db.query('SELECT COUNT(*) AS n FROM lifetime_best_decisions').get():{n:0}).toEqual({n:0});f.service.db.close();
});
test('preserved live best cannot be lowered by a later conflicting public self-claim',async()=>{
 const f=fixture(),lower=finalizeEvent({kind:1,created_at:(f.period-1)*86400+10,tags:[['t','word5'],['period',String(f.period-1)],['puzzle',String((f.period-1)%1000)],['result','2'],['played','20'],['won','20'],['streak','1'],['maxStreak','3']],content:''},f.key);
 const input={...f.input,events:[f.e,lower]};const preview=await(await f.call('preview',{input})).json();expect(preview.manifest.players[0].after.report.stats.maxStreak).toBe(7);expect(preview.manifest.players[0].proposal.reviewRequired).toBe(true);
 await expect(f.call('preview',{input:{...input,decisions:[]}})).rejects.toThrow('would decrease');f.service.db.close();
});
