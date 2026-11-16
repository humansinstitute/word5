// Real page and browser navigation; all HTTP/relay writes use isolated recording
// transports. No product accounts or public relay writes are used.
import { resolve } from 'node:path';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
const { chromium } = await import(process.env.WORD5_PLAYWRIGHT_MODULE || 'playwright');
const root=resolve(import.meta.dir,'..'), secret=generateSecretKey(), owner=getPublicKey(secret), other=getPublicKey(generateSecretKey());
const period=Math.floor(Date.now()/86400000);
const bundle=await Bun.build({entrypoints:[resolve(root,'node_modules/nostr-tools/lib/esm/index.js')],target:'browser'});
if(!bundle.success)throw Error(String(bundle.logs));const moduleText=await bundle.outputs[0].text();
let completed=false, failLink=true;const publications:any[]=[];
const server=Bun.serve({port:0,async fetch(req){const u=new URL(req.url);
 if(u.pathname==='/tools.js')return new Response(moduleText,{headers:{'content-type':'text/javascript'}});
 if(u.pathname==='/api/player-history')return Response.json({ok:true,pubkey:u.searchParams.get('pubkey'),periodId:period,completed,currentResult:completed?'5':null,lastPuzzle:period%1000,lastPeriodId:period,coveredPeriods:[],distribution:[0,0,0,0,1,0],stats:{played:1,won:1,streak:1,maxStreak:1}});
 if(u.pathname==='/api/completion'){completed=true;return Response.json({ok:true,submission:{points:2}})}
 if(u.pathname==='/api/publication'){publications.push((await req.json()).event);return Response.json(failLink?{ok:false,error:'offline fixture'}:{ok:true},{status:failLink?503:200})}
 if(u.pathname.startsWith('/api/'))return Response.json({ok:true,rows:[],rooms:[],messages:[],count:0});
 const path=resolve(root,u.pathname==='/'?'index.html':u.pathname.slice(1));if(!path.startsWith(root+'/'))return new Response('',{status:404});
 return new Response(Bun.file(path),{headers:{'content-type':path.endsWith('.js')?'text/javascript':path.endsWith('.html')?'text/html':'text/plain'}});
}});
const browser=await chromium.launch({headless:true,...(process.env.WORD5_BROWSER_EXECUTABLE?{executablePath:process.env.WORD5_BROWSER_EXECUTABLE}:{})});
const check=(ok:unknown,label:string)=>{if(!ok)throw Error(label);console.log('PASS '+label)};
try{
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.route('https://**',r=>r.request().url().startsWith('https://esm.sh/')?r.fulfill({contentType:'text/javascript',body:`export * from '${server.url}tools.js';export class SimplePool{querySync(){return Promise.resolve([])}close(){}subscribeMany(){return {close(){}}}publish(relays,event){window.__events=(window.__events||[]).concat([event]);return [Promise.resolve('local fixture')]}}`}):r.fulfill({body:'',contentType:'text/javascript'}));
 const page=await context.newPage(),errors:string[]=[];page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(10000);page.on('pageerror',e=>errors.push(e.stack||e.message));
 await page.goto(String(server.url));await page.waitForFunction(()=>Boolean((window as any).Word5App?.recordCompletedScore));
 check(await page.locator('#reopenResultBtn').isHidden(),'unfinished game hides result action');
 const player={auth_mode:'session',privkey:Buffer.from(secret).toString('hex'),pubkey:owner,npub:nip19.npubEncode(owner),nsec:nip19.nsecEncode(secret)};
 const game={owner,periodId:period,guesses:['AUDIO','TROUT','FOCUS','HOKUM','MOGUL'],gameOver:true,won:true,stats:{played:1,won:1,streak:1,maxStreak:1}};
 await page.evaluate(({player,game})=>{localStorage.setItem('spiders.nostr.player.v1',JSON.stringify(player));localStorage.setItem(`words-game:${player.pubkey}`,JSON.stringify(game))},{player,game});
 await page.reload();await page.locator('#resultModal.visible').waitFor();
 const dismiss=async()=>{await page.locator('#resultModal').click({position:{x:2,y:2}});await page.locator('#reopenResultBtn').waitFor()};
 await dismiss();await page.locator('#reopenResultBtn').click();await page.locator('#postNostrBtn').click();await page.locator('#nostrPostConfirmModal.visible').waitFor();
 check((await page.locator('#nostrPostPreview').textContent())!.includes('WORD5'),'recovered action opens result preview');
 await page.locator('#nostrPostCancelBtn').click();check(await page.evaluate(()=>!(window as any).__events?.length),'cancel preview creates no relay write');
 await dismiss();console.log('STEP Social navigation');await Promise.all([page.waitForURL('**/social.html',{waitUntil:'domcontentloaded'}),page.locator('a[href="social.html"]').click({noWaitAfter:true})]);console.log('STEP Back navigation');await page.goBack({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>Boolean((window as any).Word5App?.recordCompletedScore));
 await page.waitForTimeout(650); // Allow the existing delayed initial result to settle after navigation.
 if(await page.locator('#resultModal').evaluate(e=>e.classList.contains('visible')))await dismiss();
 await page.locator('#reopenResultBtn').click();await page.locator('#postNostrBtn').click();await page.keyboard.press('Escape');await dismiss();
 await page.locator('#nostrAvatarBubble').click();await page.locator('#menuResultBtn').click();
 check(await page.locator('#resultModal').evaluate(e=>e.classList.contains('visible')),'Social/back and menu recover dismissed result');
 check(await page.locator('#nostrAvatarDropdown').evaluate(e=>!e.classList.contains('open')),'recovery closes menu');
 await page.screenshot({path:resolve(root,'tmp/docs/handoffs/word5-publish-web-result.png')});
 await page.locator('#postNostrBtn').click();await page.locator('#nostrPostConfirmBtn').click();await page.waitForFunction(()=>document.getElementById('postNostrBtn')?.textContent==='Retry score link');
 check(await page.evaluate(()=>((window as any).__events||[]).filter((e:any)=>e.kind===1).length===1),'explicit confirmation publishes one result to recording transport');
 await page.locator('#postNostrBtn').click();await page.waitForTimeout(100);
 check(await page.evaluate(()=>((window as any).__events||[]).filter((e:any)=>e.kind===1).length===1),'pending score-link retry never reposts');
 const saved=await page.evaluate(({owner,period})=>localStorage.getItem(`word5-publication-${period}-${owner}`),{owner,period});check(Boolean(saved),'publication persists per account and puzzle');
 failLink=false;await page.reload();await page.locator('#resultModal.visible').waitFor();await page.locator('#postNostrBtn').click();await page.waitForTimeout(100);
 check(publications.length>0&&publications.every(e=>e.id===JSON.parse(saved!).id),'reload reuses same signed event for successful score link');
 await page.evaluate(({owner,period,saved,other})=>{localStorage.removeItem(`word5-publication-${period}-${owner}`);localStorage.setItem(`word5-publication-${period}`,JSON.stringify({...JSON.parse(saved!),pubkey:other}))},{owner,period,saved,other});
 await page.reload();await page.locator('#resultModal.visible').waitFor();check(await page.locator('#postNostrBtn').textContent()==='Post to Nostr','foreign legacy post cannot mark active account posted');
 await page.evaluate(({period,saved})=>localStorage.setItem(`word5-publication-${period}`,saved!),{period,saved});await page.reload();await page.locator('#resultModal.visible').waitFor();
 check(await page.locator('#postNostrBtn').textContent()==='Retry score link','matching legacy post remains recoverable');
 completed=false;
 await page.evaluate(other=>{const p=(window as any).NostrSession.getPlayer();localStorage.setItem('spiders.nostr.player.v1',JSON.stringify({...p,linked_pubkey:other}));window.dispatchEvent(new CustomEvent('player-ready',{detail:{player:(window as any).NostrSession.getPlayer()}}))},other);
 await page.waitForFunction(()=>document.getElementById('reopenResultBtn')?.hidden);
 check(await page.locator('#resultModal').evaluate(e=>!e.classList.contains('visible')),'switch to unfinished account closes old result');
 check(await page.evaluate(owner=>JSON.parse(localStorage.getItem(`words-game:${owner}`)!).guesses.length===5,owner),'original account guesses survive navigation and switching');
 check(!errors.length,'no runtime errors: '+errors.join('; '));await context.close();
}finally{await browser.close();server.stop(true)}
