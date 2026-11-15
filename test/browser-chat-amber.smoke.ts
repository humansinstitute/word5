// Real Amber browser transport callbacks with genuine signatures and an isolated DB.
// Covers full-document Android-style returns; does not exercise a physical signer device.
import { resolve, join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { parseAmber, amberReturn } from './helpers/amber-contract';
import { Word5Service, getCurrentPeriodId, getDateForPeriod, getWordForPeriod } from '../src/word5';
import { DailyChat } from '../src/chat';
const {chromium}=await import(process.env.WORD5_PLAYWRIGHT_MODULE || 'playwright');
const root=resolve(import.meta.dir,'..'), service=new Word5Service({rootDir:root,dbPath:':memory:',relays:[],gamestrRelays:[]}),chat=new DailyChat(service);
const sk=generateSecretKey(),pk=getPublicKey(sk),period=getCurrentPeriodId();
service.complete(finalizeEvent({kind:30078,created_at:Math.floor(Date.now()/1000),tags:[['schema','word5.completion.v1']],content:JSON.stringify({game:'word5',periodId:period,puzzle:period%1000,date:getDateForPeriod(period),result:'1',guesses:[getWordForPeriod(service.answers,period)],hardMode:false})},sk));
const yesterdayAt=(period-1)*86400000+100000;service.complete(finalizeEvent({kind:30078,created_at:yesterdayAt/1000,tags:[['schema','word5.completion.v1']],content:JSON.stringify({game:'word5',periodId:period-1,puzzle:(period-1)%1000,date:getDateForPeriod(period-1),result:'1',guesses:[getWordForPeriod(service.answers,period-1)],hardMode:false})},sk),yesterdayAt);
const build=await Bun.build({entrypoints:[join(root,'node_modules/nostr-tools/lib/esm/index.js')],target:'browser',format:'esm'});
if(!build.success) throw new Error('Nostr test bundle failed');
const bundle=await build.outputs[0].text(), counts={rooms:0,read:0,send:0};
const server=Bun.serve({port:0,async fetch(req){const url=new URL(req.url);try{
 if(url.pathname.startsWith('/api/chat/')) {const action=url.pathname.split('/').at(-1)!;counts[action]++;return Response.json(chat.request((await req.json()).event,action));}
 if(url.pathname.startsWith('/api/')) return Response.json({ok:true,games:[],rows:[],count:0});
 const path=url.pathname==='/'?'chat.html':url.pathname.slice(1);return new Response(Bun.file(join(root,path)),{headers:{'content-type':path.endsWith('.js')?'text/javascript':path.endsWith('.html')?'text/html':'text/plain'}});
}catch(error){return Response.json({ok:false,error:(error as Error).message},{status:400});}}});
const browser=await chromium.launch({headless:true,...(process.env.WORD5_BROWSER_EXECUTABLE?{executablePath:process.env.WORD5_BROWSER_EXECUTABLE}:{})});
const errors:string[]=[];
const check=(ok:unknown,label:string)=>{if(!ok)throw new Error(label);console.log(`PASS ${label}`);};
try {
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.route('https://esm.sh/**',route=>route.fulfill({body:bundle,contentType:'text/javascript'}));
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const cdp=await context.newCDPSession(page);await cdp.send('Page.enable');let outgoing='';
 cdp.on('Page.frameRequestedNavigation',(e:any)=>{if(e.url.startsWith('intent:'))outgoing=e.url;});
 async function approve(expected:string,manual=false) {
  await page.locator('#amberRequest button').first().waitFor();outgoing='';
  await page.locator('#amberRequest button').first().click();
  for(let i=0;i<100&&!outgoing;i++)await page.waitForTimeout(10);
  if(!outgoing)throw new Error('No Amber intent');
  const parsed=parseAmber(outgoing);
  const pending=await page.evaluate(()=>JSON.parse(localStorage.getItem('word5-amber-pending-v1')!));
  if(expected==='login')check(pending.type==='get_public_key','login uses actual Amber transport');
  else check(JSON.parse(parsed.event.content).action===expected,`exact ${expected} request sent to Amber`);
  const signed=expected==='login'?null:finalizeEvent(parsed.event,sk);
  const returned=expected==='login'?amberReturn(outgoing,pk):amberReturn(outgoing,signed!.sig,signed!);
  if(manual) {
   await page.getByRole('button',{name:'Return result manually',exact:true}).click();
   await page.locator('#amberManualResult').fill(JSON.stringify(signed));
   await page.getByRole('button',{name:'Use result',exact:true}).click();
  } else { await page.goto('about:blank');await page.goto(returned); }
 }
 await page.goto(`${server.url}chat.html`);await page.waitForFunction(()=>Boolean((window as any).NostrSession?.getPlayer()));
 await page.waitForFunction(()=>(document.getElementById('chatSend') as HTMLButtonElement).disabled);
 check(await page.locator('#chatRoom').textContent()==='Today’s chat','incomplete direct visitor sees no word or room key');
 await page.evaluate(()=>(window as any).AmberSigner.login());await approve('login');
 await page.waitForFunction(pk=>(window as any).NostrSession.getPlayer().linked_pubkey===pk,pk);
 await approve('rooms');await approve('read');
 await page.waitForFunction(()=>!(document.getElementById('chatSend') as HTMLButtonElement).disabled && !sessionStorage.getItem(Object.keys(sessionStorage).find(key=>key.startsWith('word5-chat-pending:'))||''));
 check(counts.rooms===2&&counts.read===1,'full-page rooms/read returns each accepted once without signature loop');
 const message='Amber full-page chat return remains encrypted';
 await page.locator('#chatText').fill(message);await page.locator('#chatSend').click();
 await page.locator('#amberRequest button').first().waitFor();
 check(!(await page.evaluate(()=>sessionStorage.getItem(Object.keys(sessionStorage).find(key=>key.startsWith('word5-chat-pending:'))||'')))!.includes(message),'persisted send contains ciphertext, not draft plaintext');
 await approve('send');await approve('read');
 await page.locator('#chatMessages').getByText(message,{exact:true}).waitFor();
 check(counts.send===1&&service.db.query('SELECT COUNT(*) AS n FROM chat_messages').get().n===1,'full-page send returns once and reads back exact safe text');
 const readBefore=counts.read;await page.waitForTimeout(10500);
 check(counts.read===readBefore&&!await page.locator('#amberRequest').count(),'Amber has no background prompts after callback completion');
 await page.screenshot({path:join(root,'tmp/docs/handoffs/chat-amber-callback.png')});
 // Staged requests are bound to current account and the active daily word.
 await page.evaluate(()=>{
  const template={kind:30078,created_at:Math.floor(Date.now()/1000)-61,tags:[['schema','word5.chat.v1']],content:JSON.stringify({action:'rooms',nonce:'0'.repeat(32)})};
  const pk=(window as any).NostrSession.getPlayer().linked_pubkey,p=Math.floor(Date.now()/86400000);sessionStorage.setItem(`word5-chat-pending:${pk}:${p}`,JSON.stringify({pubkey:pk,period:p,template}));
 });
 await page.reload();await page.locator('#chatStatus').getByText('Chat approval expired.',{exact:false}).waitFor();
 check(!await page.evaluate(()=>sessionStorage.getItem(Object.keys(sessionStorage).find(key=>key.startsWith('word5-chat-pending:'))||'')),'stale60-second approval discarded with explicit fresh retry');
 // Cancellation leaves no staged encrypted request and allows an explicit fresh retry.
 await page.locator('#chatRefresh').click();await page.locator('#amberRequest button').first().waitFor();
 await page.evaluate(()=>(window as any).AmberSigner.cancel());
 await page.waitForFunction(()=>!sessionStorage.getItem(Object.keys(sessionStorage).find(key=>key.startsWith('word5-chat-pending:'))||''));
 check((await page.locator('#chatStatus').textContent())?.includes('cancelled'),'cancel clears exact staged request and reports retry');
 await page.locator('#chatRefresh').click();await approve('rooms');await approve('read');
 await page.locator('#chatMessages').getByText(message,{exact:true}).waitFor();
 check(true,'fresh explicit retry recovers after expired approval and cancellation');
 // Age a genuinely opened request: old Amber bookkeeping must not block retry.
 await page.locator('#chatRefresh').click();await page.locator('#amberRequest button').first().click();
 await page.evaluate(()=>{
  const pending=JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(key=>key.startsWith('word5-chat-pending:'))||'')!);pending.template.created_at-=61;
  sessionStorage.setItem(Object.keys(sessionStorage).find(key=>key.startsWith('word5-chat-pending:'))!,JSON.stringify(pending));
 });
 await page.reload();await page.locator('#chatStatus').getByText('Chat approval expired.',{exact:false}).waitFor();
 check(!await page.evaluate(()=>localStorage.getItem('word5-amber-pending-v1')),'expiry cancels only matching opened Amber chat request');
 await page.locator('#chatRefresh').click();await approve('rooms');await approve('read',true);
 await page.locator('#chatMessages').getByText(message,{exact:true}).waitFor();
 await page.waitForFunction(()=>!sessionStorage.getItem(Object.keys(sessionStorage).find(key=>key.startsWith('word5-chat-pending:'))||''));
 check(!await page.evaluate(()=>sessionStorage.getItem(Object.keys(sessionStorage).find(key=>key.startsWith('word5-chat-pending:'))||'')),'manual Amber return preserves same-identity request without duplicate submission');
 // Yesterday approval expires at the next access boundary and cannot block a fresh Today request.
 await page.locator('#chatYesterday').click();await approve('read');
 await page.waitForFunction(()=>!Object.keys(sessionStorage).some(key=>key.startsWith('word5-chat-pending:')));
 await page.locator('#chatText').fill('pending yesterday draft must disappear');await page.locator('#chatSend').click();
 await page.locator('#amberRequest button').first().waitFor();await page.locator('#amberRequest button').first().click();
 await page.evaluate(()=>{const realNow=Date.now;(window as any).realNow=realNow;Date.now=()=>(Math.floor(realNow()/86400000)+1)*86400000;window.dispatchEvent(new Event('focus'));});
 await page.waitForFunction(()=>document.getElementById('chatMessages')?.children.length===0 &&
  !(document.getElementById('chatText') as HTMLTextAreaElement).value && !Object.keys(sessionStorage).some(key=>key.startsWith('word5-chat-pending:')) && !localStorage.getItem('word5-amber-pending-v1')&&!document.getElementById('amberRequest'));
 check(await page.locator('#chatRoom').textContent()==='Today’s chat','yesterday expiry cancels only its Amber approval and clears room/draft/staging');
 await page.evaluate(()=>{Date.now=(window as any).realNow;void (window as any).Word5Chat.refresh();});await approve('rooms');await approve('read');
 await page.waitForFunction(()=>!Object.keys(sessionStorage).some(key=>key.startsWith('word5-chat-pending:')));
 check(!(await page.locator('#chatSend').isDisabled()),'fresh Today approval works after expired yesterday request');
 // Delay WebCrypto exactly where Amber staging/resume fingerprints the room.
 const holdDigest=()=>page.evaluate(()=>{
  if(!(window as any).chatDigestWrapped){const original=crypto.subtle.digest.bind(crypto.subtle);crypto.subtle.digest=(...args:any[])=>{if((window as any).holdChatDigest){(window as any).holdChatDigest=false;(window as any).chatDigestEntered=true;return new Promise((resolve,reject)=>{(window as any).releaseChatDigest=()=>original(...args).then(resolve,reject);});}return original(...args);};(window as any).chatDigestWrapped=true;}
  (window as any).chatDigestEntered=false;(window as any).holdChatDigest=true;
 });
 await holdDigest();await page.locator('#chatText').fill('stale fingerprint send');await page.locator('#chatSend').click();await page.waitForFunction(()=>(window as any).chatDigestEntered);
 await page.locator('#chatYesterday').click();await page.locator('#amberRequest button').first().waitFor();
 const yesterdayStaged=await page.evaluate(()=>Object.entries(sessionStorage).find(([key])=>key.startsWith('word5-chat-pending:')));
 await page.evaluate(()=>(window as any).releaseChatDigest());await page.waitForTimeout(100);
 check(await page.evaluate(([key,value])=>sessionStorage.getItem(key)===value,yesterdayStaged),'late send fingerprint cannot stage Today or erase Yesterday approval');await approve('read');await page.waitForFunction(()=>!Object.keys(sessionStorage).some(key=>key.startsWith('word5-chat-pending:')));
 // Resume a staged Today request, switch during its fingerprint, then resolve late.
 await page.locator('#chatToday').click();await page.locator('#amberRequest button').first().waitFor();await holdDigest();await page.evaluate(()=>{(window as any).pendingRefresh=(window as any).Word5Chat.refresh();});await page.waitForFunction(()=>(window as any).chatDigestEntered);
 await page.locator('#chatYesterday').click();await page.locator('#amberRequest button').first().waitFor();const newer=await page.evaluate(()=>Object.entries(sessionStorage).find(([key])=>key.startsWith('word5-chat-pending:')));
 await page.evaluate(()=>{(window as any).releaseChatDigest();return (window as any).pendingRefresh;});await page.waitForTimeout(100);
 check(await page.evaluate(([key,value])=>sessionStorage.getItem(key)===value,newer),'late pending fingerprint cannot resume stale room or erase new selected pending');await approve('read');await page.waitForFunction(()=>!Object.keys(sessionStorage).some(key=>key.startsWith('word5-chat-pending:')));
 check(errors.length===0,`zero browser errors: ${errors.join('; ')}`);
 await context.close();
} finally {await browser.close();server.stop(true);service.db.close();}
