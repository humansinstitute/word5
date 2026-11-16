// Shared private browser history reader. Public boards never use this owner-only response.
(function(){
  const pendingAuth=new Map();
  const owner=()=>{const p=window.NostrSession?.getPlayer?.();return p?.linked_pubkey||p?.pubkey};
  async function authorization(pubkey){
    if(owner()!==pubkey)throw new Error('Account changed');
    const key=`word5-history-auth-${pubkey}`;
    let event;try{event=JSON.parse(localStorage.getItem(key)||'null')}catch{}
    if(event?.pubkey===pubkey&&Math.abs(event.created_at-Math.floor(Date.now()/1000))<=240)return event;
    if(pendingAuth.has(pubkey))return pendingAuth.get(pubkey);
    const request=(async()=>{await window.NostrSigners?.ready?.();const signer=await window.NostrSigners.getActiveSigner();const e=await signer.signEvent({kind:30078,created_at:Math.floor(Date.now()/1000),tags:[['schema','word5.history-request.v1']],content:''});if(owner()!==pubkey||e.pubkey!==pubkey)throw new Error('Account changed');localStorage.setItem(key,JSON.stringify(e));return e})();
    pendingAuth.set(pubkey,request);try{return await request}finally{pendingAuth.delete(pubkey)}
  }
  function withPending(report){
    const pubkey=report.pubkey,covered=new Set(report.coveredPeriods||[]),pending=Object.keys(localStorage).filter(k=>k.startsWith(`word5-pending-completion-${pubkey}-`)).map(k=>{try{const e=JSON.parse(localStorage.getItem(k));return {...JSON.parse(e.content),createdAt:e.created_at}}catch{return null}}).filter(g=>g&&!covered.has(g.periodId)&&(report.correctionCreatedAt==null||g.periodId>Math.floor(report.correctionCreatedAt/86400)||(g.periodId===Math.floor(report.correctionCreatedAt/86400)&&g.createdAt>report.correctionCreatedAt)));
    const stats={...report.stats};for(const g of pending){stats.played++;if(g.result!=='X')stats.won++;}
    if(pending.length){
      const timeline=new Map((report.outcomes||[]).map(([p,r])=>[p,r===7?'X':String(r)]));for(const g of pending)timeline.set(g.periodId,g.result);
      const anchor=report.correctionAnchor,day=report.correctionCreatedAt==null?null:Math.floor(report.correctionCreatedAt/86400);
      let run=anchor?.streak||0,last=anchor?.lastPeriod??null;
      for(const [p,r] of [...timeline].sort((a,b)=>a[0]-b[0])){
        if(anchor&&day!==null&&(p<day||(p===day&&anchor.covered.includes(p))))continue;
        run=r==='X'?0:last===p-1?run+1:1;stats.maxStreak=Math.max(stats.maxStreak,run);last=p;
      }
      stats.streak=last!==null&&last>=report.periodId-1?run:0;
    }
    return {...report,stats,pendingPeriods:pending.map(g=>g.periodId),provisional:pending.length>0};
  }
  async function read(pubkey){
    const event=await authorization(pubkey);const response=await fetch('api/player-history',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event}),cache:'no-store',signal:AbortSignal.timeout(10000)});const report=await response.json();
    if(!response.ok||!report.ok||report.pubkey!==pubkey||report.contract!=='word5.calculation.v1')throw new Error(report.error||'Server history unavailable');if(owner()!==pubkey)throw new Error('Account changed');return report;
  }
  window.Word5ServerHistory={read,withPending};
})();
