// Reload every operation with genuine cryptography; this does not exercise Android approval.
import { test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as nt from 'nostr-tools';
const core = require('../js/player-sync.js');
const sk = nt.generateSecretKey(), pk = nt.getPublicKey(sk);
const key = nt.nip44.v2.utils.getConversationKey(sk, pk);
const values = new Map<string,string>();
const storage = {getItem:(k:string)=>values.get(k)||null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)};
let local = {periodId:123,guesses:['APPLE'],gameOver:false,hardMode:true,settingsUpdatedAt:100,gameUpdatedAt:101};
const events:any[] = [], statuses:any[] = [];
const source = readFileSync('js/amber-signer.js','utf8').replace("import('https://esm.sh/nostr-tools@2?bundle')",'Promise.resolve(__nt)');
const tick = () => new Promise(r=>setTimeout(r,2));
function adapter(hash='') {
  const elements = new Map<string,any>();
  const document = {body:{appendChild(e:any){elements.set(e.id,e)}},getElementById:(id:string)=>elements.get(id),addEventListener(){},
    createElement:()=>({children:[] as any[],style:{},setAttribute(){},append(...e:any[]){this.children.push(...e)},remove(){for(const[k,v]of elements)if(v===this)elements.delete(k)}})};
  let player:any={auth_mode:'amber',linked_pubkey:pk};
  const location={pathname:'/word5/',search:'',origin:'https://fixture.test',href:'',hash};
  const window:any={NostrSession:{getPlayer:()=>player,updatePlayer:(p:any)=>player=p},addEventListener(){}};
  const clone=(v:any)=>JSON.parse(JSON.stringify(v));
  runInNewContext(source,{window,document,location,history:{replaceState(){location.hash=''}},localStorage:storage,crypto,TextEncoder,URL,URLSearchParams,atob,__nt:{...nt,getEventHash:(e:any)=>nt.getEventHash(clone(e)),verifyEvent:(e:any)=>nt.verifyEvent(clone(e))},setTimeout});
  return {window,location,elements,player:()=>player,setPlayer:(p:any)=>player=p};
}
function controller(a:any) {
  return core.createController({storage,getSigner:async()=>({...a.window.AmberSigner,mode:'amber',getPublicKey:async()=>pk}),verifyEvent:nt.verifyEvent,
    fetchEvents:async(f:any)=>events.filter(e=>e.tags.some((t:any)=>t[0]==='d'&&f['#d'].includes(t[1]))),
    publishEvent:async(e:any)=>{events.push(JSON.parse(JSON.stringify(e)));return [{ok:true}]},isServerCompleted:async()=>false,
    cancelSigner:()=>a.window.AmberSigner.cancel(),getLocalState:()=>({...local}),applySettings:(p:any,t:number)=>{local.hardMode=p.hardMode;local.settingsUpdatedAt=t},applyGame:(s:any,t:number)=>{local.guesses=s.guesses;local.gameUpdatedAt=t},onStatus:(s:any)=>statuses.push(s)});
}
async function runWorkflow(reload:boolean,manual:boolean,restore=false) {
  values.clear();events.length=0;statuses.length=0;
  local={periodId:123,guesses:restore?[]:['APPLE'],gameOver:false,hardMode:!restore,settingsUpdatedAt:restore?0:100,gameUpdatedAt:restore?0:101};
  if(restore)for(const[d,v]of [[core.SETTINGS_D,core.makeSettings(true,100)],[core.GAME_D(123),core.makeGame(123,['APPLE'],true,101)]])events.push(nt.finalizeEvent({kind:30078,created_at:1,tags:[['d',d],['schema','word5.encrypted-state.v1']],content:nt.nip44.v2.encrypt(JSON.stringify(v),key)},sk));
  let a=adapter(), c=controller(a);await c.init();let done=false,error:any;
  let pending=c.enable().then(()=>done=true,e=>{done=true;error=e});
  const types:string[]=[];
  for(let i=0;i<25&&!done;i++) {
    let panel:any;for(let n=0;n<100;n++){await tick();panel=a.elements.get('amberRequest');if(panel?.children?.[1]?.onclick)break;if(done)break}
    if(done)break;if(!panel?.children?.[1]?.onclick)throw Error('No progress '+JSON.stringify(statuses.at(-1)));
    if(manual){panel.children[2].onclick();panel.children[3].children[1].onclick()}else panel.children[1].onclick();
    const request=JSON.parse(storage.getItem('word5-amber-pending-v1')!);types.push(request.type);
    const raw=a.location.href.split('#Intent;')[0].slice(7);const input=decodeURIComponent(raw);
    const output=request.type==='nip44_encrypt'?nt.nip44.v2.encrypt(input,key):request.type==='nip44_decrypt'?nt.nip44.v2.decrypt(input,key):JSON.stringify(nt.finalizeEvent(request.event,sk));
    if(reload){
      a=adapter(manual?'':`#amber-state=${request.id}&amber-result=${encodeURIComponent(output)}`);
      await a.window.AmberSigner.restore(a.player());
      if(manual){const p=a.elements.get('amberRequest');p.children[3].children[2].value=output;await p.children[3].children[4].onclick()}
      c=controller(a);await c.init();done=false;error=null;pending=c.enable().then(()=>done=true,e=>{done=true;error=e});
    }else if(manual){panel.children[3].children[2].value=output;await panel.children[3].children[4].onclick()}
    else{a.location.hash=`#amber-state=${request.id}&amber-result=${encodeURIComponent(output)}`;await a.window.AmberSigner.restore(a.player())}
    await tick();
  }
  if(!done){throw Error('Probe/workflow loop: '+types.join(','));}
  if(error)throw error;
  if(events.length!==2||events.some(e=>!nt.verifyEvent(e)))throw Error('Missing genuine encrypted publications');
  if(restore&&(local.guesses.join()!=='APPLE'||!local.hardMode||local.gameUpdatedAt!==101))throw Error('Restore did not apply exact state');

}

for (const restore of [false, true]) for (const reload of [false, true]) for (const manual of [false, true]) test(`Amber genuine crypto restore=${restore} reload=${reload} manual=${manual}`, async () => { await runWorkflow(reload, manual, restore); });

test('crypto resume binds account, peer, type and exact input; cancellation and expiry allow retry', async () => {
  values.clear(); const input = 'private fixture text & + % unicode 🧡';
  let a = adapter();
  let work = a.window.AmberSigner.nip44Encrypt(pk, input).catch((e:any) => e);
  await tick(); let panel = a.elements.get('amberRequest'); panel.children[2].onclick(); panel.children[3].children[1].onclick();
  const request = JSON.parse(storage.getItem('word5-amber-pending-v1')!);
  if (JSON.stringify(request).includes(input) || request.payload) throw Error('Persisted encryption plaintext');
  a = adapter(); await a.window.AmberSigner.restore(a.player());
  const reject = async (p:Promise<any>) => { try { await p; } catch (_) { return; } throw Error('Expected binding rejection'); };
  await reject(a.window.AmberSigner.nip44Encrypt(nt.getPublicKey(nt.generateSecretKey()), input));
  await reject(a.window.AmberSigner.nip44Encrypt(pk, input + 'changed'));
  await reject(a.window.AmberSigner.nip44Decrypt(pk, nt.nip44.v2.encrypt(input, key)));
  work = a.window.AmberSigner.nip44Encrypt(pk, input).catch((e:any) => e); await tick();
  panel = a.elements.get('amberRequest'); panel.children[2].onclick();
  panel.children[3].children[2].value = JSON.stringify(nt.finalizeEvent({kind:1,created_at:1,tags:[],content:'wrong type'},sk));
  await panel.children[3].children[4].onclick();
  if (!storage.getItem('word5-amber-pending-v1')) throw Error('Wrong scalar type destroyed recoverable request');
  a.window.AmberSigner.cancel(); if (!(await work)?.message?.includes('cancelled')) throw Error('Cancel did not reject waiter');
  work = a.window.AmberSigner.nip44Encrypt(pk, input).catch((e:any) => e); await tick();
  panel = a.elements.get('amberRequest'); panel.children[2].onclick(); panel.children[3].children[1].onclick();
  a.setPlayer({auth_mode:'amber',linked_pubkey:nt.getPublicKey(nt.generateSecretKey())});
  panel.children[3].children[2].value = nt.nip44.v2.encrypt(input,key);
  await panel.children[3].children[4].onclick();
  // Guard before accepting pasted output leaves the new identity unchanged.
  if (a.player().linked_pubkey === pk) throw Error('Account switched back');
  a.window.AmberSigner.cancel(); await work;
  const expired = {...request, at:Date.now()-16*60*1000};storage.setItem('word5-amber-pending-v1',JSON.stringify(expired));
  a=adapter();await a.window.AmberSigner.restore(a.player());
  if(storage.getItem('word5-amber-pending-v1')) throw Error('Expired request retained');
});
