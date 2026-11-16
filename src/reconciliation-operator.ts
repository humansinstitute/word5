import {Database} from 'bun:sqlite';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,chmodSync} from 'node:fs';
import {join,dirname} from 'node:path';
import type {Event} from 'nostr-tools';
import {OperatorAuthorization,readOperatorRequest,operatorHash} from './operator-authorization';
import {ReconciliationSnapshot} from './reconciliation-snapshot';
import {manifest,applyMigration,rollbackMigration,sha256,type MigrationInput} from './reconciliation-migration';
const batchPattern=/^[a-zA-Z0-9_-]{1,80}$/;
function exact(body:any,fields:string[]){if(Object.keys(body).sort().join(',')!==[...fields,'app','instance'].sort().join(','))throw new Error('Unsupported operator fields');}
function batchId(id:unknown):string{if(typeof id!=='string'||!batchPattern.test(id))throw new Error('Invalid batch identity');return id;}
function privateWrite(path:string,text:string|Uint8Array){writeFileSync(path,text,{flag:'wx',mode:0o600});}
function backup(db:Database,root:string,id:string){mkdirSync(join(root,'backups'),{recursive:true,mode:0o700});const path=join(root,'backups',`${id}-${Date.now()}-${crypto.randomUUID()}.sqlite`);db.query('VACUUM INTO ?').run(path);chmodSync(path,0o600);const digest=sha256(readFileSync(path));privateWrite(path+'.sha256',digest+'\n');return {path,sha256:digest};}
function hasBatch(db:Database,id:string){if(!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reconciliation_batches'").get())return null;return db.query('SELECT batch_id,input_sha256,rolled_back_at FROM reconciliation_batches WHERE batch_id=?').get(id) as any;}
export type OperatorConfig={operators:string[];instance:string;publicBase:string;root:string;mode:'stage'|'active';legacyPublicBests?:()=>{pubkey:string;maxStreak:number;eventId:string}[]};
type StageRecord={schema:string;event:Event;raw:string;stagedAt:number;inputSha256:string;manifestSha256:string};
export class ReconciliationOperator {
  private auth=new Map<string,OperatorAuthorization>();
  constructor(readonly db:Database,readonly config:OperatorConfig){}
  private authorization(path:string){if(!this.auth.has(path))this.auth.set(path,new OperatorAuthorization(this.config.operators,`${this.config.publicBase}${path.slice(1)}`,this.config.instance));return this.auth.get(path)!;}
  private preview(input:MigrationInput){
    if(this.config.legacyPublicBests)for(const floor of this.config.legacyPublicBests())if(!(input.preservedPublicBests||[]).some(p=>p.pubkey===floor.pubkey&&p.maxStreak>=floor.maxStreak))throw new Error('Live displayed lifetime baseline missing from preservation manifest');
    mkdirSync(this.config.root,{recursive:true,mode:0o700});const dir=mkdtempSync(join(this.config.root,'preview-'));const path=join(dir,'snapshot.sqlite');
    try{this.db.query('VACUUM INTO ?').run(path);chmodSync(path,0o600);const snapshotSha256=sha256(readFileSync(path)),copy=new Database(path);try{if((copy.query('PRAGMA integrity_check').get() as any).integrity_check!=='ok')throw new Error('Snapshot integrity failure');const result=copy.transaction(()=>manifest(copy,input))();return {manifest:result,manifestSha256:sha256(JSON.stringify(result)),snapshotSha256};}finally{copy.close();}}finally{rmSync(dir,{recursive:true,force:true});}
  }
  async handle(req:Request,now=Date.now()) {
    const path=new URL(req.url).pathname;
    const {event,raw}=await readOperatorRequest(req,path.endsWith('/snapshot')?1024:20_000_000);
    const body=this.authorization(path).authorize(event,raw,now);
    if(path==='/api/reconciliation/snapshot'){
      exact(body,[]);const snapshot=new ReconciliationSnapshot(this.db,this.config.operators,`${this.config.publicBase}api/reconciliation/snapshot`,this.config.instance).export(event,raw,now);
      return new Response(snapshot.bytes,{headers:{'content-type':'application/vnd.sqlite3','cache-control':'no-store','x-word5-sha256':snapshot.sha256,'x-word5-capture-started-at':String(snapshot.captureStartedAt),'x-word5-capture-finished-at':String(snapshot.captureFinishedAt)}});
    }
    if(path==='/api/reconciliation/preview'){exact(body,['input']);return Response.json({ok:true,...this.preview(body.input)},{headers:{'cache-control':'no-store'}});}
    if(path==='/api/reconciliation/stage'||path==='/api/reconciliation/apply'){
      exact(body,['batchId','input','manifest','manifestSha256']);const id=batchId(body.batchId);
      if(sha256(JSON.stringify(body.manifest))!==body.manifestSha256||body.manifest.inputSha256!==sha256(JSON.stringify(body.input)))throw new Error('Reviewed hash mismatch');
      if([...body.input.decisions,...(body.input.correctionReviews||[])].some((d:any)=>d.actor!==event.pubkey))throw new Error('Reviewer actor mismatch');
      if(path.endsWith('/apply')){if(this.config.mode!=='active')throw new Error('Direct apply disabled during snapshot stage');const saved=backup(this.db,this.config.root,id);const result=applyMigration(this.db,body.input,body.manifest,id);return Response.json({ok:true,batchId:id,backup:saved,inputSha256:result.inputSha256},{headers:{'cache-control':'no-store'}});}
      const current=this.preview(body.input);if(JSON.stringify(current.manifest)!==JSON.stringify(body.manifest))throw new Error('Reviewed preview changed; regenerate before staging');
      mkdirSync(join(this.config.root,'pending'),{recursive:true,mode:0o700});const pendingPath=join(this.config.root,'pending',id+'.json');
      if(existsSync(pendingPath)){const old=JSON.parse(readFileSync(pendingPath,'utf8')) as StageRecord;if(old.inputSha256!==body.manifest.inputSha256||old.manifestSha256!==body.manifestSha256)throw new Error('Batch already staged with different content');return Response.json({ok:true,batchId:id,stagedAt:old.stagedAt,inputSha256:old.inputSha256,manifestSha256:old.manifestSha256},{headers:{'cache-control':'no-store'}});}
      const record:StageRecord={schema:'word5.reviewed-migration.v1',event,raw:raw.toString('utf8'),stagedAt:now,inputSha256:body.manifest.inputSha256,manifestSha256:body.manifestSha256};privateWrite(pendingPath,JSON.stringify(record));
      return Response.json({ok:true,batchId:id,stagedAt:now,inputSha256:record.inputSha256,manifestSha256:record.manifestSha256,stageEventId:event.id},{headers:{'cache-control':'no-store'}});
    }
    if(path==='/api/reconciliation/status'){
      exact(body,['batchId']);const id=batchId(body.batchId),path=join(this.config.root,'pending',id+'.json');const staged=existsSync(path)?JSON.parse(readFileSync(path,'utf8')) as StageRecord:null;
      return Response.json({ok:true,batchId:id,staged:staged?{stagedAt:staged.stagedAt,inputSha256:staged.inputSha256,manifestSha256:staged.manifestSha256,stageEventId:staged.event.id}:null,batch:hasBatch(this.db,id)},{headers:{'cache-control':'no-store'}});
    }
    if(path==='/api/reconciliation/rollback'){
      exact(body,['batchId','inputSha256','reason']);if(this.config.mode!=='active'||typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>2000)throw new Error('Rollback requires active mode and reason');const id=batchId(body.batchId),stored=hasBatch(this.db,id);if(!stored||stored.input_sha256!==body.inputSha256)throw new Error('Rollback batch hash mismatch');const saved=backup(this.db,this.config.root,id+'-rollback');rollbackMigration(this.db,id);return Response.json({ok:true,batchId:id,backup:saved,ownerConfirmedBaselinesPreserved:true},{headers:{'cache-control':'no-store'}});
    }
    throw new Error('Unsupported operator operation');
  }
}
/** Reviewed startup hook runs before canonical service reads or publisher jobs. */
export function activateReviewedMigration(dbPath:string,config:OperatorConfig,id:string,now=Date.now()) {
  batchId(id);const path=join(config.root,'pending',id+'.json');if(!existsSync(path))throw new Error('Reviewed activation is not staged');
  const bytes=readFileSync(path);if(bytes.length>25_000_000)throw new Error('Staged activation too large');const record=JSON.parse(bytes.toString('utf8')) as StageRecord;
  const auth=new OperatorAuthorization(config.operators,`${config.publicBase}api/reconciliation/stage`,config.instance);const body=auth.authorize(record.event,record.raw,record.stagedAt);exact(body,['batchId','input','manifest','manifestSha256']);
  if(record.schema!=='word5.reviewed-migration.v1'||body.batchId!==id||record.manifestSha256!==sha256(JSON.stringify(body.manifest))||body.manifestSha256!==record.manifestSha256||record.inputSha256!==sha256(JSON.stringify(body.input))||body.manifest.inputSha256!==record.inputSha256)throw new Error('Staged activation proof mismatch');
  if([...body.input.decisions,...(body.input.correctionReviews||[])].some((d:any)=>d.actor!==record.event.pubkey))throw new Error('Staged reviewer actor mismatch');
  const db=new Database(dbPath);try{
    const old=hasBatch(db,id);if(old){if(old.input_sha256!==record.inputSha256||old.rolled_back_at)throw new Error('Activation batch mismatch or rolled back');return {batchId:id,alreadyApplied:true};}
    if(!Number.isSafeInteger(record.stagedAt)||record.stagedAt<0||record.stagedAt>now+30000)throw new Error('Invalid staged approval time');
    const saved=backup(db,config.root,id+'-activation');const result=applyMigration(db,body.input,body.manifest,id);
    const receipt={batchId:id,inputSha256:result.inputSha256,backup:saved,activatedAt:now,stageEventId:record.event.id};privateWrite(join(config.root,`${id}-activation.json`),JSON.stringify(receipt));return receipt;
  }finally{db.close();}
}
export function operatorConfig(dbPath:string,mode:'stage'|'active'):OperatorConfig {return {operators:(process.env.WORD5_RECONCILIATION_OPERATORS||'').split(',').filter(p=>/^[0-9a-f]{64}$/.test(p)),instance:process.env.WORD5_RECONCILIATION_INSTANCE||'',publicBase:process.env.WORD5_PUBLIC_BASE||'https://otherstuff.ai/word5/',root:join(dirname(dbPath),'reconciliation'),mode};}
