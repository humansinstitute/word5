import {createHash} from 'node:crypto';
import {getEventHash,verifyEvent,type Event} from 'nostr-tools';
export const operatorHash=(raw:string|Uint8Array)=>createHash('sha256').update(raw).digest('hex');
export class OperatorAuthorization {
  private used=new Map<string,number>();
  constructor(readonly operators:string[],readonly url:string,readonly instance:string){}
  authorize(event:Event,raw:string|Uint8Array,now=Date.now(),limit=20_000_000):any {
    if(!this.operators.length||!this.instance)throw new Error('Reconciliation operator disabled');
    if(typeof raw!=='string'&&!(raw instanceof Uint8Array))throw new Error('Operator authorization rejected');
    const bytes=typeof raw==='string'?Buffer.from(raw):raw;if(bytes.length>limit)throw new Error('Operator body too large');
    let body:any;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('Operator authorization rejected');}
    const seconds=Math.floor(now/1000),tags=new Map(event?.tags?.map(t=>[t[0],t[1]])||[]);
    if(!body||typeof body!=='object'||Array.isArray(body)||body.app!=='word5'||body.instance!==this.instance||!event||!this.operators.includes(event.pubkey)||!verifyEvent(event)||getEventHash(event)!==event.id||event.kind!==27235||event.content!==''||!Number.isSafeInteger(event.created_at)||event.created_at<0||Math.abs(event.created_at-seconds)>60||event.tags.length!==4||tags.size!==4||event.tags.some(t=>t.length!==2||!['u','method','payload','nonce'].includes(t[0]!))||tags.get('u')!==this.url||tags.get('method')!=='POST'||tags.get('payload')!==operatorHash(bytes)||!/^[0-9a-f-]{36}$/.test(tags.get('nonce')||''))throw new Error('Operator authorization rejected');
    for(const [id,expires] of this.used)if(expires<seconds)this.used.delete(id);
    if(this.used.has(event.id)||this.used.size>=1000)throw new Error('Operator authorization rejected');this.used.set(event.id,seconds+120);return body;
  }
}
export async function readOperatorRequest(req:Request,limit=20_000_000) {
  if(req.method!=='POST')throw new Error('Operator authorization rejected');const header=req.headers.get('authorization')||'';
  if(!header.startsWith('Nostr ')||header.length>8000)throw new Error('Operator authorization rejected');
  const event=JSON.parse(Buffer.from(header.slice(6),'base64').toString('utf8')) as Event;
  const reader=req.body?.getReader();if(!reader)throw new Error('Missing operator body');const parts:Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw new Error('Operator body too large');}parts.push(value);}
  return {event,raw:Buffer.concat(parts)};
}
