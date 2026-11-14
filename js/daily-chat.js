(function () {
  let identity = null, identityMode = null, rooms = [], generation = 0, polling = false, forceScroll = true, started = false, completionHintUntil = 0;
  const $ = id => document.getElementById(id);
  const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,'0')).join('');
  const signedIn = () => {
    const p = window.NostrSession?.getPlayer?.();
    return p && (p.auth_mode === 'amber' || p.auth_mode === 'nip07' || p.auth_mode === 'bunker' || (p.auth_mode === 'session' && p.privkey));
  };
  const usesAmber = () => window.NostrSession?.getPlayer?.()?.auth_mode === 'amber';
  const initialPlayer = window.NostrSession?.getPlayer?.();
  Word5ChatCrypto.prune(sessionStorage, signedIn() ? (initialPlayer.linked_pubkey || initialPlayer.pubkey) : null);
  const pendingKey = 'word5-chat-pending-v1';
  const messagePrefix = 'word5-chat-messages:';
  let messageBinding = '', messageCursor = null, messageRecords = new Map(), retryAt = 0, readFailures = 0;
  function clearMessages() {
    messageBinding=''; messageCursor=null; messageRecords.clear();
    $('chatMessages')?.replaceChildren();
  }
  function connectionMessage(error) {
    if (error instanceof TypeError || ['AbortError','TimeoutError'].includes(error.name)) {
      return messageRecords.size ? 'Connection interrupted. Showing cached messages; tap Refresh to reconnect.' : 'Could not connect to chat. Check your connection and tap Refresh to retry.';
    }
    return error.message || 'Chat unavailable; tap Refresh to retry.';
  }
  const roomBinding = room => `${identity}:${room.period}:${room.key}`;
  async function keyFingerprint(room) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(room.key))),b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function saveMessages(room,run) {
    const key=await keyFingerprint(room);
    if (run!==generation || selectedRoom()!==room || room.expiresAt<=Date.now()) return;
    try { sessionStorage.setItem(`${messagePrefix}${identity}`,JSON.stringify({period:room.period,expiresAt:room.expiresAt,key,events:[...messageRecords.values()].map(record=>record.event),cursor:messageCursor})); } catch { /* Storage is optional; keep the visible in-memory conversation. */ }
  }
  function pendingRequest() {
    try {
      const saved=JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
      if (!saved) return null;
      const body=JSON.parse(saved.template.content);
      const current=Math.floor(Date.now()/86400000);
      if (!usesAmber() || saved.pubkey!==identity || saved.period!==current ||
          !['rooms','read','send'].includes(body.action) ||
          !Number.isSafeInteger(saved.template.created_at) || saved.template.kind!==30078 || saved.template.tags?.length!==1 || saved.template.tags[0].join(':')!=='schema:word5.chat.v1' ||
          (body.action!=='rooms' && body.period!==current)) {
        sessionStorage.removeItem(pendingKey); return null;
      }
      if (Math.abs(saved.template.created_at*1000-Date.now())>60000) {
        sessionStorage.removeItem(pendingKey);
        try {
          const amber=JSON.parse(localStorage.getItem('word5-amber-pending-v1') || 'null');
          const returned=JSON.parse(localStorage.getItem('word5-amber-returned-v1') || 'null');
          if ((amber?.type==='sign_event' && amber.pubkey===saved.pubkey && amber.event.content===saved.template.content) ||
              (!amber && returned?.event?.pubkey===saved.pubkey && returned.event.content===saved.template.content)) window.AmberSigner.cancel();
        } catch {}
        throw new Error('Chat approval expired. Tap Refresh messages to approve a fresh request.');
      }
      return saved;
    } catch(error) {
      sessionStorage.removeItem(pendingKey);
      if (error.message.startsWith('Chat approval expired')) throw error;
      return null;
    }
  }
  async function transmit(template) {
    if (!signedIn()) throw new Error('Your Nostr session is unavailable; reload to try again');
    const signer=await NostrSigners.getActiveSigner();
    const pubkey=await signer.getPublicKey();
    if (pubkey!==identity) throw new Error('Identity changed; reopen chat');
    const action=JSON.parse(template.content).action;
    const staged=usesAmber() ? JSON.stringify({pubkey,period:Math.floor(Date.now()/86400000),template}) : null;
    if (staged) sessionStorage.setItem(pendingKey,staged);
    try {
      const event=await signer.signEvent(template);
      if (event.pubkey!==identity) throw new Error('Signer identity mismatch');
      if (usesAmber() && $('amberRequest')?.textContent.includes('Amber signature received')) $('amberRequest').remove();
      const response=await fetch(`api/chat/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event}),signal:AbortSignal.timeout(15000)});
      let result;
      try { result=await response.json(); } catch { throw new Error(`Chat unavailable (${response.status}); tap Refresh to retry.`); }
      if (!response.ok || !result.ok) throw new Error(result.error || 'Chat unavailable');
      return result;
    } finally {
      // A cancelled/late operation must never erase a newer account's request.
      if (staged && sessionStorage.getItem(pendingKey)===staged) sessionStorage.removeItem(pendingKey);
    }
  }
  async function request(action, fields = {}) {
    return transmit({kind:30078,created_at:Math.floor(Date.now()/1000),tags:[['schema','word5.chat.v1']],content:JSON.stringify({action,nonce:nonce(),...fields})});
  }
  function prune() {
    const expired = rooms.some(room=>room.expiresAt<=Date.now());
    Word5ChatCrypto.prune(sessionStorage, identity);
    try {
      const pending=JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
      if (pending && (pending.pubkey!==identity || pending.period!==Math.floor(Date.now()/86400000))) sessionStorage.removeItem(pendingKey);
    } catch { sessionStorage.removeItem(pendingKey); }
    rooms = rooms.filter(room=>room.expiresAt>Date.now());
    if (expired) {
      generation++; clearMessages();
      if ($('chatText')) { $('chatText').value=''; sizeComposer(); }
      renderRooms();
      if ($('chatStatus')) $('chatStatus').textContent='A new word is here. Finish today’s puzzle to join its chat.';
    }
    const nav = $('chatNav');
    if (nav) nav.hidden = !rooms.length && Date.now() >= completionHintUntil;
  }
  async function refresh() {
    const run = ++generation;
    retryAt=0;
    if (!signedIn()) {
      identity=null; rooms=[]; clearMessages(); prune(); renderRooms();
      if ($('chatStatus')) $('chatStatus').textContent='Finish today’s puzzle to unlock chat.';
      return;
    }
    try {
      const signer=await NostrSigners.getActiveSigner(), pk=await signer.getPublicKey();
      if (run!==generation) return;
      if (identity && identity!==pk) { rooms=[]; clearMessages(); }
      identity=pk; identityMode=window.NostrSession?.getPlayer?.()?.auth_mode;
      Word5ChatCrypto.prune(sessionStorage,identity);
      // The same tab's previously authorized current-day key may restore its
      // ciphertext cache offline. Completion is immutable; new reads still use
      // signed server authorization and no previous-day room is restored.
      if (!rooms.length) {
        try { rooms=JSON.parse(sessionStorage.getItem(`word5-chat:${identity}`)||'[]').filter(room=>room.period===Math.floor(Date.now()/86400000)&&room.expiresAt===(room.period+1)*86400000&&typeof room.key==='string'); } catch { rooms=[]; }
      }
      prune(); renderRooms();
      const oldRoom=selectedRoom();
      if (oldRoom) await hydrateMessages(oldRoom,run);
      if (run!==generation) return;
      const pending=pendingRequest();
      let result;
      if (pending) {
        const action=JSON.parse(pending.template.content).action;
        const resumed=await transmit(pending.template);
        if (run!==generation || !signedIn()) return;
        if (action==='rooms') result=resumed;
        else if (selectedRoom()?.period===pending.period) {
          await read(action==='read' ? resumed : null,true); return;
        }
      }
      result ||= await request('rooms');
      if (run!==generation || !signedIn()) return;
      const previous=selectedRoom();
      const next=result.rooms[0];
      if (!next || !previous || roomBinding(next)!==roomBinding(previous)) { rooms=result.rooms; clearMessages(); }
      // Retain the same room object so existing DOM/enrichment guards stay valid.
      else rooms=[previous];
      sessionStorage.setItem(`word5-chat:${identity}`,JSON.stringify(rooms));
      prune(); renderRooms();
      if (!rooms.length) { sessionStorage.removeItem(`${messagePrefix}${identity}`); }
      if ($('chatStatus')) $('chatStatus').textContent=rooms.length ? '' : 'Finish today’s puzzle to unlock chat.';
      await read(null,true);
    } catch(error) { if (run===generation && $('chatStatus')) $('chatStatus').textContent=connectionMessage(error); }
  }
  function updateEmpty() {
    const empty = $('chatEmpty');
    if (!empty) return;
    const hasMessages = $('chatMessages').children.length > 0;
    empty.hidden = hasMessages;
    $('chatMarker').hidden = !hasMessages;
    empty.querySelector('h2').textContent = rooms.length ? 'You made it. Let’s talk.' : 'Your post-game hangout';
    empty.querySelector('p').textContent = rooms.length ? 'How did you find today’s word? Be the first to start the conversation.' : 'Finish today’s puzzle to join the conversation with other players.';
  }
  function sizeComposer() {
    const input = $('chatText');
    if (!input) return;
    input.style.height = '40px';
    input.style.height = `${Math.min(128, Math.max(40, input.scrollHeight))}px`;
  }
  function renderRooms() {
    const title = $('chatRoom');
    if (!title) return;
    const room = rooms[0];
    title.textContent = room ? `${room.date} · ${room.word}` : 'Daily chat';
    $('chatSend').disabled=!room;
    if ($('chatText')) $('chatText').disabled=!room;
    updateCountdown();
    if (!rooms.length) { $('chatMessages').replaceChildren(); $('chatExpiry').textContent=''; }
    updateEmpty();
  }
  const selectedRoom = () => rooms[0];
  function updateCountdown() {
    if (!$('chatExpiry')) return;
    const room=selectedRoom();
    if(room) {
      const seconds=Math.max(0,Math.ceil((room.expiresAt-Date.now())/1000));
      const days=Math.floor(seconds/86400), hours=Math.floor(seconds%86400/3600), minutes=Math.floor(seconds%3600/60);
      $('chatExpiry').textContent=`Closes in ${days ? `${days}d ` : ''}${hours}h ${minutes}m`;
      $('chatExpiry').title=`Room closes ${new Date(room.expiresAt).toISOString().replace('.000Z',' UTC')}`;
      if ($('chatMarker')) $('chatMarker').textContent=`${room.date} · shared with finishers`;
    }
  }
  // Metadata is optional: display messages immediately, then enrich their fixed
  // header/avatar slots without replacing nodes or moving the reader's scroll.
  const senderCache=new Map(), senderQueue=[];
  let senderLookups=0;
  function drainSenders() {
    while (senderLookups<3 && senderQueue.length) {
      const job=senderQueue.shift(); senderLookups++;
      void job().finally(()=>{ senderLookups--; drainSenders(); });
    }
  }
  function senderDetails(pubkey, period) {
    const key=`${period}:${pubkey}`;
    if (!senderCache.has(key)) {
      if (senderQueue.length>=200) return Promise.resolve({});
      if (senderCache.size>=256) senderCache.delete(senderCache.keys().next().value);
      senderCache.set(key,new Promise(resolve=>{
        senderQueue.push(async()=>{
          if (period!==Math.floor(Date.now()/86400000)) { resolve({}); return; }
          let timeout;
          const profile=Promise.race([
            Promise.resolve().then(()=>window.NostrUI?.loadProfile(pubkey)),
            new Promise(resolve=>{ timeout=setTimeout(()=>resolve(null),4000); })
          ]).catch(()=>null).finally(()=>clearTimeout(timeout));
          const result=(async()=>{
            try {
              const response=await fetch(`api/player-history?pubkey=${encodeURIComponent(pubkey)}`,{cache:'no-store',signal:AbortSignal.timeout(5000)});
              const report=await response.json();
              if (response.ok && report.ok && report.pubkey===pubkey && report.periodId===period && report.completed===true && /^[1-6X]$/.test(report.currentResult)) return report.currentResult;
            } catch {}
            return null;
          })();
          const details=await Promise.all([profile,result]);
          resolve({profile:details[0],result:details[1]});
        });
        drainSenders();
      }));
    }
    return senderCache.get(key);
  }
  function enrichSender(item, pubkey, room, run, viewer) {
    void senderDetails(pubkey,room.period).then(({profile,result})=>{
      if (run!==generation || identity!==viewer || selectedRoom()!==room || room.expiresAt<=Date.now() || !item.isConnected) return;
      const sender=item.querySelector('.message-name'), avatar=item.querySelector('.message-avatar');
      if (profile?.name) {
        sender.textContent=profile.name;
        item.querySelector('.message-own').hidden=pubkey!==viewer || profile.name==='You';
        avatar.textContent=profile.name.trim().split(/\s+/).slice(0,2).map(word=>Array.from(word)[0]).join('').toUpperCase();
      }
      if (profile?.picture) {
        // Revalidate even if a caller provides a cached/custom profile resolver.
        try {
          const url=new URL(profile.picture);
          if (['https:','http:'].includes(url.protocol) && !url.username && !url.password) {
            const image=document.createElement('img'); image.alt=''; image.width=30;image.height=30;image.loading='lazy';image.decoding='async';image.referrerPolicy='no-referrer';
            image.addEventListener('error',()=>image.remove(),{once:true}); image.src=url.href;avatar.append(image);
          }
        } catch {}
      }
      if (result) {
        const badge=item.querySelector('.message-result');badge.textContent=`${result}/6`;
        badge.setAttribute('aria-label',result==='X' ? '6 guesses · not solved' : `${result} of 6 guesses`);
        badge.title=badge.getAttribute('aria-label');
      }
    }).catch(()=>{});
  }
  function messageNode(event,text) {
          const own = event.pubkey === identity;
          const item = document.createElement('li'); item.className=`chat-message${own ? ' own' : ''}`; item.dataset.messageId=event.id;
          const avatar=document.createElement('div'); avatar.className='message-avatar'; avatar.textContent=own ? 'ME' : event.pubkey.slice(0,2).toUpperCase(); avatar.setAttribute('aria-hidden','true');
          avatar.style.setProperty('--avatar-hue',String(parseInt(event.pubkey.slice(0,6),16)%360));
          const content=document.createElement('div'); content.className='message-content';
          item.dataset.senderPubkey=event.pubkey;
          const meta=document.createElement('div'); meta.className='message-meta';
          const sender=document.createElement('span'); sender.className='message-name'; sender.textContent=own ? 'You' : `${event.pubkey.slice(0,6)}…${event.pubkey.slice(-4)}`; sender.title=event.pubkey;
          const time=document.createElement('time'); time.dateTime=new Date(event.created_at*1000).toISOString(); time.textContent=new Date(event.created_at*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); time.title=new Date(event.created_at*1000).toLocaleString();
          const message=document.createElement('p'); message.className='message-bubble'; message.textContent=text;
          const ownLabel=document.createElement('span');ownLabel.className='message-own';ownLabel.textContent=own ? 'You' : '';ownLabel.hidden=true;
          const badge=document.createElement('span');badge.className='message-result';
          meta.append(sender,ownLabel,badge,time); content.append(meta,message); item.append(avatar,content); return item;
  }
  async function mergeMessages(events,room,run,reset=false) {
    const {verifyEvent,getEventHash}=await import('https://esm.sh/nostr-tools@2?bundle');
    const next=reset ? new Map() : new Map(messageRecords);
    for (const event of events) {
      if (next.has(event.id)) continue;
      const known=messageRecords.get(event.id);
      if (known) { next.set(event.id,known); continue; }
      try {
        if (!verifyEvent(event)||getEventHash(event)!==event.id||event.kind!==30078||event.tags.length!==1||event.tags[0].join(':')!=='schema:word5.chat.v1') continue;
        const body=JSON.parse(event.content);
        if (body.period!==room.period||body.action!=='send') continue;
        const text=await Word5ChatCrypto.decrypt(body,room.key,event.pubkey);
        const node=messageNode(event,text); next.set(event.id,{event,node});
      } catch { /* Ignore malformed, unauthentic or wrong-key ciphertext. */ }
    }
    if (run!==generation||selectedRoom()!==room||room.expiresAt<=Date.now()) return false;
    while(next.size>200) next.delete(next.keys().next().value);
    const list=$('chatMessages'),history=$('chatHistory');
    const follow=forceScroll||!history||history.scrollHeight-history.scrollTop-history.clientHeight<100;
    for (const [id,record] of messageRecords) if(!next.has(id)) record.node.remove();
    let position=0;
    for (const record of next.values()) { if(list.children[position]!==record.node) list.insertBefore(record.node,list.children[position]||null);position++; }
    messageRecords=next;
    for(const {node} of next.values()) if(node.isConnected&&node.dataset.metadataGeneration!==String(run)) {
      node.dataset.metadataGeneration=String(run);enrichSender(node,node.dataset.senderPubkey,room,run,identity);
    }
    updateEmpty();
    if(follow&&history) history.scrollTop=history.scrollHeight;
    forceScroll=false;
    return true;
  }
  async function hydrateMessages(room,run) {
    if (!$('chatMessages')||run!==generation||selectedRoom()!==room||room.expiresAt<=Date.now()) return;
    const binding=roomBinding(room);
    if (messageBinding===binding) return;
    clearMessages(); messageBinding=binding;
    try {
      const cached=JSON.parse(sessionStorage.getItem(`${messagePrefix}${identity}`)||'null');
      if (!cached||cached.period!==room.period||cached.expiresAt!==room.expiresAt||cached.key!==await keyFingerprint(room)||!Array.isArray(cached.events)||cached.events.length>200) return;
      if (await mergeMessages(cached.events,room,run,true)) messageCursor=typeof cached.cursor==='string'&&/^[0-9a-f]{64}$/.test(cached.cursor) ? cached.cursor : null;
    } catch { /* An invalid cache never replaces a valid server response. */ }
  }
  async function read(resumed=null,manual=false) {
    const room=selectedRoom(),run=generation;
    if (!$('chatMessages')||!room||polling||(!manual&&Date.now()<retryAt)) return;
    polling=true;
    try {
      await hydrateMessages(room,run);
      if(run!==generation||selectedRoom()!==room) return;
      const result=resumed||await request('read',{period:room.period,...(messageCursor?{after:messageCursor}:{})});
      if (!Array.isArray(result.messages)||result.messages.length>200) throw new Error('Invalid chat response');
      // Old servers ignore `after` and return a full snapshot; no client upgrade
      // requires a simultaneous server rollout.
      const incremental=typeof result.reset==='boolean'&&('cursor' in result);
      if(await mergeMessages(result.messages,room,run,!incremental||result.reset)) {
        messageCursor=incremental&&typeof result.cursor==='string'&&/^[0-9a-f]{64}$/.test(result.cursor) ? result.cursor : null;
        readFailures=0;retryAt=0;
        if($('chatStatus'))$('chatStatus').textContent='';
        await saveMessages(room,run);
      }
    } catch(error) {
      if(run===generation) { retryAt=Date.now()+Math.min(60000,10000*2**Math.min(readFailures++,3));$('chatStatus').textContent=connectionMessage(error); }
    } finally { polling=false; }
  }
  async function discuss() {
    if (!signedIn()) { $('loginNostrBtn')?.click(); return; }
    await window.Word5App?.recordCompletedScore?.();
    location.href='chat.html';
  }
  window.Word5Chat={refresh,discuss};
  document.addEventListener('visibilitychange',()=>{ if (!document.hidden) { prune(); if (!usesAmber()) void read(); } });
  window.addEventListener('focus',()=>{ prune(); });
  window.addEventListener('online',()=>{ retryAt=0;if (!usesAmber()) { if(selectedRoom())void read(null,true);else void refresh(); } });
  window.addEventListener('player-ready',()=>{
    if (!started) return;
    const p=window.NostrSession?.getPlayer?.();
    const nextIdentity=signedIn() ? (p.linked_pubkey || p.pubkey) : null;
    // Amber manual returns notify player-ready for the same account. Keep the
    // in-flight request alive instead of submitting its callback twice.
    if (nextIdentity===identity && p?.auth_mode===identityMode) return;
    if ($('chatText')) $('chatText').value='';
    completionHintUntil=0;
    generation++; identity=null; rooms=[]; forceScroll=true; clearMessages();
    Word5ChatCrypto.prune(sessionStorage,nextIdentity);
    try { if (JSON.parse(sessionStorage.getItem(pendingKey) || 'null')?.pubkey!==nextIdentity) sessionStorage.removeItem(pendingKey); } catch { sessionStorage.removeItem(pendingKey); }
    renderRooms(); if (!usesAmber() || $('chatMessages')) void refresh();
  });
  window.addEventListener('word5-completed',()=>{
    if (usesAmber() && !$('chatMessages')) { completionHintUntil=(Math.floor(Date.now()/86400000)+1)*86400000; prune(); return; }
    void refresh();
  });
  document.addEventListener('DOMContentLoaded',async()=>{
    await NostrSigners.ready();
    started = true;
    $('discussGame')?.addEventListener('click',discuss);
    $('chatRefresh')?.addEventListener('click',()=>void refresh());
    $('chatLogin')?.addEventListener('click',()=>$('loginNostrBtn')?.click());
    $('chatForm')?.addEventListener('submit',async event=>{
      event.preventDefault(); const room=selectedRoom(), run=generation;
      if (!room || room.expiresAt<=Date.now()) { prune(); return; }
      $('chatSend').disabled=true;
      try {
        // Encryption AAD uses the same nonce as the signed request.
        const messageNonce=nonce(),submittedText=$('chatText').value;
        const payload=await Word5ChatCrypto.encrypt(submittedText,room.key,room.period,identity,messageNonce);
        await request('send',{period:room.period,nonce:messageNonce,...payload});
        if(run===generation) { if($('chatText').value===submittedText) { $('chatText').value=''; sizeComposer(); } forceScroll=true; $('chatStatus').textContent=''; await read(null,true); }
      } catch(error) { if(run===generation) $('chatStatus').textContent=connectionMessage(error); }
      finally { if(run===generation) $('chatSend').disabled=!selectedRoom(); }
    });
    $('chatText')?.addEventListener('input',sizeComposer);
    $('chatText')?.addEventListener('keydown',event=>{
      if(event.key==='Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer:coarse)').matches) { event.preventDefault(); if(!$('chatSend').disabled) $('chatForm').requestSubmit(); }
    });
    if ($('chatHistory') && window.visualViewport) {
      const fitViewport=()=>{ document.body.style.height=`${window.visualViewport.height}px`; };
      window.visualViewport.addEventListener('resize',fitViewport); fitViewport();
    }
    setInterval(()=>{
      const before=rooms.length; prune(); if(before!==rooms.length) renderRooms();
      updateCountdown();
    },1000);
    if ($('chatMessages')) setInterval(()=>{ if (!usesAmber()) void read(); },10000);
    if (!usesAmber() || $('chatMessages')) await refresh();
  });
})();
