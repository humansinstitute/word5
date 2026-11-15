// Real browser integration with disposable accounts, in-memory game ledger and no relay publication.
import {resolve} from 'node:path';
import {generateSecretKey,getPublicKey,nip19,finalizeEvent} from 'nostr-tools';
import {Word5Service,getCurrentPeriodId,getDateForPeriod,getWordForPeriod} from '../src/word5';
const {chromium}=await import(process.env.WORD5_PLAYWRIGHT_MODULE||'playwright');
const root=resolve(import.meta.dir,'..'),key=generateSecretKey(),owner=getPublicKey(key),other=getPublicKey(generateSecretKey());
const service=new Word5Service({rootDir:root,dbPath:':memory:',relays:[],gamestrRelays:[]}),period=getCurrentPeriodId();
const built=await Bun.build({entrypoints:[resolve(root,'node_modules/nostr-tools/lib/esm/index.js')],target:'browser'});if(!built.success)throw Error('bundle failed');const bundle=await built.outputs[0].text();
let offline=true,posts=0;const server=Bun.serve({port:0,async fetch(req){const u=new URL(req.url);try{
 if(u.pathname==='/tools.js')return new Response(bundle,{headers:{'content-type':'text/javascript'}});
 if(u.pathname==='/api/player-history')return Response.json(req.method==='POST'?service.authenticatedHistory((await req.json()).event):service.publicPlayerHistory(u.searchParams.get('pubkey')!));
 if(u.pathname==='/api/completion'){posts++;if(offline)return Response.json({error:'offline fixture'},{status:503});return Response.json(service.complete((await req.json()).event));}
 if(u.pathname.startsWith('/api/'))return Response.json({ok:true,rows:[],games:[],rooms:[]});
 const file=resolve(root,u.pathname==='/'?'index.html':u.pathname.slice(1));return new Response(Bun.file(file),{headers:{'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'text/plain'}});
 }catch(e){return Response.json({error:String(e)},{status:400});}}});
const browser=await chromium.launch({headless:true,...(process.env.WORD5_BROWSER_EXECUTABLE?{executablePath:process.env.WORD5_BROWSER_EXECUTABLE}:{})});
const check=(v:unknown,s:string)=>{if(!v)throw Error(s);console.log('PASS '+s)};
try{
 const context=await browser.newContext();await context.route('https://**',r=>r.request().url().startsWith('https://esm.sh/')?r.fulfill({contentType:'text/javascript',body:`export * from '${server.url}tools.js';export class SimplePool{querySync(){return Promise.resolve([])}close(){}subscribeMany(){return {close(){}}}publish(){throw Error('Unexpected relay publication')}}`}):r.fulfill({body:''}));
 const draft={kind:30078,created_at:(period-1)*86400+100,tags:[['schema','word5.completion.v1']],content:JSON.stringify({game:'word5',periodId:period-1,puzzle:(period-1)%1000,date:getDateForPeriod(period-1),result:'1',guesses:[getWordForPeriod(service.answers,period-1)],hardMode:false})};
 const pending=`word5-pending-completion-${owner}-${period-1}`,otherPending=`word5-pending-completion-${other}-${period-1}`;
 await context.addInitScript(({owner,key,npub,nsec,draft,pending,otherPending})=>{if(localStorage.getItem('fixture-seeded'))return;localStorage.setItem('fixture-seeded','yes');localStorage.setItem('spiders.nostr.player.v1',JSON.stringify({auth_mode:'session',pubkey:owner,privkey:key,npub,nsec}));localStorage.setItem(pending,JSON.stringify(draft));localStorage.setItem(otherPending,JSON.stringify(draft));},{owner,key:Buffer.from(key).toString('hex'),npub:nip19.npubEncode(owner),nsec:nip19.nsecEncode(key),draft,pending,otherPending});
 const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(String(server.url));await page.waitForFunction(()=>Boolean((window as any).Word5App?.recordCompletedScore));
 await page.evaluate(()=>(window as any).Word5App.recordCompletedScore());check(await page.evaluate(k=>Boolean(JSON.parse(localStorage.getItem(k)!).sig),pending),'offline outbox retains exact signed completion');
 check(service.playerHistory(owner).stats.played===0,'offline attempt creates no invented server result');
 offline=false;await page.reload();await page.waitForFunction(k=>!localStorage.getItem(k),pending);
 check(service.playerHistory(owner).stats.played===1,'relaunch replays previous UTC day and persists exactly once');
 check(service.publicPlayerHistory(owner).stats.played===0,'public screen excludes unpublished outcome');
 check(await page.evaluate(k=>Boolean(localStorage.getItem(k)),otherPending),'other account queue remains untouched');
 await page.evaluate(()=>(window as any).Word5App.recordCompletedScore());check(service.playerHistory(owner).stats.played===1,'refresh does not duplicate offline outcome');
 check(!errors.length,'zero browser page errors');console.log(JSON.stringify({posts,ownerGames:1,publicGames:0}));
 await context.close();
}finally{await browser.close();server.stop(true);service.db.close();}
