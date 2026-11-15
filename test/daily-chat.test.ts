import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { Word5Service, getCurrentPeriodId, getDateForPeriod, getWordForPeriod, PERIOD_MS } from '../src/word5';
import { DailyChat } from '../src/chat';
import '../js/chat-crypto.js';
const cryptoUI = (globalThis as any).Word5ChatCrypto;
const fixtures: {dir:string,service:Word5Service}[]=[];
afterEach(()=>{ for(const f of fixtures.splice(0)) { f.service.db.close();rmSync(f.dir,{recursive:true,force:true}); } });
const period=getCurrentPeriodId(), now=period*PERIOD_MS+200000;
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'word5-chat-')); mkdirSync(join(dir,'assets'));
 writeFileSync(join(dir,'assets/answers.txt'),'apple\nbrave\ncrane\n');writeFileSync(join(dir,'assets/wla.txt'),'other\n');
 const service=new Word5Service({rootDir:dir,dbPath:join(dir,'isolated.sqlite'),relays:[],gamestrRelays:[]});
 fixtures.push({dir,service});return {service,chat:new DailyChat(service)};
}
function finish(service:Word5Service, sk:Uint8Array, p=period, loss=false, at=p*PERIOD_MS+100000) {
 const answer=getWordForPeriod(service.answers,p);
 return service.complete(finalizeEvent({kind:30078,created_at:Math.floor(at/1000),tags:[['schema','word5.completion.v1']],content:JSON.stringify({game:'word5',periodId:p,puzzle:p%1000,date:getDateForPeriod(p),result:loss?'X':'1',guesses:loss?Array(6).fill('OTHER'):[answer],hardMode:false})},sk),at);
}
function event(sk:Uint8Array,action='rooms',fields={},at=now) {return finalizeEvent({kind:30078,created_at:Math.floor(at/1000),tags:[['schema','word5.chat.v1']],content:JSON.stringify({action,nonce:randomBytes(16).toString('hex'),...fields})},sk);}
function rooms(chat:DailyChat,sk:Uint8Array,at=now) {return (chat.request(event(sk,'rooms',{},at),'rooms',at) as any).rooms;}
test('win and exhausted guesses unlock a consistent shared key; other dates have independent keys and refetch survives restart',()=>{
 const {service,chat}=fixture(), a=generateSecretKey(),b=generateSecretKey();finish(service,a);finish(service,b,period,true);finish(service,a,period-1);
 const aa=rooms(chat,a),bb=rooms(chat,b);expect(aa).toHaveLength(1);expect(bb).toHaveLength(1);expect(aa[0].key).toBe(bb[0].key);expect(aa[0].word).toBe(getWordForPeriod(service.answers,period));
 expect(rooms(new DailyChat(service),a)[0].key).toBe(aa[0].key);
 finish(service,a,period+1);expect(rooms(chat,a,(period+1)*PERIOD_MS+200000)[0].key).not.toBe(aa[0].key);
});
test('unsigned, forged identity, stale, wrong action, replay and incomplete requests rejected; public legacy scores do not qualify',()=>{
 const {service,chat}=fixture(),sk=generateSecretKey(),other=generateSecretKey();finish(service,sk);
 const e=event(sk);expect(()=>chat.request({...e,sig:'0'.repeat(128)},'rooms',now)).toThrow();expect(()=>chat.request({...e,pubkey:getPublicKey(other)},'rooms',now)).toThrow();
 expect(()=>chat.request(event(sk,'rooms',{},now-61000),'rooms',now)).toThrow();expect(()=>chat.request(event(sk),'read',now)).toThrow();chat.request(e,'rooms',now);expect(()=>chat.request(e,'rooms',now)).toThrow('Replayed');const live=event(sk,'rooms',{},Date.now());chat.request(live,'rooms');expect(()=>new DailyChat(service).request(live,'rooms')).toThrow('Replayed');
 expect(()=>chat.request(event(sk,'read',{period:period+1}),'read',now)).toThrow('unavailable');expect(rooms(chat,other)).toEqual([]);expect(()=>chat.request(event(other,'read',{period}),'read',now)).toThrow('Finish');expect(()=>chat.request(event(other,'send',{period}),'send',now)).toThrow('Finish');
 service.db.query('UPDATE game_submissions SET verified_completion=0 WHERE pubkey=?1').run(getPublicKey(sk));expect(rooms(chat,sk)).toEqual([]);
});
test('encrypted roundtrip retains signed ciphertext only, rejects tampering, wrong key and room, replay and flooding',async()=>{
 const {service,chat}=fixture(),sk=generateSecretKey();finish(service,sk);const room=rooms(chat,sk)[0];const pubkey=getPublicKey(sk),nonce=randomBytes(16).toString('hex');
 const payload=await cryptoUI.encrypt('<img src=x onerror=alert(1)>',room.key,period,pubkey,nonce);const signed=event(sk,'send',{period,nonce,...payload});chat.request(signed,'send',now);
 const messages=(chat.request(event(sk,'read',{period}),'read',now) as any).messages;expect(messages[0]).toEqual(JSON.parse(JSON.stringify(signed)));expect(JSON.stringify(messages)).not.toContain('<img');expect(await cryptoUI.decrypt(JSON.parse(signed.content),room.key,pubkey)).toBe('<img src=x onerror=alert(1)>');
 await expect(cryptoUI.decrypt({...JSON.parse(signed.content),period:period-1},room.key,pubkey)).rejects.toThrow();await expect(cryptoUI.decrypt(JSON.parse(signed.content),randomBytes(32).toString('base64'),pubkey)).rejects.toThrow();
 expect(()=>chat.request(signed,'send',now)).toThrow('Replayed');expect(()=>chat.request(event(sk,'send',{period,...payload}),'send',now+1000)).toThrow('quickly');
 expect(()=>chat.request(event(sk,'send',{period,iv:payload.iv,ciphertext:'A'.repeat(4100)}),'send',now+3000)).toThrow('Invalid');
 for(let i=0;i<35;i++) {try {chat.request(event(sk),'rooms',now);}catch {}}
 expect(()=>chat.request(event(sk),'rooms',now)).toThrow('rate');await expect(cryptoUI.encrypt('x'.repeat(2001),room.key,period,pubkey,nonce)).rejects.toThrow();
});
test('legacy listing closes at rollover; extended access ends after yesterday and physical data purges25h after puzzle end',async()=>{
 const {service,chat}=fixture(),sk=generateSecretKey();finish(service,sk);const room=rooms(chat,sk)[0];const nonce=randomBytes(16).toString('hex');const payload=await cryptoUI.encrypt('hello',room.key,period,getPublicKey(sk),nonce);chat.request(event(sk,'send',{period,nonce,...payload}),'send',now);
 const rollover=(period+1)*PERIOD_MS,accessEnd=(period+2)*PERIOD_MS,purgeAt=rollover+25*60*60*1000;
 expect(rooms(chat,sk,rollover-1)).toHaveLength(1);expect(rooms(chat,sk,rollover)).toEqual([]);
 const previous=(chat.request(event(sk,'rooms',{includePrevious:true},rollover),'rooms',rollover) as any).rooms;
 expect(previous).toHaveLength(1);expect(previous[0].key).toBe(room.key);expect(previous[0].expiresAt).toBe(accessEnd);
 expect((chat.request(event(sk,'read',{period},accessEnd-1),'read',accessEnd-1) as any).messages).toHaveLength(1);
 expect(()=>chat.request(event(sk,'read',{period},accessEnd),'read',accessEnd)).toThrow('expired');expect(()=>chat.request(event(sk,'send',{period,...payload},accessEnd),'send',accessEnd)).toThrow('expired');
 expect(service.db.query('SELECT COUNT(*) AS n FROM chat_rooms').get()).toEqual({n:1});expect(service.db.query('SELECT COUNT(*) AS n FROM chat_messages').get()).toEqual({n:1});
 chat.prune(purgeAt-1);expect(service.db.query('SELECT COUNT(*) AS n FROM chat_messages').get()).toEqual({n:1});chat.prune(purgeAt);
 expect(service.db.query('SELECT * FROM chat_rooms').all()).toEqual([]);expect(service.db.query('SELECT * FROM chat_messages').all()).toEqual([]);
 expect((chat.request(event(sk,'rooms',{includePrevious:true},purgeAt),'rooms',purgeAt) as any).rooms).toEqual([]);
 service.db.query('INSERT INTO chat_rooms VALUES (?1,?2)').run(period-4,'old');new DailyChat(service);expect(service.db.query('SELECT * FROM chat_rooms').all()).toEqual([]);
});
test('browser storage prunes expired keys at exact boundary and removes keys for another identity',()=>{
 const map=new Map<string,string>();const storage={get length(){return map.size},key:(i:number)=>[...map.keys()][i],getItem:(k:string)=>map.get(k),setItem:(k:string,v:string)=>map.set(k,v),removeItem:(k:string)=>map.delete(k)};
 const expiresAt=(period+2)*PERIOD_MS;map.set('word5-chat:a',JSON.stringify([{period,expiresAt,key:'shared'}]));map.set('word5-chat:b','[]');cryptoUI.prune(storage,'a',expiresAt-1);expect(map.has('word5-chat:b')).toBe(false);expect(JSON.parse(map.get('word5-chat:a')!)).toHaveLength(1);cryptoUI.prune(storage,'a',expiresAt);expect(JSON.parse(map.get('word5-chat:a')!)).toEqual([]);
});
test('room history is bounded to the latest 200 ciphertext messages',()=>{
 const {service,chat}=fixture(),sk=generateSecretKey();finish(service,sk);
 for(let i=0;i<205;i++) {const at=now+i*7000;chat.request(event(sk,'send',{period,iv:'AAAAAAAAAAAAAAAA',ciphertext:'A'.repeat(24)},at),'send',at);}
 expect(service.db.query('SELECT COUNT(*) AS n FROM chat_messages').get()).toEqual({n:200});
 const at=now+205*7000;expect((chat.request(event(sk,'read',{period},at),'read',at) as any).messages).toHaveLength(200);
});

test('delta reads use stable receipt-order anchors, return empty unchanged responses and reset pruned cursors',()=>{
 const {service,chat}=fixture(),sk=generateSecretKey();finish(service,sk);
 const messages=Array.from({length:3},(_,i)=>event(sk,'send',{period,iv:'AAAAAAAAAAAAAAAA',ciphertext:'A'.repeat(24)},now+i));
 // Receipt order is authoritative even when sender timestamps/received clocks tie or move backward.
 for(const [i,e] of messages.entries())service.db.query('INSERT INTO chat_messages VALUES (?1,?2,?3,?4,?5)').run(e.id,period,e.pubkey,now-i,JSON.stringify(e));
 const full=chat.request(event(sk,'read',{period}),'read',now) as any;
 expect(full.messages.map((e:any)=>e.id)).toEqual(messages.map(e=>e.id));expect(full.reset).toBe(true);expect(full.cursor).toBe(messages[2].id);
 const delta=chat.request(event(sk,'read',{period,after:messages[0].id}),'read',now) as any;
 expect(delta.messages.map((e:any)=>e.id)).toEqual(messages.slice(1).map(e=>e.id));expect(delta.reset).toBe(false);expect(delta.cursor).toBe(messages[2].id);
 const unchanged=chat.request(event(sk,'read',{period,after:messages[2].id}),'read',now) as any;
 expect(unchanged.messages).toEqual([]);expect(unchanged.reset).toBe(false);expect(unchanged.cursor).toBe(messages[2].id);
 service.db.query('DELETE FROM chat_messages WHERE id=?1').run(messages[0].id);
 const reset=chat.request(event(sk,'read',{period,after:messages[0].id}),'read',now) as any;
 expect(reset.reset).toBe(true);expect(reset.messages.map((e:any)=>e.id)).toEqual(messages.slice(1).map(e=>e.id));
 const other=generateSecretKey();expect(()=>chat.request(event(other,'read',{period,after:messages[2].id}),'read',now)).toThrow('Finish');
 expect(()=>chat.request(event(sk,'read',{period,after:'not-an-id'}),'read',now)).toThrow('cursor');
 service.db.query('DELETE FROM chat_messages').run();const empty=chat.request(event(sk,'read',{period,after:messages[2].id}),'read',now) as any;expect(empty.messages).toEqual([]);expect(empty.reset).toBe(true);expect(empty.cursor).toBeNull();
});
test('ciphertext cache is owner/room scoped across today/yesterday and expires with the room key',()=>{
 const map=new Map<string,string>();const storage={get length(){return map.size},key:(i:number)=>[...map.keys()][i],getItem:(k:string)=>map.get(k),setItem:(k:string,v:string)=>map.set(k,v),removeItem:(k:string)=>map.delete(k)};
 const expiresAt=(period+2)*PERIOD_MS;
 map.set(`word5-chat-messages:a:${period}`,JSON.stringify({period,expiresAt,events:[],cursor:null}));map.set(`word5-chat-messages:b:${period}`,'{}');
 cryptoUI.prune(storage,'a',expiresAt-1);expect(map.has(`word5-chat-messages:a:${period}`)).toBe(true);expect(map.has(`word5-chat-messages:b:${period}`)).toBe(false);
 cryptoUI.prune(storage,'a',expiresAt);expect(map.has(`word5-chat-messages:a:${period}`)).toBe(false);
});

test('new clients list exactly completed today/yesterday, reuse keys and keep per-room verified results private to authenticated reads',()=>{
 const {service,chat}=fixture(),sk=generateSecretKey(),other=generateSecretKey();finish(service,sk,period-1,true);finish(service,sk);finish(service,sk,period-2);finish(service,other,period-1);
 const extended=(chat.request(event(sk,'rooms',{includePrevious:true}),'rooms',now) as any).rooms;
 expect(extended.map((r:any)=>r.period)).toEqual([period,period-1]);expect(extended.map((r:any)=>r.expiresAt)).toEqual([(period+2)*PERIOD_MS,(period+1)*PERIOD_MS]);
 expect(rooms(chat,sk)).toHaveLength(1);expect(rooms(chat,sk)[0].expiresAt).toBe((period+1)*PERIOD_MS);expect(rooms(chat,sk)[0].key).toBe(extended[0].key);
 const yesterdayOnly=(chat.request(event(other,'rooms',{includePrevious:true}),'rooms',now) as any).rooms;expect(yesterdayOnly.map((r:any)=>r.period)).toEqual([period-1]);
 const e=event(sk,'send',{period:period-1,iv:'AAAAAAAAAAAAAAAA',ciphertext:'A'.repeat(24)});chat.request(e,'send',now);
 const read=chat.request(event(other,'read',{period:period-1}),'read',now) as any;
 expect(read.results[getPublicKey(sk)]).toEqual({period:period-1,won:false,attempts:6});
 const delta=chat.request(event(other,'read',{period:period-1,after:e.id}),'read',now) as any;expect(delta.messages).toEqual([]);expect(delta.results).toEqual(read.results);
 expect(()=>chat.request(event(other,'read',{period}),'read',now)).toThrow('Finish');expect(()=>chat.request(event(sk,'read',{period:period-2}),'read',now)).toThrow('expired');
 expect(()=>chat.request(event(sk,'rooms',{includePrevious:'true'}),'rooms',now)).toThrow('option');
});
