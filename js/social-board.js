// Social Board - Displays word5 game results from Nostr
// Uses nostr-tools SimplePool for relay subscriptions

const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social'
];

let pool = null;
let activeSubscription = null;
let currentTab = 'social';
let seenEvents = new Set();
let profileCache = new Map(); // pubkey -> profile data

// Dynamic imports for nostr-tools
async function initPool() {
  const { SimplePool } = await import('https://esm.sh/nostr-tools@2.10.0/pool?bundle');
  pool = new SimplePool();
  return pool;
}

// Get nip19 for encoding/decoding
async function getNip19() {
  const { nip19 } = await import('https://esm.sh/nostr-tools@2.10.0?bundle');
  return nip19;
}

// Shorten npub for display
function shortenNpub(npub) {
  if (!npub || npub.length < 20) return npub;
  return npub.slice(0, 10) + '..' + npub.slice(-6);
}

// Format relative time
function formatRelativeTime(timestamp) {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) return 'now';
  if (diff < 3600) return Math.floor(diff / 60) + ' min';
  if (diff < 86400) return Math.floor(diff / 3600) + ' hr';
  if (diff < 604800) return Math.floor(diff / 86400) + ' d';
  return new Date(timestamp * 1000).toLocaleDateString();
}

// Parse profile metadata from kind:0 event
function parseProfile(event) {
  try {
    const data = JSON.parse(event.content);
    return {
      name: data.name || data.display_name,
      displayName: data.display_name || data.name,
      picture: data.picture,
      nip05: data.nip05,
      about: data.about
    };
  } catch {
    return null;
  }
}

// Load profiles for a set of pubkeys
async function loadProfiles(pubkeys) {
  if (!pool) await initPool();

  // Filter out already cached pubkeys
  const needed = pubkeys.filter(pk => !profileCache.has(pk));
  if (needed.length === 0) return;

  try {
    const events = await pool.querySync(RELAYS,
      { kinds: [0], authors: needed, limit: needed.length }
    );

    for (const event of events) {
      const profile = parseProfile(event);
      if (profile) {
        profileCache.set(event.pubkey, profile);
        updatePostsWithProfile(event.pubkey, profile);
      }
    }
  } catch (e) {
    console.log('[Profiles] Error loading profiles:', e);
  }
}

// Update existing posts when profile loads
async function updatePostsWithProfile(pubkey, profile) {
  const nip19 = await getNip19();
  const npub = nip19.npubEncode(pubkey);

  document.querySelectorAll(`[data-pubkey="${pubkey}"]`).forEach(card => {
    const nameEl = card.querySelector('.post-name, .lb-name');
    const handleEl = card.querySelector('.post-handle');
    const avatarEl = card.querySelector('.post-avatar, .lb-avatar');

    if (nameEl && profile.displayName) {
      nameEl.textContent = profile.displayName;
    }
    if (handleEl) {
      handleEl.textContent = profile.nip05 || shortenNpub(npub);
    }
    if (avatarEl && profile.picture) {
      avatarEl.innerHTML = `<img src="${escapeHtml(profile.picture)}" alt="" onerror="this.parentElement.innerHTML='👤'">`;
    }
  });
}

// Escape HTML to prevent XSS
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Convert URLs in text to links
function linkifyContent(content) {
  const urlPattern = /(https?:\/\/[^\s<]+)/g;
  return escapeHtml(content).replace(urlPattern, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

// Render a post card
async function renderPostCard(event) {
  const nip19 = await getNip19();
  const npub = nip19.npubEncode(event.pubkey);
  const relativeTime = formatRelativeTime(event.created_at);

  // Check cache for profile
  const profile = profileCache.get(event.pubkey);
  const displayName = profile?.displayName || shortenNpub(npub);
  const handle = profile?.nip05 || shortenNpub(npub);
  const avatar = profile?.picture;

  const card = document.createElement('div');
  card.className = 'post-card';
  card.dataset.eventId = event.id;
  card.dataset.pubkey = event.pubkey;

  // Avatar HTML
  let avatarHtml = '<span>👤</span>';
  if (avatar) {
    avatarHtml = `<img src="${escapeHtml(avatar)}" alt="" onerror="this.parentElement.innerHTML='👤'">`;
  }

  // Content with linkified URLs
  const contentHtml = linkifyContent(event.content);

  card.innerHTML = `
    <div class="post-avatar">${avatarHtml}</div>
    <div class="post-body">
      <div class="post-header">
        <span class="post-name">${escapeHtml(displayName)}</span>
        <span class="post-handle">${escapeHtml(handle)}</span>
        <span class="post-time">${relativeTime}</span>
      </div>
      <div class="post-content">${contentHtml}</div>
    </div>
  `;

  return card;
}

// Show empty state
function showEmptyState(message) {
  const postList = document.getElementById('postList');
  postList.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">📭</div>
      <div class="empty-state-text">${message}</div>
    </div>
  `;
}

// Show loading state
function showLoading() {
  const postList = document.getElementById('postList');
  postList.innerHTML = '<div class="loading"></div>';
}

// Clear post list
function clearPosts() {
  const postList = document.getElementById('postList');
  postList.innerHTML = '';
  seenEvents.clear();
}

// Add post to list (sorted by timestamp, newest first)
async function addPost(event) {
  // Skip if already seen
  if (seenEvents.has(event.id)) return;
  seenEvents.add(event.id);

  const postList = document.getElementById('postList');

  // Remove loading indicator if present
  const loading = postList.querySelector('.loading');
  if (loading) loading.remove();

  // Remove empty state if present
  const emptyState = postList.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const card = await renderPostCard(event);

  // Insert in sorted order (newest first)
  const existingCards = postList.querySelectorAll('.post-card');
  let inserted = false;

  for (const existing of existingCards) {
    const existingTime = parseInt(existing.dataset.createdAt || '0');
    if (event.created_at > existingTime) {
      postList.insertBefore(card, existing);
      inserted = true;
      break;
    }
  }

  if (!inserted) {
    postList.appendChild(card);
  }

  // Store timestamp for sorting
  card.dataset.createdAt = event.created_at;

  // Load profile for this user
  loadProfiles([event.pubkey]);
}

// Close active subscription
function closeSubscription() {
  if (activeSubscription) {
    try {
      activeSubscription.close();
    } catch (e) {
      // Ignore close errors
    }
    activeSubscription = null;
  }
}

// Load word5 posts (Social tab)
async function subscribeToSocial() {
  if (!pool) await initPool();

  showLoading();
  clearPosts();

  try {
    console.log('[Social] Querying word5 posts...');
    const events = await pool.querySync(RELAYS,
      { kinds: [1], '#t': ['word5'], limit: 50 }
    );

    console.log('[Social] Found', events.length, 'posts');

    if (!events || events.length === 0) {
      showEmptyState('No word5 posts found yet. Be the first to share!');
      return;
    }

    // Sort by timestamp (newest first) and add posts
    events.sort((a, b) => b.created_at - a.created_at);
    for (const event of events) {
      await addPost(event);
    }
  } catch (e) {
    console.error('[Social] Error:', e);
    showEmptyState('Error loading posts. Please try again.');
  }
}

// Subscribe to follows' posts (Follows tab)
async function subscribeToFollows() {
  if (!pool) await initPool();

  showLoading();
  clearPosts();

  // Get current player
  const player = window.NostrSession?.getPlayer();

  // Use linked_pubkey for NIP-07 users, otherwise use session pubkey
  const userPubkey = player?.auth_mode === 'nip07' && player?.linked_pubkey
    ? player.linked_pubkey
    : player?.pubkey;

  if (!userPubkey) {
    showEmptyState('No identity found. Create or import a key to see follows.');
    return;
  }

  try {
    // First, load user's contact list (kind 3)
    const contactEvents = await pool.querySync(RELAYS,
      { kinds: [3], authors: [userPubkey], limit: 1 }
    );

    if (!contactEvents || contactEvents.length === 0) {
      showEmptyState('No contacts found for this key. Follow some people to see their word5 posts here.');
      return;
    }

    // Parse contacts from p tags
    const contactEvent = contactEvents[0];
    const followPubkeys = contactEvent.tags
      .filter(t => t[0] === 'p' && t[1])
      .map(t => t[1]);

    if (followPubkeys.length === 0) {
      showEmptyState('No contacts found for this key. Follow some people to see their word5 posts here.');
      return;
    }

    console.log('[Follows] Found', followPubkeys.length, 'contacts');

    // Query word5 posts from follows
    const events = await pool.querySync(RELAYS,
      { kinds: [1], '#t': ['word5'], authors: followPubkeys, limit: 50 }
    );

    console.log('[Follows] Found', events.length, 'posts from follows');

    if (!events || events.length === 0) {
      showEmptyState('No word5 posts from your follows yet.');
      return;
    }

    // Sort by timestamp (newest first) and add posts
    events.sort((a, b) => b.created_at - a.created_at);
    for (const event of events) {
      await addPost(event);
    }

  } catch (e) {
    console.error('[Follows] Error:', e);
    showEmptyState('Error loading contacts. Please try again.');
  }
}

// Get tag value from event
function getTagValue(event, tagName) {
  const tag = event.tags.find(t => t[0] === tagName);
  return tag ? parseInt(tag[1]) || 0 : 0;
}

// Render a leaderboard entry
async function renderLeaderboardEntry(event, rank) {
  const nip19 = await getNip19();
  const npub = nip19.npubEncode(event.pubkey);

  // Check cache for profile
  const profile = profileCache.get(event.pubkey);
  const displayName = profile?.displayName || shortenNpub(npub);
  const avatar = profile?.picture;

  // Get stats from tags
  const maxStreak = getTagValue(event, 'maxStreak');
  const played = getTagValue(event, 'played');
  const won = getTagValue(event, 'won');
  const winPct = played > 0 ? Math.round((won / played) * 100) : 0;

  const entry = document.createElement('div');
  entry.className = 'leaderboard-entry';
  entry.dataset.pubkey = event.pubkey;

  // Avatar HTML
  let avatarHtml = '<span>👤</span>';
  if (avatar) {
    avatarHtml = `<img src="${escapeHtml(avatar)}" alt="" onerror="this.parentElement.innerHTML='👤'">`;
  }

  // Rank medal
  let rankDisplay = `#${rank}`;
  if (rank === 1) rankDisplay = '🥇';
  else if (rank === 2) rankDisplay = '🥈';
  else if (rank === 3) rankDisplay = '🥉';

  entry.innerHTML = `
    <div class="lb-rank">${rankDisplay}</div>
    <div class="lb-avatar">${avatarHtml}</div>
    <div class="lb-info">
      <div class="lb-name">${escapeHtml(displayName)}</div>
      <div class="lb-stats">${played} played · ${winPct}% win</div>
    </div>
    <div class="lb-streak">
      <div class="lb-streak-value">${maxStreak}</div>
      <div class="lb-streak-label">best</div>
    </div>
  `;

  return entry;
}

// Subscribe to top streaks (Top tab)
async function subscribeToTop() {
  if (!pool) await initPool();

  showLoading();
  clearPosts();

  try {
    // Query for word5 posts with streak data
    const events = await pool.querySync(RELAYS,
      { kinds: [1], '#t': ['word5'], limit: 200 }
    );

    console.log('[Top] Found', events.length, 'events');

    // Deduplicate - keep best post per user
    const bestByUser = new Map();
    for (const event of events) {
      const maxStreak = getTagValue(event, 'maxStreak');
      if (maxStreak > 0) {
        const existing = bestByUser.get(event.pubkey);
        if (!existing || maxStreak > getTagValue(existing, 'maxStreak')) {
          bestByUser.set(event.pubkey, event);
        }
      }
    }

    const collectedEvents = Array.from(bestByUser.values());
    displayLeaderboard(collectedEvents);

  } catch (e) {
    console.error('[Top] Error:', e);
    showEmptyState('Error loading leaderboard. Please try again.');
  }
}

// Display the leaderboard
async function displayLeaderboard(events) {
  const postList = document.getElementById('postList');

  // Remove loading
  const loading = postList.querySelector('.loading');
  if (loading) loading.remove();

  // Filter events that have maxStreak tag
  const withStreaks = events.filter(e => getTagValue(e, 'maxStreak') > 0);

  if (withStreaks.length === 0) {
    showEmptyState('No streak data found yet. Play and share your results to appear on the leaderboard!');
    return;
  }

  // Sort by maxStreak descending
  withStreaks.sort((a, b) => getTagValue(b, 'maxStreak') - getTagValue(a, 'maxStreak'));

  // Take top 50
  const top = withStreaks.slice(0, 50);

  // Clear and render
  postList.innerHTML = '';

  // Load profiles for all users
  loadProfiles(top.map(e => e.pubkey));

  // Render entries
  for (let i = 0; i < top.length; i++) {
    const entry = await renderLeaderboardEntry(top[i], i + 1);
    postList.appendChild(entry);
  }
}

// Get tab from URL
function getTabFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  if (['social', 'follows', 'top'].includes(tab)) {
    return tab;
  }
  return 'social'; // default
}

// Update URL with current tab
function updateUrl(tabName, replace = false) {
  const url = new URL(window.location);
  url.searchParams.set('tab', tabName);
  if (replace) {
    history.replaceState({ tab: tabName }, '', url);
  } else {
    history.pushState({ tab: tabName }, '', url);
  }
}

// Switch tab
function switchTab(tabName, updateHistory = true) {
  // Cleanup previous subscription
  closeSubscription();

  currentTab = tabName;

  // Update URL
  if (updateHistory) {
    updateUrl(tabName);
  }

  // Update tab styling
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });

  // Load appropriate content
  switch (tabName) {
    case 'social':
      subscribeToSocial();
      break;
    case 'follows':
      subscribeToFollows();
      break;
    case 'top':
      subscribeToTop();
      break;
  }
}

// Initialize
async function init() {
  // Wait for NostrSession to be ready
  if (window.NostrSession?.whenReady) {
    await window.NostrSession.whenReady;
  }

  // Initialize pool
  await initPool();

  // Bind tab clicks
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchTab(tab.dataset.tab);
    });
  });

  // Handle browser back/forward
  window.addEventListener('popstate', (e) => {
    const tab = e.state?.tab || getTabFromUrl();
    switchTab(tab, false); // Don't update history on popstate
  });

  // Load initial tab from URL (use replaceState to set initial state)
  const initialTab = getTabFromUrl();
  updateUrl(initialTab, true); // Replace current history entry
  switchTab(initialTab, false); // Don't push to history
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
