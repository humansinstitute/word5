import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
test('browser provisional merge fills interleaved correction gaps and preserves accepted lifetime floor without counting seed twice',()=>{
 const pk='a'.repeat(64),p=20770,store:any={};
 store[`word5-pending-completion-${pk}-${p+1}`]=JSON.stringify({created_at:(p+1)*86400+10,content:JSON.stringify({periodId:p+1,result:'1'})});
 store[`word5-pending-completion-${pk}-${p-5}`]=JSON.stringify({created_at:(p-5)*86400+10,content:JSON.stringify({periodId:p-5,result:'1'})});
 const localStorage=Object.assign(store,{getItem:(k:string)=>store[k]??null});const window:any={};
 runInNewContext(readFileSync(new URL('../js/server-history.js',import.meta.url),'utf8'),{window,localStorage,Map,Set,Date,JSON,Object,Math,Error});
 const report={pubkey:pk,periodId:p+2,stats:{played:41,won:40,streak:1,maxStreak:156},lastPeriodId:p+2,correctionCreatedAt:p*86400+100,correctionAnchor:{streak:12,maxStreak:15,lastPeriod:p,covered:[]},coveredPeriods:[p+2],outcomes:[[p+2,2]]};
 const merged=window.Word5ServerHistory.withPending(report);
 expect(merged.stats).toEqual({played:42,won:41,streak:14,maxStreak:156});expect(merged.pendingPeriods).toEqual([p+1]);expect(report.stats.played).toBe(41);
});
