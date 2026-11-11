// Real shipped transport + sync controller, genuine NIP44v2 crypto. Desktop
// protocol/consuming-flow evidence only; Android approval is a separate check.
import { resolve } from 'node:path';
import { generateSecretKey, getPublicKey, nip44, finalizeEvent } from 'nostr-tools';
import { parseAmber } from './helpers/amber-contract';
const { chromium } = await import(process.env.WORD5_PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(import.meta.dir, '..');
const secret = generateSecretKey(), pubkey = getPublicKey(secret);
const key = nip44.v2.utils.getConversationKey(secret, pubkey);
const bundle = await Bun.build({ entrypoints: [resolve(root, 'node_modules/nostr-tools/lib/esm/index.js')], target: 'browser' });
const moduleText = await bundle.outputs[0].text();
const html = `<script>window.player={auth_mode:'amber',linked_pubkey:'${pubkey}'};window.NostrSession={getPlayer:()=>player,updatePlayer:p=>{player=p},whenReady:Promise.resolve()};</script><script src='/js/amber-signer.js'></script><script src='/js/nostr-signers.js'></script><script src='/js/player-sync.js'></script><script src='/harness.js'></script>`;
const harness = `window.local=JSON.parse(localStorage.getItem('fixture')||'null')||{periodId:21000,hardMode:true,guesses:['CRANE'],gameOver:false,settingsUpdatedAt:123,gameUpdatedAt:124};
window.records=JSON.parse(localStorage.getItem('records')||'[]');window.lastError=null;window.done=false;
window.build=()=>Word5PlayerSyncCore.createController({storage:localStorage,getSigner:()=>NostrSigners.getActiveSigner(),
verifyEvent:()=>true,fetchEvents:async f=>records.filter(e=>e.tags[0][1]===f['#d'][0]),isServerCompleted:async s=>false,
getLocalState:()=>local,applySettings:(p,t)=>{local.hardMode=p.hardMode;local.settingsUpdatedAt=t;localStorage.setItem('fixture',JSON.stringify(local))},applyGame:(p,t)=>{local.guesses=p.guesses;local.gameUpdatedAt=t;localStorage.setItem('fixture',JSON.stringify(local))},
onStatus:s=>window.statusDetail=s,publishEvent:async e=>{records=records.filter(r=>r.tags[0][1]!==e.tags[0][1]);records.push(e);localStorage.setItem('records',JSON.stringify(records));return [{ok:true}]}});
window.run=action=>{done=false;lastError=null;controller[action]().then(()=>done=true).catch(e=>lastError=e.message)};
window.controller=build();controller.init();AmberSigner.restore(player);`;
const server = Bun.serve({port:0,fetch(req){const p=new URL(req.url).pathname;return p==='/'?new Response(html,{headers:{'content-type':'text/html'}}):p==='/harness.js'?new Response(harness,{headers:{'content-type':'text/javascript'}}):new Response(Bun.file(resolve(root,p.slice(1))));}});
const browser=await chromium.launch({headless:true,...(process.env.WORD5_BROWSER_EXECUTABLE?{executablePath:process.env.WORD5_BROWSER_EXECUTABLE}:{})});
const context=await browser.newContext();await context.route('https://esm.sh/**',r=>r.fulfill({body:moduleText,contentType:'text/javascript'}));
const page=await context.newPage();const cdp=await context.newCDPSession(page);await cdp.send('Page.enable');let intent='';cdp.on('Page.frameRequestedNavigation',(e:any)=>{if(e.url.startsWith('intent:'))intent=e.url});
const check=(ok:any,label:string)=>{if(!ok)throw new Error(label);console.log('PASS '+label)};
const wait=()=>page.waitForFunction(()=>document.querySelector('#amberRequest button')|| (window as any).done || (window as any).lastError);
async function approve({reload=false,alter=false,manual=false}={}){
 await page.waitForFunction(()=>document.querySelector('#amberRequest button'));
 intent='';
 if(manual){await page.getByRole('button',{name:'Return result manually',exact:true}).click();await page.getByRole('button',{name:'Open Amber in copy mode',exact:true}).click();}
 else await page.locator('#amberRequest button').first().click();
 await page.waitForTimeout(30);check(!!intent,'explicit click launches request');
 const parsed=parseAmber(intent);check(parsed.params.current_user===pubkey,'current account bound');
 let value:string;
 if(parsed.params.type==='nip44_encrypt'){check(parsed.params.pubkey===pubkey,'encrypt peer bound');value=nip44.v2.encrypt(parsed.payload,key);if(alter)value=nip44.v2.encrypt('altered',key);}
 else if(parsed.params.type==='nip44_decrypt'){check(parsed.params.pubkey===pubkey,'decrypt peer bound');value=nip44.v2.decrypt(parsed.payload,key);if(alter)value='altered';}
 else value=JSON.stringify(finalizeEvent(parsed.event,secret));
 const pending=await page.evaluate(()=>JSON.parse(localStorage.getItem('word5-amber-pending-v1')!));
 if(parsed.params.type==='nip44_encrypt')check(!JSON.stringify(pending).includes(parsed.payload),'pending contains no encryption plaintext');
 if(reload){await page.reload();await page.waitForFunction(()=>!!(window as any).controller);await page.evaluate(()=> (window as any).run('enable'));await page.waitForTimeout(30);}
 if(manual){await page.getByRole('button',{name:'Return result manually',exact:true}).click();await page.locator('#amberManualResult').fill(value);await page.getByRole('button',{name:'Use result',exact:true}).click();}
 else await page.evaluate(({id,value})=>{location.hash='amber-state='+id+'&amber-result='+encodeURIComponent(value)},{id:pending.id,value});
 await page.waitForTimeout(50);
 return parsed.params.type;
}
try{
 await page.goto(String(server.url));await page.waitForFunction(()=>!!(window as any).controller);
 check(!intent&&!await page.locator('#amberRequest').count(),'init does not probe or prompt');
 await page.evaluate(()=> (window as any).run('enable'));
 check(await approve({manual:true,reload:true})==='nip44_encrypt','manual encryption survives reload via input digest');
 check(await approve({manual:true})==='nip44_decrypt','proof decrypt consumes genuine ciphertext');
 check(await approve()==='nip44_encrypt','settings encryption follows restore');
 check(await approve()==='nip44_decrypt','settings roundtrip before signing');
 check(await approve({reload:true})==='sign_event','verified ciphertext resumes signing across reload');
 // Settings publish is remembered, so game continues rather than looping settings.
 check(await approve()==='nip44_encrypt','unfinished game encryption');
 check(await approve()==='nip44_decrypt','unfinished game roundtrip');
 check(await approve()==='sign_event','only ciphertext is signed for publication');
 await page.waitForFunction(()=> (window as any).done);
 const records=await page.evaluate(()=> (window as any).records);
 check(records.length===2&&records.every((e:any)=>!e.content.includes('CRANE')&&nip44.v2.decrypt(e.content,key).startsWith('{')),'actual consuming flow publishes genuine encrypted settings and game');
 await page.evaluate(()=>{localStorage.setItem('fixture',JSON.stringify({periodId:21000,hardMode:false,guesses:[],gameOver:false,settingsUpdatedAt:0,gameUpdatedAt:0}));localStorage.removeItem('word5-amber-sync:'+ (window as any).player.linked_pubkey)});
 await page.reload();await page.waitForFunction(()=>!!(window as any).controller);
 check(!await page.locator('#amberRequest').count(),'reload remains paused with no automatic prompts');
 await page.evaluate(()=> (window as any).run('enable'));
 await approve();await approve(); // proof
 await approve({manual:true}); // settings decrypt
 await approve({manual:true,reload:true}); // game decrypt reload resume; already applied settings skipped
 await page.waitForFunction(()=> (window as any).done);
 check(await page.evaluate(()=> (window as any).local.hardMode&&(window as any).local.guesses.join()==='CRANE'),'restore applies validated settings and unfinished game after manual/reload');
 // Altered but valid ciphertext must fail the consuming roundtrip before publishing.
 await page.evaluate(()=>{(window as any).local.settingsUpdatedAt=999;(window as any).local.hardMode=false;(window as any).run('saveLocal')});
 await approve({alter:true});await approve();
 await page.waitForFunction(()=> (window as any).lastError);
 check(await page.evaluate(()=> (window as any).lastError.includes('roundtrip')&&(window as any).records.length===2),'altered encryption rejected before signing/publishing');
 check(await page.evaluate(()=> (window as any).statusDetail.state==='error'),'failure is not unsupported capability');
 await page.evaluate(()=>{(window as any).AmberSigner.cancel();localStorage.removeItem('word5-amber-sync:'+(window as any).player.linked_pubkey);(window as any).run('enable')});
 await page.waitForFunction(()=>document.querySelector('#amberRequest'));
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.waitForFunction(()=> (window as any).lastError);
 check(await page.evaluate(()=> (window as any).statusDetail.state==='error'),'cancel remains retryable error');
 console.log('ALL AMBER NIP44 CONSUMING CHECKS PASSED');
}finally{await browser.close();server.stop(true)}
