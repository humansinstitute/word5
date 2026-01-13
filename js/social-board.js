// Social Board - Displays word5 game results from Nostr
// Uses applesauce packages for RxJS-based relay subscriptions

const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social'
];

let pool = null;
let activeSubscription = null;
let profileSubscription = null;
let currentTab = 'social';
let seenEvents = new Set();
let profileCache = new Map(); // pubkey -> profile data

// Dynamic imports for applesauce packages
async function initPool() {
  const { RelayPool } = await import('https://esm.sh/applesauce-relay@5?bundle');
  pool = new RelayPool();
  return pool;
}

// Get nip19 for encoding/decoding
async function getNip19() {
  const { nip19 } = await import('https://esm.sh/nostr-tools@2?bundle');
  return nip19;
}

// Get contacts helper
async function getContactsHelper() {
  const { getPublicContacts } = await import('https://esm.sh/applesauce-core@5/helpers?bundle');
  return getPublicContacts;
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

  // Subscribe to profile events
  const sub = pool.subscription(RELAYS, [
    { kinds: [0], authors: needed, limit: needed.length }
  ]).subscribe({
    next: (response) => {
      if (response === 'EOSE') return;
      const profile = parseProfile(response);
      if (profile) {
        profileCache.set(response.pubkey, profile);
        // Update any existing posts with this profile
        updatePostsWithProfile(response.pubkey, profile);
      }
    }
  });

  // Auto-unsubscribe after 5 seconds
  setTimeout(() => sub.unsubscribe(), 5000);
}

// Update existing posts when profile loads
async function updatePostsWithProfile(pubkey, profile) {
  const nip19 = await getNip19();
  const npub = nip19.npubEncode(pubkey);

  document.querySelectorAll(`.post-card[data-pubkey="${pubkey}"]`).forEach(card => {
    const nameEl = card.querySelector('.post-name');
    const handleEl = card.querySelector('.post-handle');
    const avatarEl = card.querySelector('.post-avatar');

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
  // Simple URL regex
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

// Subscribe to word5 posts (Social tab)
async function subscribeToSocial() {
  if (!pool) await initPool();

  showLoading();
  clearPosts();

  // Subscribe to word5 tagged posts
  activeSubscription = pool.subscription(RELAYS, [
    { kinds: [1], '#t': ['word5'], limit: 50 }
  ]).subscribe({
    next: async (response) => {
      // Filter out EOSE messages
      if (response === 'EOSE') return;
      await addPost(response);
    },
    error: (err) => {
      console.error('Subscription error:', err);
      showEmptyState('Error loading posts. Please try again.');
    }
  });

  // Show empty state after timeout if no posts
  setTimeout(() => {
    const postList = document.getElementById('postList');
    if (postList.querySelector('.loading')) {
      showEmptyState('No word5 posts found yet. Be the first to share!');
    }
  }, 5000);
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

  const getPublicContacts = await getContactsHelper();

  // First, load user's contact list
  let contactsFound = false;

  const contactsSub = pool.subscription(RELAYS, [
    { kinds: [3], authors: [userPubkey], limit: 1 }
  ]).subscribe({
    next: async (response) => {
      if (response === 'EOSE') {
        if (!contactsFound) {
          showEmptyState('No contacts found for this key. Follow some people to see their word5 posts here.');
        }
        contactsSub.unsubscribe();
        return;
      }

      contactsFound = true;

      // Parse contacts
      const follows = getPublicContacts(response);

      if (follows.length === 0) {
        showEmptyState('No contacts found for this key. Follow some people to see their word5 posts here.');
        contactsSub.unsubscribe();
        return;
      }

      // Get pubkeys
      const followPubkeys = follows.map(f => f.pubkey);

      // Unsubscribe from contacts query
      contactsSub.unsubscribe();

      // Clear and start fresh
      clearPosts();
      showLoading();

      // Subscribe to word5 posts from follows
      activeSubscription = pool.subscription(RELAYS, [
        { kinds: [1], '#t': ['word5'], authors: followPubkeys, limit: 50 }
      ]).subscribe({
        next: async (response) => {
          if (response === 'EOSE') return;
          await addPost(response);
        },
        error: (err) => {
          console.error('Follows subscription error:', err);
          showEmptyState('Error loading posts from follows.');
        }
      });

      // Show empty state after timeout if no posts
      setTimeout(() => {
        const postList = document.getElementById('postList');
        if (postList.querySelector('.loading')) {
          showEmptyState('No word5 posts from your follows yet.');
        }
      }, 5000);
    },
    error: (err) => {
      console.error('Contacts subscription error:', err);
      showEmptyState('Error loading contacts.');
    }
  });

  // Timeout for contacts query
  setTimeout(() => {
    if (!contactsFound) {
      contactsSub.unsubscribe();
      showEmptyState('No contacts found for this key. Follow some people to see their word5 posts here.');
    }
  }, 5000);
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
  const streak = getTagValue(event, 'streak');
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

  const collectedEvents = [];
  const seenPubkeys = new Set();

  // Subscribe to word5 posts to find ones with streak data
  activeSubscription = pool.subscription(RELAYS, [
    { kinds: [1], '#t': ['word5'], limit: 200 }
  ]).subscribe({
    next: async (response) => {
      if (response === 'EOSE') {
        // EOSE received - now process and display leaderboard
        displayLeaderboard(collectedEvents);
        return;
      }

      // Only keep the best post per user (highest maxStreak)
      const maxStreak = getTagValue(response, 'maxStreak');
      if (maxStreak > 0) {
        // Check if we already have a post from this user
        const existingIdx = collectedEvents.findIndex(e => e.pubkey === response.pubkey);
        if (existingIdx >= 0) {
          // Keep the one with higher maxStreak
          const existingMax = getTagValue(collectedEvents[existingIdx], 'maxStreak');
          if (maxStreak > existingMax) {
            collectedEvents[existingIdx] = response;
          }
        } else {
          collectedEvents.push(response);
        }
      }
    },
    error: (err) => {
      console.error('Top subscription error:', err);
      showEmptyState('Error loading leaderboard. Please try again.');
    }
  });

  // Timeout - display whatever we have after 5 seconds
  setTimeout(() => {
    if (collectedEvents.length > 0) {
      displayLeaderboard(collectedEvents);
    }
  }, 5000);
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

// Show Top tab
function showTopTab() {
  subscribeToTop();
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
  if (activeSubscription) {
    activeSubscription.unsubscribe();
    activeSubscription = null;
  }

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
      showTopTab();
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
