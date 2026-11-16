import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {finalizeEvent,generateSecretKey,getPublicKey} from 'nostr-tools';
import {ReconciliationSnapshot,snapshotRequest} from '../src/reconciliation-snapshot';
const key=generateSecretKey(),url='https://word5.test/api/reconciliation/snapshot',body=JSON.stringify({app:'word5',instance:'primary-reviewed'}),now=Date.now();
function event(change:(e:any)=>void=()=>{}){const e:any={kind:27235,created_at:Math.floor(now/1000),tags:[['u',url],['method','POST'],['payload',createHash('sha256').update(body).digest('hex')],['nonce',crypto.randomUUID()]],content:''};change(e);return finalizeEvent(e,key);}
function fixture(){const db=new Database(':memory:');db.exec('CREATE TABLE private_records(content TEXT);INSERT INTO private_records VALUES(\'fixture private evidence\')');return {db,snapshot:new ReconciliationSnapshot(db,[getPublicKey(key)],url,'primary-reviewed')};}
test('snapshot rejects changed raw bytes/schema/identity/URL/method/time/tags and disabled config',()=>{
 const f=fixture();const e=event();
 for(const raw of [body+'\n',' '+body,JSON.stringify({instance:'primary-reviewed',app:'word5'}),JSON.stringify({app:'word5',instance:'other'}),JSON.stringify({app:'word5',instance:'primary-reviewed',path:'/data'}),'null'])expect(()=>f.snapshot.export(e,raw,now)).toThrow();
 for(const modify of [(e:any)=>e.tags[0][1]='https://other.test/api/reconciliation/snapshot',(e:any)=>e.tags[1][1]='GET',(e:any)=>e.created_at+=61,(e:any)=>e.created_at-=61,(e:any)=>e.tags.push(['u',url]),(e:any)=>e.tags[3]=['p',getPublicKey(key)]])expect(()=>f.snapshot.export(event(modify),body,now)).toThrow();
 expect(()=>new ReconciliationSnapshot(f.db,[],url,'primary-reviewed').export(e,body,now)).toThrow('disabled');
 const reordered=event(e=>e.tags.reverse());expect(f.snapshot.export(reordered,body,now).bytes.length).toBeGreaterThan(0);expect(()=>f.snapshot.export(reordered,body,now)).toThrow();f.db.close();
});
test('snapshot HTTP transport verifies header against bounded original bytes, not canonicalized JSON',async()=>{
 const f=fixture(),e=event(),auth='Nostr '+Buffer.from(JSON.stringify(e)).toString('base64');
 await expect(snapshotRequest(new Request(url,{method:'POST',headers:{authorization:auth},body:body+'\n'}),f.snapshot)).rejects.toThrow();
 const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('x'.repeat(600)));controller.enqueue(new TextEncoder().encode('x'.repeat(600)));controller.close();}});
 await expect(snapshotRequest(new Request(url,{method:'POST',headers:{authorization:auth},body:stream}),f.snapshot)).rejects.toThrow('too large');
 expect((await snapshotRequest(new Request(url,{method:'POST',headers:{authorization:auth},body}),f.snapshot)).bytes.length).toBeGreaterThan(0);f.db.close();
});
