// Sender metadata integration: real signed profiles/relay transport and isolated chat/history.
import { join, resolve } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { Word5Service, getCurrentPeriodId, getDateForPeriod, getWordForPeriod } from '../src/word5';
import { DailyChat } from '../src/chat';
import '../js/chat-crypto.js';
const {chromium}=await import(process.env.WORD5_PLAYWRIGHT_MODULE || 'playwright');
const root=resolve(import.meta.dir,'..'), service=new Word5Service({rootDir:root,dbPath:':memory:',relays:[],gamestrRelays:[]}),chat=new DailyChat(service),period=getCurrentPeriodId();
const keys=Array.from({length:7},()=>generateSecretKey()),pks=keys.map(getPublicKey),profiles=new Map(),profileRequests=new Map(),historyRequests=new Map();
let lateProfile=true,lateHistory=true;
const check=(ok:unknown,label:string)=>{if(!ok)throw new Error(label);console.log(`PASS ${label}`);};
for(let i=0;i<keys.length;i++){
 const won=i!==1,answer=getWordForPeriod(service.answers,period);
 service.complete(finalizeEvent({kind:30078,created_at:Math.floor(Date.now()/1000),tags:[['schema','word5.completion.v1']],content:JSON.stringify({game:'word5',periodId:period,puzzle:period%1000,date:getDateForPeriod(period),result:won?'1':'X',guesses:won?[answer]:Array(6).fill(answer==='OTHER'?'APPLE':'OTHER'),hardMode:false})},keys[i]));
}
const signed=(i:number,action:string,fields={})=>finalizeEvent({kind:30078,created_at:Math.floor(Date.now()/1000),tags:[['schema','word5.chat.v1']],content:JSON.stringify({action,nonce:crypto.randomUUID().replaceAll('-',''),...fields})},keys[i]);
const room=(chat.request(signed(0,'rooms'),'rooms') as any).rooms[0];
for(let i=0;i<keys.length;i++){
 const nonce=crypto.randomUUID().replaceAll('-','');const payload=await (globalThis as any).Word5ChatCrypto.encrypt(`message from player ${i}`,room.key,period,pks[i],nonce);
 chat.request(signed(i,'send',{period,nonce,...payload}),'send');
}
const built=await Bun.build({entrypoints:[join(root,'node_modules/nostr-tools/lib/esm/index.js')],target:'browser',format:'esm'});if(!built.success)throw new Error('Bundle failed');const bundle=await built.outputs[0].text();
const server=Bun.serve({port:0,async fetch(req,server){const url=new URL(req.url);if(url.pathname==='/relay'&&server.upgrade(req))return;
 try{
 if(url.pathname.startsWith('/api/chat/')){
  const action=url.pathname.split('/').at(-1)!,result:any=chat.request((await req.json()).event,action);
  if(action==='read'){result.results[pks[3]]={period:period-1,won:true,attempts:2};result.results[pks[4]]={period,won:false,attempts:1};}
  return Response.json(result);
 }
 if(url.pathname==='/api/player-history'){
  const pk=url.searchParams.get('pubkey')!;historyRequests.set(pk,(historyRequests.get(pk)||0)+1);
  if(lateHistory)await Bun.sleep(1600);
  const report=service.playerHistory(pk);
  // Wrong-date/unknown outcomes must never appear as a today's score.
  if(pk===pks[3])return Response.json({...report,periodId:period-1,currentResult:'2'});
  if(pk===pks[4])return Response.json({...report,currentResult:'invalid'});
  return Response.json(report);
 }
 if(url.pathname==='/avatar.svg')return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><rect width="30" height="30" fill="#f59042"/></svg>',{headers:{'content-type':'image/svg+xml'}});
 if(url.pathname==='/broken.png')return new Response('broken',{status:404});
 if(url.pathname.startsWith('/api/'))return Response.json({ok:true,count:0,rows:[],games:[]});
 const path=url.pathname==='/'?'chat.html':url.pathname.slice(1);return new Response(Bun.file(join(root,path)),{headers:{'content-type':path.endsWith('.js')?'text/javascript':path.endsWith('.html')?'text/html':'text/plain'}});
 }catch(error){return Response.json({ok:false,error:(error as Error).message},{status:400});}
 },websocket:{message(ws,data){const frame=JSON.parse(String(data));if(frame[0]!=='REQ')return;const id=frame[1],pk=frame[2].authors?.[0];
 if(frame[2].kinds?.[0]!==0){ws.send(JSON.stringify(['EOSE',id]));return;}
 profileRequests.set(pk,(profileRequests.get(pk)||0)+1);
 const send=()=>{for(const event of profiles.get(pk)||[])ws.send(JSON.stringify(['EVENT',id,event]));ws.send(JSON.stringify(['EOSE',id]));};
 if(lateProfile)setTimeout(send,1500);else send();
 }}});
const metadata=(i:number,data:any)=>finalizeEvent({kind:0,created_at:Math.floor(Date.now()/1000),tags:[],content:JSON.stringify(data)},keys[i]);
profiles.set(pks[0],[metadata(0,{display_name:'Pete Winn',picture:`${server.url}avatar.svg`,about:'unchanged profile details'})]);
profiles.set(pks[1],[metadata(1,{display_name:'Maya Chen',picture:`${server.url}avatar.svg`})]);
profiles.set(pks[2],[metadata(2,{display_name:'Broken photo',picture:`${server.url}broken.png`})]);
profiles.set(pks[3],[metadata(3,{display_name:'<img src=x onerror=alert(1)>',picture:'javascript:alert(1)'})]);
profiles.set(pks[4],[metadata(4,{display_name:'No valid outcome',picture:'data:image/svg+xml,unsafe'})]);
profiles.set(pks[5],[]);
profiles.set(pks[6],[{...metadata(6,{display_name:'Forged identity'}),sig:'0'.repeat(128)}]);
const browser=await chromium.launch({headless:true,...(process.env.WORD5_BROWSER_EXECUTABLE?{executablePath:process.env.WORD5_BROWSER_EXECUTABLE}:{})});
const errors:string[]=[];
async function newContext(){
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.route('https://esm.sh/**',route=>route.fulfill({body:bundle,contentType:'text/javascript'}));
 await context.exposeFunction('testSign',event=>JSON.parse(JSON.stringify(finalizeEvent(event,keys[0]))));
 await context.addInitScript(({pk,npub,relay})=>{
  localStorage.setItem('spiders.nostr.player.v1',JSON.stringify({privkey:'test-only-unused',nsec:'test-only-unused',auth_mode:'nip07',pubkey:pk,linked_pubkey:pk,npub,linked_npub:npub}));
  (window as any).nostr={getPublicKey:async()=>pk,signEvent:(window as any).testSign};(window as any).NostrPost={DEFAULT_RELAYS:[relay]};
 },{pk:pks[0],npub:nip19.npubEncode(pks[0]),relay:String(server.url).replace('http:','ws:')+'relay'});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));return {context,page};
}
try{
 const {context,page}=await newContext();await page.goto(`${server.url}chat.html`);
 const message=(i:number)=>page.locator(`[data-sender-pubkey="${pks[i]}"]`);
 await message(0).locator('.message-bubble').waitFor();
 await page.locator('#chatHistory').evaluate(el=>el.scrollTop=0);const position=await page.locator('#chatHistory').evaluate(el=>el.scrollTop);
 await message(0).locator('.message-name').getByText('Pete Winn',{exact:true}).waitFor();
 await message(1).locator('.message-result').getByText('X/6',{exact:true}).waitFor();
 await page.waitForTimeout(3500);
 check(await message(0).locator('.message-own').textContent()==='You'&&await message(0).locator('.message-result').textContent()==='1/6','own verified profile/name/result with You indicator');
 check(await message(1).locator('.message-name').textContent()==='Maya Chen'&&await message(1).locator('.message-result').getAttribute('aria-label')==='6 guesses · not solved','other sender loss result is accessible and correct');
 await message(0).locator('img').waitFor();await message(1).locator('img').waitFor();
 await page.waitForTimeout(300);
 check(await message(2).locator('img').count()===0&&await message(2).locator('.message-avatar').textContent()==='BP','broken photo preserves profile initials fallback');
 check(await message(3).locator('.message-name').textContent()==='<img src=x onerror=alert(1)>'&&await message(3).locator('img').count()===0,'malicious-looking name is text and javascript avatar is rejected');
 check(await message(4).locator('img').count()===0,'data avatar URL rejected');
 check(await message(3).locator('.message-result').textContent()===''&&await message(4).locator('.message-result').textContent()==='','wrong-date and malformed authenticated loss outcomes omitted');
 check(await message(5).locator('.message-name').textContent()===`${pks[5].slice(0,6)}…${pks[5].slice(-4)}`,'missing profile uses stable public-key fallback');
 check(await message(6).locator('.message-name').textContent()!== 'Forged identity','invalid signed profile rejected');
 check(await page.locator('#chatHistory').evaluate(el=>el.scrollTop)===position,'asynchronous metadata does not jump reader scroll');
 await page.locator('#chatRefresh').click();await message(0).locator('.message-name').getByText('Pete Winn',{exact:true}).waitFor();
 check(historyRequests.size===0&&[...profileRequests.values()].every(count=>count===1),'sender metadata deduplicates across messages/reads and shared own profile UI');

 await page.setViewportSize({width:320,height:667});await page.waitForTimeout(100);
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'320px sender headers/photos/results stay within viewport');
 await page.screenshot({path:join(root,'tmp/docs/handoffs/chat-senders-mobile.png')});
 await page.setViewportSize({width:1000,height:850});await page.waitForTimeout(300);
 check(await page.locator('#chatText').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight),'desktop composer remains visible after viewport settles');
 await page.screenshot({path:join(root,'tmp/docs/handoffs/chat-senders-desktop.png')});
 // Force own-profile refresh retains raw editable fields and validates again.
 const profile=await page.evaluate(pk=>(window as any).NostrUI.loadProfile(pk,{force:true}),pks[0]);
 check(profile.name==='Pete Winn'&&profile.data.about==='unchanged profile details','shared force-profile loader retains editable profile data');
 await context.close();
 // A missing own profile keeps one You label, never You You.
 profiles.delete(pks[0]);lateProfile=false;lateHistory=false;
 const ownFallback=await newContext();await ownFallback.page.goto(`${server.url}chat.html`);
 const ownNode=ownFallback.page.locator(`[data-sender-pubkey="${pks[0]}"]`);
 await ownNode.locator('.message-result').getByText('1/6',{exact:true}).waitFor();
 check(await ownNode.locator('.message-name').textContent()==='You'&&await ownNode.locator('.message-own').isHidden(),'missing own profile displays a single You fallback');
 await ownFallback.context.close();
 profiles.set(pks[0],[metadata(0,{picture:`${server.url}avatar.svg`})]);const photoOnly=await newContext();await photoOnly.page.goto(`${server.url}chat.html`);const photoNode=photoOnly.page.locator(`[data-sender-pubkey="${pks[0]}"]`);await photoNode.locator('img').waitFor();await photoOnly.page.evaluate(()=>(window as any).Word5Chat.refresh());await photoOnly.page.evaluate(()=>(window as any).Word5Chat.refresh());check(await photoNode.locator('img').count()===1,'photo-only profiles remain idempotent across repeated reads');await photoOnly.context.close();profiles.delete(pks[0]);
 // Slow results must not repopulate a room after daily rollover or an account switch.
 for(const mode of ['rollover','identity']){
  lateProfile=true;lateHistory=true;
  const {context,page}=await newContext();await page.goto(`${server.url}chat.html`);
  await page.locator('#chatMessages .message-bubble').first().waitFor();
  if(mode==='rollover')await page.evaluate(()=>{const now=Date.now;Date.now=()=>(Math.floor(now()/86400000)+2)*86400000;window.dispatchEvent(new Event('focus'));});
  else await page.evaluate(()=>(window as any).NostrSession.updatePlayer({auth_mode:'session',linked_pubkey:null,privkey:null}));
  await page.waitForTimeout(2300);
  check(await page.locator('#chatMessages').evaluate(el=>el.children.length)===0,`delayed sender metadata cannot return after ${mode}`);
  await context.close();
 }
 check(errors.length===0,`zero page errors: ${errors.join('; ')}`);
}finally{await browser.close();server.stop(true);service.db.close();}
