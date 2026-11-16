// Isolated browser/cache/delta regression; no real player or production writes.
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {finalizeEvent,generateSecretKey,getPublicKey,nip19} from 'nostr-tools';
import {Word5Service,getCurrentPeriodId,getDateForPeriod,getWordForPeriod} from '../src/word5';
import {DailyChat} from '../src/chat';
import '../js/chat-crypto.js';
const {chromium}=await import(process.env.WORD5_PLAYWRIGHT_MODULE||'playwright');
const root=resolve(import.meta.dir,'..'),dir=mkdtempSync(join(tmpdir(),'word5-cache-'));
const service=new Word5Service({rootDir:root,dbPath:join(dir,'test.sqlite'),relays:[],gamestrRelays:[]}),chat=new DailyChat(service);
const sk=generateSecretKey(),pk=getPublicKey(sk),period=getCurrentPeriodId();
const sign=(action:string,fields:any={})=>finalizeEvent({kind:30078,created_at:Math.floor(Date.now()/1000),tags:[['schema','word5.chat.v1']],content:JSON.stringify({action,nonce:crypto.randomUUID().replaceAll('-',''),...fields})},sk);
service.complete(finalizeEvent({kind:30078,created_at:Math.floor(Date.now()/1000),tags:[['schema','word5.completion.v1']],content:JSON.stringify({game:'word5',periodId:period,puzzle:period%1000,date:getDateForPeriod(period),result:'1',guesses:[getWordForPeriod(service.answers,period)],hardMode:false})},sk));
const room=(chat.request(sign('rooms'),'rooms') as any).rooms[0];
async function insert(text:string){const nonce=crypto.randomUUID().replaceAll('-','');const payload=await (globalThis as any).Word5ChatCrypto.encrypt(text,room.key,period,pk,nonce);const event=sign('send',{period,nonce,...payload});service.db.query('INSERT INTO chat_messages VALUES (?1,?2,?3,?4,?5)').run(event.id,period,pk,Date.now(),JSON.stringify(event));return event;}
const first=await insert('cached one'),second=await insert('cached two');
const built=await Bun.build({entrypoints:[join(root,'node_modules/nostr-tools/lib/esm/index.js')],target:'browser',format:'esm'});if(!built.success)throw Error('Test dependency bundle failed');const bundle=await built.outputs[0].text();
let failRooms=false,failReads=false,legacy=false;const reads:any[]=[];
const server=Bun.serve({port:0,async fetch(req){const url=new URL(req.url);try{
 if(url.pathname.startsWith('/api/chat/')){const action=url.pathname.split('/').at(-1)!;const e=(await req.json()).event;if(action==='read')reads.push(JSON.parse(e.content));if((action==='rooms'&&failRooms)||(action==='read'&&failReads))return Response.json({ok:false,error:'test outage'},{status:503});const result:any=chat.request(e,action);if(legacy&&action==='read'){delete result.reset;delete result.cursor;result.messages=service.db.query('SELECT event FROM chat_messages WHERE period=?1 ORDER BY rowid').all(period).map((x:any)=>JSON.parse(x.event));}return Response.json(result);}
 if(url.pathname==='/api/player-history')return Response.json(service.playerHistory(url.searchParams.get('pubkey')!));
 if(url.pathname.startsWith('/api/'))return Response.json({ok:true,rows:[],games:[]});
 const file=Bun.file(join(root,url.pathname==='/'?'chat.html':url.pathname.slice(1)));return new Response(file,{headers:{'content-type':url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.html')?'text/html':'text/plain'}});
}catch(e){return Response.json({ok:false,error:(e as Error).message},{status:400});}}});
const browser=await chromium.launch({headless:true,...(process.env.WORD5_BROWSER_EXECUTABLE?{executablePath:process.env.WORD5_BROWSER_EXECUTABLE}:{})});
const check=(ok:unknown,label:string)=>{if(!ok)throw Error(label);console.log(`PASS ${label}`);};
try{
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.route('https://esm.sh/**',r=>r.fulfill({body:bundle,contentType:'text/javascript'}));await context.route('wss://**',r=>r.abort());
 let signingKey=sk;await context.exposeFunction('testSign',(e:any)=>JSON.parse(JSON.stringify(finalizeEvent(e,signingKey))));
 await context.addInitScript(({pk,npub})=>{localStorage.setItem('spiders.nostr.player.v1',JSON.stringify({privkey:'test-only-unused',nsec:'test-only-unused',auth_mode:'nip07',pubkey:pk,linked_pubkey:pk,npub,linked_npub:npub}));(window as any).nostr={getPublicKey:async()=>pk,signEvent:(window as any).testSign};},{pk,npub:nip19.npubEncode(pk)});
 const page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`${server.url}chat.html`);
 await page.locator('#chatMessages').getByText('cached two',{exact:true}).waitFor();
 await page.evaluate(()=>{(window as any).decryptCount=0;const decrypt=(window as any).Word5ChatCrypto.decrypt;(window as any).Word5ChatCrypto.decrypt=(...args:any[])=>{(window as any).decryptCount++;return decrypt(...args);};(window as any).firstNode=document.querySelector('#chatMessages li');});
 await page.evaluate(()=>(window as any).Word5Chat.refresh());
 check(reads.at(-1).after===second.id,'refresh sends stable newest cursor');
 check(await page.evaluate(()=>(window as any).decryptCount===0&&(window as any).firstNode===document.querySelector('#chatMessages li')),'unchanged response performs no decrypt or DOM rebuild');
 const third=await insert('only new delta');await page.evaluate(()=>(window as any).Word5Chat.refresh());await page.locator('#chatMessages').getByText('only new delta',{exact:true}).waitFor();
 check(await page.evaluate(()=>(window as any).decryptCount)===1,'new delta decrypts only the new message');
 const cache=await page.evaluate(()=>Object.entries(sessionStorage).find(([k])=>k.startsWith('word5-chat-messages:'))?.[1]);check(cache&&!cache.includes('cached one')&&!cache.includes('only new delta'),'persisted cache contains ciphertext only');
 await page.locator('#chatText').fill('keep my draft');failRooms=true;await page.evaluate(()=>(window as any).Word5Chat.refresh());
 check(await page.locator('#chatMessages li').count()===3&&await page.locator('#chatText').inputValue()==='keep my draft','rooms failure retains conversation and draft');failRooms=false;
 // Simulate the user-visible browser network failure, not an invented API error.
 await page.route('**/api/chat/read',r=>r.abort('failed'));await page.evaluate(()=>(window as any).Word5Chat.refresh());
 check((await page.locator('#chatStatus').textContent())?.includes('Showing cached messages'),'failed fetch shows recovery guidance with cached messages');check(await page.locator('#chatMessages li').count()===3,'failed fetch keeps existing messages');await page.unroute('**/api/chat/read');
 await page.evaluate(()=>(window as any).Word5Chat.refresh());check(await page.locator('#chatStatus').textContent()==='','successful reconnect clears stale failure status');
 // Same-day reload restores cached signed events even if the membership route is offline.
 failRooms=true;await page.reload();await page.locator('#chatMessages').getByText('only new delta',{exact:true}).waitFor();check(await page.locator('#chatMessages li').count()===3,'same-day offline reload hydrates authorized ciphertext cache');failRooms=false;
 // Legacy servers return a full snapshot without cursor/reset; already cached events remain decoded.
 await page.evaluate(()=>{(window as any).decryptCount=0;const decrypt=(window as any).Word5ChatCrypto.decrypt;(window as any).Word5ChatCrypto.decrypt=(...args:any[])=>{(window as any).decryptCount++;return decrypt(...args);};});legacy=true;await page.evaluate(()=>(window as any).Word5Chat.refresh());check(await page.locator('#chatMessages li').count()===3&&await page.evaluate(()=>(window as any).decryptCount)===0,'legacy snapshot remains compatible and does not decrypt known messages');legacy=false;await page.evaluate(()=>(window as any).Word5Chat.refresh());
 service.db.query('DELETE FROM chat_messages WHERE id=?1').run(third.id);await page.evaluate(()=>(window as any).Word5Chat.refresh());check(await page.locator('#chatMessages li').count()===2,'missing cursor resets to server snapshot and removes stale entries');
 await page.waitForTimeout(2100); // Respect the server's two-second sender interval.
 let releaseSend:(()=>void)|undefined;
 await page.route('**/api/chat/send',async route=>{await new Promise<void>(resolve=>{releaseSend=resolve;});await route.continue();});
 await page.locator('#chatText').fill('slow signed send');await page.locator('#chatSend').click();
 for(let i=0;i<100&&!releaseSend;i++)await page.waitForTimeout(10);
 if(!releaseSend)throw Error('Delayed send not reached');await page.locator('#chatText').fill('my next message');releaseSend();
 await page.locator('#chatMessages').getByText('slow signed send',{exact:true}).waitFor();
 check(await page.locator('#chatText').inputValue()==='my next message','slow send preserves text typed for the next message');await page.unroute('**/api/chat/send');
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile conversation stays within viewport');
 const other=generateSecretKey(),otherPk=getPublicKey(other);signingKey=other;
 await page.evaluate(pk=>{(window as any).nostr.getPublicKey=async()=>pk;(window as any).NostrSession.updatePlayer({auth_mode:'nip07',linked_pubkey:pk,pubkey:pk});},otherPk);
 await page.waitForFunction(()=>document.querySelector('#chatMessages')?.children.length===0);
 check(!await page.evaluate(pk=>Object.keys(sessionStorage).some(k=>k.startsWith(`word5-chat-messages:${pk}:`)),pk),'account switch removes previous identity cache');
 signingKey=sk;await page.evaluate(pk=>{(window as any).nostr.getPublicKey=async()=>pk;(window as any).NostrSession.updatePlayer({auth_mode:'nip07',linked_pubkey:pk,pubkey:pk});},pk);
 await page.locator('#chatMessages').getByText('cached one',{exact:true}).waitFor();
 await page.locator('#chatText').fill('expires with room');
 await page.evaluate(()=>{const old=Date.now;Date.now=()=> (Math.floor(old()/86400000)+2)*86400000;});await page.waitForFunction(()=>document.querySelector('#chatMessages')?.children.length===0&&!Object.keys(sessionStorage).some(k=>k.startsWith('word5-chat-messages:')));check(await page.locator('#chatText').inputValue()==='','rollover clears ciphertext cache, visible messages and draft');
 check(errors.length===0,`zero browser errors ${errors.join('; ')}`);await context.close();
}finally{await browser.close();server.stop(true);service.db.close();rmSync(dir,{recursive:true,force:true});}
