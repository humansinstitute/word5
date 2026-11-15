import {Database} from 'bun:sqlite';
import {getEventHash,verifyEvent,type Event} from 'nostr-tools';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const hash=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');
/** Explicit operator-only read surface; disabled unless configured. Never falls back to user history or relay data. */
export class ReconciliationSnapshot {
  private used=new Map<string,number>();
  constructor(private readonly db:Database,private readonly operators:string[],private readonly url:string,private readonly instance:string){}
  export(event:Event,rawBody:Uint8Array|string,now=Date.now()) {
    if(!this.operators.length||!this.instance)throw new Error('Reconciliation snapshot disabled');
    const seconds=Math.floor(now/1000);
    if(typeof rawBody!=='string'&&!(rawBody instanceof Uint8Array))throw new Error('Snapshot authorization rejected');
    const bytesIn=typeof rawBody==='string'?Buffer.from(rawBody):rawBody;
    if(bytesIn.byteLength>1024)throw new Error('Snapshot authorization rejected');
    let body:any;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytesIn));}catch{throw new Error('Snapshot authorization rejected');}
    const tags=new Map(event?.tags?.map(t=>[t[0],t[1]])||[]);
    if(!body||Object.keys(body).sort().join(',')!=='app,instance'||body.app!=='word5'||body.instance!==this.instance||
      !event||!this.operators.includes(event.pubkey)||!verifyEvent(event)||getEventHash(event)!==event.id||event.kind!==27235||event.content!==''||Math.abs(event.created_at-seconds)>60||
      event.tags.length!==4||tags.size!==4||event.tags.some(t=>t.length!==2||!['u','method','payload','nonce'].includes(t[0]!))||
      tags.get('u')!==this.url||tags.get('method')!=='POST'||tags.get('payload')!==hash(bytesIn)||!/^[0-9a-f-]{36}$/.test(tags.get('nonce')||''))throw new Error('Snapshot authorization rejected');
    for(const [id,expires] of this.used)if(expires<seconds)this.used.delete(id);
    if(this.used.has(event.id)||this.used.size>=1000)throw new Error('Snapshot authorization rejected');this.used.set(event.id,seconds+120);
    const dir=mkdtempSync(join(tmpdir(),'word5-snapshot-'));const path=join(dir,'snapshot.sqlite');
    try {
      this.db.query('VACUUM INTO ?').run(path);chmodSync(path,0o600);
      const check=new Database(path,{readonly:true});try{if((check.query('PRAGMA integrity_check').get() as any).integrity_check!=='ok')throw new Error('Snapshot integrity check failed');}finally{check.close();}
      const bytes=readFileSync(path);return {bytes,sha256:hash(bytes),captureStartedAt:seconds,captureFinishedAt:Math.floor(Date.now()/1000)};
    }finally{rmSync(dir,{recursive:true,force:true});}
  }
}

export async function snapshotRequest(req:Request,snapshot:ReconciliationSnapshot) {
  if(req.method!=='POST')throw new Error('Snapshot authorization rejected');
  const authorization=req.headers.get('authorization')||'';
  if(!authorization.startsWith('Nostr '))throw new Error('Snapshot authorization rejected');
  const event=JSON.parse(Buffer.from(authorization.slice(6),'base64').toString('utf8'));
  const reader=req.body?.getReader();if(!reader)throw new Error('Missing snapshot body');
  const parts:Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1024){await reader.cancel();throw new Error('Snapshot body too large');}parts.push(value);}
  return snapshot.export(event,Buffer.concat(parts));
}
