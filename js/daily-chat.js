(function () {
  let identity = null, rooms = [], generation = 0, polling = false, forceScroll = true;
  const $ = id => document.getElementById(id);
  const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,'0')).join('');
  const signedIn = () => {
    const p = window.NostrSession?.getPlayer?.();
    return p && (p.auth_mode === 'nip07' || p.auth_mode === 'bunker' || (p.auth_mode === 'session' && p.privkey));
  };
  const initialPlayer = window.NostrSession?.getPlayer?.();
  Word5ChatCrypto.prune(sessionStorage, signedIn() ? (initialPlayer.linked_pubkey || initialPlayer.pubkey) : null);
  async function request(action, fields = {}) {
    if (!signedIn()) throw new Error('Your Nostr session is unavailable; reload to try again');
    const signer = await NostrSigners.getActiveSigner();
    const pubkey = await signer.getPublicKey();
    if (pubkey !== identity) throw new Error('Identity changed; reopen chat');
    const event = await signer.signEvent({kind:30078, created_at:Math.floor(Date.now()/1000), tags:[['schema','word5.chat.v1']], content:JSON.stringify({action,nonce:nonce(),...fields})});
    if (event.pubkey !== identity) throw new Error('Signer identity mismatch');
    const response = await fetch(`api/chat/${action}`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event})});
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'Chat unavailable');
    return result;
  }
  function prune() {
    Word5ChatCrypto.prune(sessionStorage, identity);
    rooms = rooms.filter(room=>room.expiresAt>Date.now());
    const nav = $('chatNav');
    if (nav) nav.hidden = !rooms.length;
  }
  async function refresh() {
    const run = ++generation;
    rooms = []; forceScroll=true;
    if ($('chatNav')) $('chatNav').hidden=true;
    renderRooms();
    if (!signedIn()) { identity = null; prune(); if ($('chatStatus')) $('chatStatus').textContent = 'Finish a daily puzzle to unlock chat.'; return; }
    try {
      const signer = await NostrSigners.getActiveSigner();
      const pk = await signer.getPublicKey();
      if (run !== generation) return;
      identity = pk;
      Word5ChatCrypto.prune(sessionStorage, identity);
      const result = await request('rooms');
      if (run !== generation || !signedIn()) return;
      rooms = result.rooms;
      sessionStorage.setItem(`word5-chat:${identity}`,JSON.stringify(rooms));
      prune(); renderRooms();
      if ($('chatStatus')) $('chatStatus').textContent = rooms.length ? '' : 'Finish a daily puzzle to unlock its room.';
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
    empty.querySelector('p').textContent = rooms.length ? 'How did you find today’s word? Be the first to start the conversation.' : 'Finish a daily puzzle to join the conversation with other players.';
  }
  function sizeComposer() {
    const input = $('chatText');
    if (!input) return;
    input.style.height = '40px';
    input.style.height = `${Math.min(128, Math.max(40, input.scrollHeight))}px`;
  }
  function renderRooms() {
    const select = $('chatRoom');
    if (!select) return;
    const selected = select.value;
    select.replaceChildren();
    for (const room of rooms) {
      const option = document.createElement('option'); option.value=String(room.period); option.textContent=`Puzzle ${room.date} · UTC`; select.append(option);
    }
    if (rooms.some(room=>String(room.period)===selected)) select.value=selected;
    $('chatSend').disabled=!rooms.length;
    if ($('chatText')) $('chatText').disabled=!rooms.length;
    if (selected !== select.value) { $('chatMessages').replaceChildren(); forceScroll=true; void read(); }
    updateCountdown();
    if (!rooms.length) { $('chatMessages').replaceChildren(); $('chatExpiry').textContent=''; }
    updateEmpty();
  }
  const selectedRoom = () => rooms.find(room=>String(room.period)===$('chatRoom')?.value);
  function updateCountdown() {
    const room=selectedRoom();
    if(room) {
      const seconds=Math.max(0,Math.ceil((room.expiresAt-Date.now())/1000));
      const days=Math.floor(seconds/86400), hours=Math.floor(seconds%86400/3600), minutes=Math.floor(seconds%3600/60);
      $('chatExpiry').textContent=`Closes in ${days ? `${days}d ` : ''}${hours}h ${minutes}m`;
      $('chatExpiry').title=`Room closes ${new Date(room.expiresAt).toISOString().replace('.000Z',' UTC')}`;
      if ($('chatMarker')) $('chatMarker').textContent=`${room.date} · shared with finishers`;
    }
  }
  async function read() {
    const room = selectedRoom(), run = generation;
    if (!room || polling) return;
    polling = true;
    try {
      const result = await request('read',{period:room.period});
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
    await refresh();
    if (rooms.length) location.href='chat.html';
  }
  window.Word5Chat={refresh,discuss};
  window.addEventListener('player-ready',()=>{
    const p=window.NostrSession?.getPlayer?.();
    const nextIdentity=signedIn() ? (p.linked_pubkey || p.pubkey) : null;
    generation++; identity=null; rooms=[]; forceScroll=true;
    Word5ChatCrypto.prune(sessionStorage,nextIdentity);
    renderRooms(); void refresh();
  });
  window.addEventListener('word5-completed',()=>void refresh());
  document.addEventListener('DOMContentLoaded',async()=>{
    await NostrSigners.ready();
    $('discussGame')?.addEventListener('click',discuss);
    $('chatLogin')?.addEventListener('click',()=>$('loginNostrBtn')?.click());
    $('chatRoom')?.addEventListener('change',()=>{ $('chatMessages').replaceChildren(); forceScroll=true; updateEmpty(); updateCountdown(); void read(); });
    $('chatForm')?.addEventListener('submit',async event=>{
      event.preventDefault(); const room=selectedRoom(), run=generation;
      if (!room || room.expiresAt<=Date.now()) return;
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
    await refresh();
    setInterval(()=>{
      const before=rooms.length; prune(); if(before!==rooms.length) renderRooms();
      updateCountdown();
    },1000);
    if ($('chatMessages')) setInterval(()=>void read(),10000);
  });
})();
