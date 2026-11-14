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
      const response=await fetch(`api/chat/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event})});
      const result=await response.json();
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
      generation++;
      if ($('chatText')) { $('chatText').value=''; sizeComposer(); }
      renderRooms();
      if ($('chatStatus')) $('chatStatus').textContent='A new word is here. Finish today’s puzzle to join its chat.';
    }
    const nav = $('chatNav');
    if (nav) nav.hidden = !rooms.length && Date.now() >= completionHintUntil;
  }
  async function refresh() {
    const run = ++generation;
    rooms = []; forceScroll=true;
    if ($('chatNav')) $('chatNav').hidden=true;
    renderRooms();
    if (!signedIn()) { identity = null; prune(); if ($('chatStatus')) $('chatStatus').textContent = 'Finish today’s puzzle to unlock chat.'; return; }
    try {
      const signer = await NostrSigners.getActiveSigner();
      const pk = await signer.getPublicKey();
      if (run !== generation) return;
      identity = pk;
      identityMode = window.NostrSession?.getPlayer?.()?.auth_mode;
      Word5ChatCrypto.prune(sessionStorage, identity);
      const pending=pendingRequest();
      let result;
      if (pending) {
        const action=JSON.parse(pending.template.content).action;
        const cached=JSON.parse(sessionStorage.getItem(`word5-chat:${identity}`) || '[]');
        const resumed=await transmit(pending.template);
        if (run!==generation || !signedIn()) return;
        if (action==='rooms') result=resumed;
        else if (Array.isArray(cached) && cached.length===1 && cached[0].period===pending.period && cached[0].expiresAt===(pending.period+1)*86400000) {
          rooms=cached; prune(); renderRooms();
          if ($('chatStatus')) $('chatStatus').textContent='';
          await read(action==='read' ? resumed : null);
          return;
        }
      }
      result ||= await request('rooms');
      if (run !== generation || !signedIn()) return;
      rooms = result.rooms;
      sessionStorage.setItem(`word5-chat:${identity}`,JSON.stringify(rooms));
      prune(); renderRooms();
      if ($('chatStatus')) $('chatStatus').textContent = rooms.length ? '' : 'Finish today’s puzzle to unlock chat.';
      await read();
    } catch (error) { if (run===generation && $('chatStatus')) $('chatStatus').textContent = error.message; }
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
  async function read(resumed = null) {
    const room = selectedRoom(), run = generation;
    if (!$('chatMessages') || !room || polling) return;
    polling = true;
    try {
      const result = resumed || await request('read',{period:room.period});
      const {verifyEvent,getEventHash} = await import('https://esm.sh/nostr-tools@2?bundle');
      const nodes = [];
      for (const event of result.messages) {
        try {
          if (!verifyEvent(event) || getEventHash(event)!==event.id || event.kind!==30078 || event.tags.length!==1 || event.tags[0].join(':')!=='schema:word5.chat.v1') continue;
          const body = JSON.parse(event.content);
          if (body.period!==room.period || body.action!=='send') continue;
          const text = await Word5ChatCrypto.decrypt(body,room.key,event.pubkey);
          const own = event.pubkey === identity;
          const item = document.createElement('li'); item.className=`chat-message${own ? ' own' : ''}`; item.dataset.messageId=event.id;
          const avatar=document.createElement('div'); avatar.className='message-avatar'; avatar.textContent=own ? 'ME' : event.pubkey.slice(0,2).toUpperCase(); avatar.setAttribute('aria-hidden','true');
          avatar.style.setProperty('--avatar-hue',String(parseInt(event.pubkey.slice(0,6),16)%360));
          const content=document.createElement('div'); content.className='message-content';
          const meta=document.createElement('div'); meta.className='message-meta';
          const sender=document.createElement('span'); sender.className='message-name'; sender.textContent=own ? 'You' : `${event.pubkey.slice(0,6)}…${event.pubkey.slice(-4)}`; sender.title=event.pubkey;
          const time=document.createElement('time'); time.dateTime=new Date(event.created_at*1000).toISOString(); time.textContent=new Date(event.created_at*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); time.title=new Date(event.created_at*1000).toLocaleString();
          const message=document.createElement('p'); message.className='message-bubble'; message.textContent=text;
          meta.append(sender,time); content.append(meta,message); item.append(avatar,content); nodes.push(item);
        } catch { /* Ignore malformed or unauthentic ciphertext. */ }
      }
      if (run===generation && selectedRoom()===room && room.expiresAt>Date.now()) {
        const list=$('chatMessages'), history=$('chatHistory');
        const changed=nodes.length!==list.children.length || nodes.some((node,index)=>node.dataset.messageId!==list.children[index]?.dataset.messageId);
        if(changed) {
          const follow=forceScroll || !history || history.scrollHeight-history.scrollTop-history.clientHeight<100;
          list.replaceChildren(...nodes); updateEmpty();
          if(follow && history) history.scrollTop=history.scrollHeight;
        }
        forceScroll=false;
      }
    } catch(error) { if (run===generation) $('chatStatus').textContent=error.message; }
    finally { polling=false; }
  }
  async function discuss() {
    if (!signedIn()) { $('loginNostrBtn')?.click(); return; }
    await window.Word5App?.recordCompletedScore?.();
    location.href='chat.html';
  }
  window.Word5Chat={refresh,discuss};
  document.addEventListener('visibilitychange',()=>{ if (!document.hidden) { prune(); if (!usesAmber()) void read(); } });
  window.addEventListener('focus',()=>{ prune(); });
  window.addEventListener('player-ready',()=>{
    if (!started) return;
    const p=window.NostrSession?.getPlayer?.();
    const nextIdentity=signedIn() ? (p.linked_pubkey || p.pubkey) : null;
    // Amber manual returns notify player-ready for the same account. Keep the
    // in-flight request alive instead of submitting its callback twice.
    if (nextIdentity===identity && p?.auth_mode===identityMode) return;
    if ($('chatText')) $('chatText').value='';
    completionHintUntil=0;
    generation++; identity=null; rooms=[]; forceScroll=true;
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
        const messageNonce=nonce();
        const payload=await Word5ChatCrypto.encrypt($('chatText').value,room.key,room.period,identity,messageNonce);
        await request('send',{period:room.period,nonce:messageNonce,...payload});
        if(run===generation) { $('chatText').value=''; sizeComposer(); forceScroll=true; $('chatStatus').textContent=''; await read(); }
      } catch(error) { if(run===generation) $('chatStatus').textContent=error.message; }
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
