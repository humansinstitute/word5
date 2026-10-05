// Optional real-browser smoke: Bun serves only an ephemeral isolated test DB.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { Word5Service, getCurrentPeriodId, getWordForPeriod } from '../src/word5';
import { DailyChat } from '../src/chat';
const {chromium} = await import(process.env.WORD5_PLAYWRIGHT_MODULE || 'playwright');
const dir=mkdtempSync(join(tmpdir(),'word5-browser-')),root=resolve(import.meta.dir,'..');
mkdirSync(join(dir,'assets'));writeFileSync(join(dir,'assets/answers.txt'),'apple\nbrave\ncrane\n');writeFileSync(join(dir,'assets/wla.txt'),'apple\nbrave\ncrane\nother\n');
const service=new Word5Service({rootDir:dir,dbPath:join(dir,'isolated.sqlite'),relays:[],gamestrRelays:[]}),chat=new DailyChat(service);
const bundled=await Bun.build({entrypoints:[join(root,'node_modules/nostr-tools/lib/esm/index.js')],target:'browser',format:'esm'});
if(!bundled.success) throw new Error('Unable to bundle test browser Nostr dependency');
const bundle=await bundled.outputs[0].text();
const server=Bun.serve({port:0,async fetch(req){const url=new URL(req.url);try {
 if(url.pathname.startsWith('/api/chat/')) return Response.json(chat.request((await req.json()).event,url.pathname.split('/').at(-1)!));
 if(url.pathname==='/api/completion') return Response.json(service.complete((await req.json()).event));
 if(url.pathname.startsWith('/api/')) return Response.json({ok:true,games:[],rows:[]});
 const path=url.pathname==='/'?'index.html':url.pathname.slice(1);
 const file=Bun.file(join(path.startsWith('assets/')?dir:root,path));
 return new Response(file,{headers:{'content-type':path.endsWith('.js')?'text/javascript':path.endsWith('.html')?'text/html':'text/plain'}});
 } catch(error) { return Response.json({ok:false,error:(error as Error).message},{status:400}); }
}});
const browser=await chromium.launch({headless:true});
const errors:string[]=[];
try {
 for(const loss of [false,true]) {
  const sk=generateSecretKey(),pk=getPublicKey(sk),period=getCurrentPeriodId();
  const context=await browser.newContext();
  await context.route('https://esm.sh/**',route=>route.fulfill({body:bundle,contentType:'text/javascript'}));
  await context.route('wss://**',route=>route.abort());
  await context.exposeFunction('testSign',event=>JSON.parse(JSON.stringify(finalizeEvent(event,sk))));
  await context.addInitScript(({pk,npub,period,loss})=>{
   localStorage.setItem('spiders.nostr.player.v1',JSON.stringify({privkey:'test-only-unused',nsec:'test-only-unused',auth_mode:'nip07',pubkey:pk,linked_pubkey:pk,npub,linked_npub:npub}));
   (window as any).nostr={getPublicKey:async()=>pk,signEvent:(window as any).testSign};
   if(location.pathname==='/index.html') localStorage.setItem('words-game',JSON.stringify({periodId:period,gameOver:false,won:false,guesses:[],stats:{played:0,won:0,currentStreak:0,maxStreak:0,distribution:[0,0,0,0,0,0]}}));
  },{pk,npub:nip19.npubEncode(pk),period,loss});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${server.url}index.html`);await page.waitForFunction(()=>Boolean((window as any).Word5App?.recordCompletedScore));
  const answer=getWordForPeriod(service.answers,period);
  for(const word of loss?Array(6).fill('OTHER'):[answer]) {await page.keyboard.type(word);await page.keyboard.press('Enter');await page.waitForTimeout(2100);}
  await page.locator('#discussGame').waitFor({state:'visible'});
  await page.locator('#chatNav').waitFor({state:'visible',timeout:5000}).catch(async e=>{ console.log('Debug:',await page.locator('#scoreStatus').textContent(),errors);throw e; });
  await page.locator('#discussGame').click();await page.waitForURL('**/chat.html');
  await page.waitForFunction(()=>!(document.getElementById('chatSend') as HTMLButtonElement).disabled);
  const text=`${loss?'loss':'win'} <img src=x onerror=alert(1)>`;
  await page.locator('#chatText').fill(text);await page.locator('#chatSend').click();
  await page.locator('#chatMessages').getByText(text,{exact:true}).waitFor();
  if(await page.locator('#chatMessages img').count()) throw new Error('Unsafe rendering');
  if(!(await page.locator('#chatExpiry').textContent())?.includes('Expires in')) throw new Error('Countdown missing');
  await page.reload();await page.locator('#chatMessages').getByText(text,{exact:true}).waitFor();
  if(!loss) {
   await page.route('**/api/chat/rooms',async route=>{
    const response=await route.fetch();
    await page.evaluate(()=>{(window as any).NostrSession.updatePlayer({auth_mode:'session',imported_at:null,linked_pubkey:null});});
    await route.fulfill({response});
   });
   await page.evaluate(()=> (window as any).Word5Chat.refresh());
   await page.waitForFunction(()=>document.getElementById('chatMessages')?.children.length===0 && !Object.keys(sessionStorage).some(key=>key.startsWith('word5-chat:')));
   await page.unroute('**/api/chat/rooms');
   await page.evaluate(pk=>{(window as any).NostrSession.updatePlayer({auth_mode:'nip07',linked_pubkey:pk});},pk);
   await page.locator('#chatMessages').getByText(text,{exact:true}).waitFor();
   console.log('Delayed room-key response after identity change is discarded');
  }
  await page.evaluate(()=>{ const originalNow=Date.now; Date.now=()=> (Math.floor(originalNow()/86400000)+3)*86400000; });
  await page.waitForFunction(()=>document.getElementById('chatMessages')?.children.length===0 && Object.keys(sessionStorage).filter(key=>key.startsWith('word5-chat:')).every(key=>JSON.parse(sessionStorage.getItem(key)!).length===0));
  await page.evaluate(()=>{(window as any).NostrSession.updatePlayer({auth_mode:'session',imported_at:null,linked_pubkey:null});});
  await page.waitForFunction(()=>document.getElementById('chatMessages')?.children.length===0 && !Object.keys(sessionStorage).some(key=>key.startsWith('word5-chat:')));
  await context.close();console.log(`Browser ${loss?'loss':'win'} completion → chat → encrypted safe text → reload → exact expiry → identity cleanup passed`);
 }
 // Actual anonymous finish followed by NIP-07 login, on a narrow mobile viewport.
 for(const loss of [false,true]) {
  const sk=generateSecretKey(),pk=getPublicKey(sk);
  const context=await browser.newContext({viewport:{width:320,height:667}});
  await context.route('https://esm.sh/**',route=>route.fulfill({body:bundle,contentType:'text/javascript'}));
  await context.exposeFunction('testSign',event=>JSON.parse(JSON.stringify(finalizeEvent(event,sk))));
  await context.addInitScript(pk=>{(window as any).nostr={getPublicKey:async()=>pk,signEvent:(window as any).testSign};},pk);
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(`${server.url}index.html`);
  await page.waitForFunction(()=>Boolean((window as any).Word5App?.recordCompletedScore));
  for(const word of loss?Array(6).fill('OTHER'):[getWordForPeriod(service.answers,getCurrentPeriodId())]) {await page.keyboard.type(word);await page.keyboard.press('Enter');await page.waitForTimeout(2100);}
  await page.locator('#discussGame').waitFor({state:'visible'});await page.locator('#discussGame').click();await page.locator('#loginChooserModal').waitFor({state:'visible'});
  if(await page.locator('#chatNav').isVisible()) throw new Error('Anonymous chat navigation');
  await page.locator('#loginOptExtension').click();await page.locator('#chatNav').waitFor({state:'visible'});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth || document.querySelector('.title')!.getBoundingClientRect().right > document.querySelector('.header-right')!.getBoundingClientRect().left)) throw new Error('Mobile play header overflow or overlap');
  await page.locator('#discussGame').click();await page.waitForURL('**/chat.html');await page.waitForFunction(()=>!(document.getElementById('chatSend') as HTMLButtonElement).disabled);
  const text=Array(60).fill('long mobile text line').join('\n');
  await page.locator('#chatText').fill(text);await page.locator('#chatSend').click();await page.locator('#chatMessages').getByText(text,{exact:true}).waitFor();
  await page.locator('#chatText').scrollIntoViewIfNeeded();
  const dimensions=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,height:document.documentElement.scrollHeight,screen:innerHeight,scroll:scrollY}));
  if(dimensions.width>dimensions.viewport || dimensions.height<=dimensions.screen || dimensions.scroll<=0) throw new Error(`Mobile scrolling failed: ${JSON.stringify(dimensions)}`);
  await page.locator('#chatText').fill('composer reachable');
  await context.close();console.log(`Anonymous ${loss?'loss':'win'} → NIP-07 login → unlock → mobile header and long chat scrolling passed`);
 }
 if(errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
 console.log('All browser page-error checks passed');
} finally { await browser.close();server.stop(true);service.db.close();rmSync(dir,{recursive:true,force:true}); }
