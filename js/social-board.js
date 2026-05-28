// Social Board - Displays word5 game results from Nostr
// Uses nostr-tools SimplePool for relay queries and comparison shares.

const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.snort.social",
];

const COMPARE_WINDOW_DAYS = 21;
const BLOSSOM_UPLOAD_SERVER = "https://blossom.primal.net";
const SCORE_BY_RESULT = {
  "1": 10,
  "2": 7,
  "3": 5,
  "4": 3,
  "5": 2,
  "6": 1,
  X: 0,
};

let pool = null;
let activeSubscription = null;
let currentTab = "social";
let seenEvents = new Set();
let profileCache = new Map();
let currentCompareState = null;
let socialSubMode = "global"; // "global" or "follows"

async function initPool() {
  const { SimplePool } = await import(
    "https://esm.sh/nostr-tools@2.10.0/pool?bundle"
  );
  pool = new SimplePool();
  return pool;
}

async function getNip19() {
  const { nip19 } = await import("https://esm.sh/nostr-tools@2.10.0?bundle");
  return nip19;
}

function shortenNpub(npub) {
  if (!npub || npub.length < 20) return npub;
  return `${npub.slice(0, 10)}..${npub.slice(-6)}`;
}

function formatRelativeTime(timestamp) {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} d`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

function parseProfile(event) {
  try {
    const data = JSON.parse(event.content);
    return {
      name: data.name || data.display_name,
      displayName: data.display_name || data.name,
      picture: data.picture,
      nip05: data.nip05,
      about: data.about,
    };
  } catch {
    return null;
  }
}

async function loadProfiles(pubkeys) {
  if (!pool) await initPool();

  const unique = Array.from(new Set(pubkeys.filter(Boolean)));
  const needed = unique.filter((pk) => !profileCache.has(pk));
  if (needed.length === 0) return;

  // Layer 1: load from IndexedDB cache
  const stillNeeded = [];
  if (window.Word5Cache?.getProfile) {
    for (const pk of needed) {
      try {
        const cached = await window.Word5Cache.getProfile(pk);
        if (cached?.profile) {
          profileCache.set(pk, cached.profile);
          updatePostsWithProfile(pk, cached.profile);
          continue;
        }
      } catch (_) {}
      stillNeeded.push(pk);
    }
  } else {
    stillNeeded.push(...needed);
  }

  if (stillNeeded.length === 0) return;

  // Layer 2: fetch from relays
  try {
    const events = await pool.querySync(RELAYS, {
      kinds: [0],
      authors: stillNeeded,
      limit: stillNeeded.length,
    });

    for (const event of events) {
      const profile = parseProfile(event);
      if (profile) {
        profileCache.set(event.pubkey, profile);
        updatePostsWithProfile(event.pubkey, profile);

        // Persist to IndexedDB
        if (window.Word5Cache?.putProfile) {
          window.Word5Cache.putProfile({
            pubkey: event.pubkey,
            profile,
            updatedAt: Math.floor(Date.now() / 1000),
          }).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.log("[Profiles] Error loading profiles:", e);
  }
}

async function updatePostsWithProfile(pubkey, profile) {
  const nip19 = await getNip19();
  const npub = nip19.npubEncode(pubkey);

  document.querySelectorAll(`[data-pubkey="${pubkey}"]`).forEach((card) => {
    const nameEl = card.querySelector(
      ".post-name, .lb-name, .follow-name, .compare-name"
    );
    const handleEl = card.querySelector(".post-handle, .compare-handle");
    const avatarEl = card.querySelector(
      ".post-avatar, .lb-avatar, .follow-avatar, .compare-avatar"
    );

    if (nameEl && profile.displayName) {
      nameEl.textContent = profile.displayName;
    }
    if (handleEl && handleEl.dataset.handle === "true") {
      handleEl.textContent = profile.nip05 || shortenNpub(npub);
    }
    if (avatarEl && profile.picture) {
      avatarEl.innerHTML = `<img src="${escapeHtml(
        profile.picture
      )}" alt="" onerror="this.parentElement.innerHTML='👤'">`;
    }
  });
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function linkifyContent(content) {
  const urlPattern = /(https?:\/\/[^\s<]+)/g;
  return escapeHtml(content).replace(
    urlPattern,
    '<a href="$1" target="_blank" rel="noopener">$1</a>'
  );
}

function getProfile(pubkey) {
  return profileCache.get(pubkey) || null;
}

async function getDisplayIdentity(pubkey) {
  const nip19 = await getNip19();
  const npub = nip19.npubEncode(pubkey);
  const profile = getProfile(pubkey);
  return {
    name: profile?.displayName || shortenNpub(npub),
    handle: profile?.nip05 || shortenNpub(npub),
    avatar: profile?.picture || "",
  };
}

function renderAvatarHtml(avatarUrl) {
  if (avatarUrl) {
    return `<img src="${escapeHtml(
      avatarUrl
    )}" alt="" onerror="this.parentElement.innerHTML='👤'">`;
  }
  return "<span>👤</span>";
}

async function renderPostCard(event) {
  const identity = await getDisplayIdentity(event.pubkey);
  const relativeTime = formatRelativeTime(event.created_at);

  const card = document.createElement("div");
  card.className = "post-card";
  card.dataset.eventId = event.id;
  card.dataset.pubkey = event.pubkey;

  const contentHtml = linkifyContent(event.content);

  card.innerHTML = `
    <div class="post-avatar">${renderAvatarHtml(identity.avatar)}</div>
    <div class="post-body">
      <div class="post-header">
        <span class="post-name">${escapeHtml(identity.name)}</span>
        <span class="post-handle">${escapeHtml(identity.handle)}</span>
        <span class="post-time">${relativeTime}</span>
      </div>
      <div class="post-content">${contentHtml}</div>
    </div>
  `;

  // Click card to show follow overlay
  card.addEventListener("click", (e) => {
    // Don't trigger on link clicks
    if (e.target.closest("a")) return;
    showFollowOverlay(card, event.pubkey);
  });

  return card;
}

function showEmptyState(message) {
  const postList = document.getElementById("postList");
  postList.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">📭</div>
      <div class="empty-state-text">${message}</div>
    </div>
  `;
}

function showLoading() {
  const postList = document.getElementById("postList");
  postList.innerHTML = '<div class="loading"></div>';
}

function clearPosts() {
  const postList = document.getElementById("postList");
  postList.innerHTML = "";
  seenEvents.clear();
}

async function addPost(event) {
  if (seenEvents.has(event.id)) return;
  seenEvents.add(event.id);

  const postList = document.getElementById("postList");

  const loading = postList.querySelector(".loading");
  if (loading) loading.remove();

  const emptyState = postList.querySelector(".empty-state");
  if (emptyState) emptyState.remove();

  const card = await renderPostCard(event);

  const existingCards = postList.querySelectorAll(".post-card");
  let inserted = false;

  for (const existing of existingCards) {
    const existingTime = parseInt(existing.dataset.createdAt || "0", 10);
    if (event.created_at > existingTime) {
      postList.insertBefore(card, existing);
      inserted = true;
      break;
    }
  }

  if (!inserted) {
    postList.appendChild(card);
  }

  card.dataset.createdAt = String(event.created_at);
  loadProfiles([event.pubkey]);
}

function closeSubscription() {
  if (activeSubscription) {
    try {
      activeSubscription.close();
    } catch (_) {}
    activeSubscription = null;
  }
}

function getCurrentViewerPubkey() {
  const player = window.NostrSession?.getPlayer();
  if (!player) return null;
  return player.linked_pubkey || player.pubkey || null;
}

function getWord5ResultScore(result) {
  return SCORE_BY_RESULT[result] ?? 0;
}

function parseWord5Event(event) {
  if (!event?.content || !Array.isArray(event.tags)) return null;

  const tagMap = {};
  for (const tag of event.tags) {
    if (tag[0] && !(tag[0] in tagMap)) {
      tagMap[tag[0]] = tag[1];
    }
  }

  let puzzle = parseInt(tagMap.puzzle || "", 10) || 0;
  if (!puzzle) {
    const match = event.content.match(/WORD5\s*#(\d+)/i);
    puzzle = match ? parseInt(match[1], 10) : 0;
  }

  let result = tagMap.result || "";
  if (!result) {
    const match = event.content.match(/WORD5\s*#\d+\s+([1-6X])\/6/i);
    result = match ? match[1].toUpperCase() : "";
  }
  result = result.toUpperCase();

  if (!puzzle || !Object.prototype.hasOwnProperty.call(SCORE_BY_RESULT, result)) {
    return null;
  }

  return {
    eventId: event.id,
    pubkey: event.pubkey,
    puzzle,
    result,
    points: getWord5ResultScore(result),
    createdAt: event.created_at,
    raw: event,
  };
}

function buildScoreMap(events, windowDays, allowedAuthors = null) {
  const cutoff = Math.floor(Date.now() / 1000) - windowDays * 24 * 60 * 60;
  const latestByPuzzle = new Map();

  for (const event of events || []) {
    if (event.created_at < cutoff) continue;
    if (allowedAuthors && !allowedAuthors.has(event.pubkey)) continue;

    const parsed = parseWord5Event(event);
    if (!parsed) continue;

    const key = `${parsed.pubkey}:${parsed.puzzle}`;
    const existing = latestByPuzzle.get(key);
    if (!existing || parsed.createdAt > existing.createdAt) {
      latestByPuzzle.set(key, parsed);
    }
  }

  const perUser = new Map();
  for (const entry of latestByPuzzle.values()) {
    const bucket = perUser.get(entry.pubkey) || [];
    bucket.push(entry);
    perUser.set(entry.pubkey, bucket);
  }

  for (const entries of perUser.values()) {
    entries.sort((a, b) => b.createdAt - a.createdAt);
  }

  return perUser;
}

function buildPlayerSummary(pubkey, entries) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  return {
    pubkey,
    score: safeEntries.reduce((sum, entry) => sum + entry.points, 0),
    entries: safeEntries,
    gamesPlayed: safeEntries.length,
    lastPlayedAt: safeEntries[0]?.createdAt || 0,
  };
}

async function getFollowPubkeys(userPubkey) {
  const contactEvents = await pool.querySync(RELAYS, {
    kinds: [3],
    authors: [userPubkey],
    limit: 1,
  });

  if (!contactEvents || contactEvents.length === 0) {
    return [];
  }

  return contactEvents[0].tags
    .filter((tag) => tag[0] === "p" && tag[1])
    .map((tag) => tag[1]);
}

function showToast(message) {
  if (window.NostrUI?.showToast) {
    window.NostrUI.showToast(message);
    return;
  }
  console.log("[Toast]", message);
}

// --- Safe Follow System ---

async function fetchFreshKind3(pubkey) {
  if (!pool) await initPool();
  const events = await pool.querySync(RELAYS, {
    kinds: [3],
    authors: [pubkey],
    limit: 5,
  });
  if (!events || events.length === 0) return null;
  // Return the latest one
  return events.sort((a, b) => b.created_at - a.created_at)[0];
}

function validateFollowDiff(originalEvent, newTags, newContent, targetPubkey) {
  // Rule 1: If there was an original, new tags should be exactly +1
  if (originalEvent) {
    if (newTags.length !== originalEvent.tags.length + 1) {
      return { valid: false, reason: `Tag count mismatch: original ${originalEvent.tags.length}, new ${newTags.length}, expected ${originalEvent.tags.length + 1}` };
    }

    // Rule 2: Every original tag must exist in new tags
    for (let i = 0; i < originalEvent.tags.length; i++) {
      const origTag = originalEvent.tags[i];
      const newTag = newTags[i];
      if (JSON.stringify(origTag) !== JSON.stringify(newTag)) {
        return { valid: false, reason: `Tag at index ${i} was modified: ${JSON.stringify(origTag)} → ${JSON.stringify(newTag)}` };
      }
    }

    // Rule 3: The only new tag is ["p", targetPubkey]
    const addedTag = newTags[newTags.length - 1];
    if (addedTag[0] !== "p" || addedTag[1] !== targetPubkey) {
      return { valid: false, reason: `Last tag is not the expected follow: ${JSON.stringify(addedTag)}` };
    }

    // Rule 4: Content preserved
    if (newContent !== (originalEvent.content || "")) {
      return { valid: false, reason: "Content was modified" };
    }
  } else {
    // No original — new event should have exactly 1 tag
    if (newTags.length !== 1) {
      return { valid: false, reason: `Expected 1 tag for new contact list, got ${newTags.length}` };
    }
    if (newTags[0][0] !== "p" || newTags[0][1] !== targetPubkey) {
      return { valid: false, reason: `Tag is not the expected follow: ${JSON.stringify(newTags[0])}` };
    }
  }

  return { valid: true, reason: "" };
}

async function safeAddFollow(targetPubkey) {
  const signer = await window.NostrSigners.getActiveSigner();
  const myPubkey = await signer.getPublicKey();

  if (myPubkey === targetPubkey) {
    throw new Error("Cannot follow yourself");
  }

  // Fresh fetch right before modification
  const originalEvent = await fetchFreshKind3(myPubkey);

  // Check if already following
  if (originalEvent) {
    const alreadyFollows = originalEvent.tags.some(
      (t) => t[0] === "p" && t[1] === targetPubkey
    );
    if (alreadyFollows) {
      throw new Error("already_following");
    }
  }

  // Clone all existing tags, append new follow
  const newTags = originalEvent ? originalEvent.tags.map((t) => [...t]) : [];
  newTags.push(["p", targetPubkey]);

  // Preserve content exactly
  const newContent = originalEvent?.content || "";

  // Validate diff before signing
  const validation = validateFollowDiff(originalEvent, newTags, newContent, targetPubkey);
  if (!validation.valid) {
    console.error("[Follow] Diff validation failed:", validation.reason);
    console.error("[Follow] Original tags:", originalEvent?.tags);
    console.error("[Follow] New tags:", newTags);
    throw new Error(`Safety check failed: ${validation.reason}`);
  }

  // Sign and publish
  const event = await signer.signEvent({
    kind: 3,
    created_at: Math.floor(Date.now() / 1000),
    tags: newTags,
    content: newContent,
  });

  await Promise.any(pool.publish(RELAYS, event));
  return { followCount: newTags.filter((t) => t[0] === "p").length };
}

async function showFollowOverlay(cardElement, targetPubkey) {
  // Remove any existing overlay
  cardElement.querySelector(".follow-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "follow-overlay";
  overlay.innerHTML = '<div class="follow-overlay-count">Loading...</div>';
  cardElement.appendChild(overlay);

  // Stop click from propagating through overlay
  overlay.addEventListener("click", (e) => e.stopPropagation());

  try {
    const myPubkey = getCurrentViewerPubkey();
    if (!myPubkey) {
      overlay.innerHTML = `
        <div class="follow-overlay-count">Log in first to follow people.</div>
        <div class="follow-overlay-actions">
          <button class="follow-overlay-btn follow-overlay-btn--cancel" data-action="cancel">Dismiss</button>
        </div>
      `;
      overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => overlay.remove());
      return;
    }

    if (myPubkey === targetPubkey) {
      overlay.innerHTML = `
        <div class="follow-overlay-count">This is you!</div>
        <div class="follow-overlay-actions">
          <button class="follow-overlay-btn follow-overlay-btn--cancel" data-action="cancel">Dismiss</button>
        </div>
      `;
      overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => overlay.remove());
      return;
    }

    // Fetch fresh Kind 3 to get current follow count
    const kind3 = await fetchFreshKind3(myPubkey);
    const currentFollows = kind3 ? kind3.tags.filter((t) => t[0] === "p") : [];
    const currentCount = currentFollows.length;
    const alreadyFollowing = currentFollows.some((t) => t[1] === targetPubkey);

    const identity = await getDisplayIdentity(targetPubkey);

    if (alreadyFollowing) {
      overlay.innerHTML = `
        <div class="follow-overlay-name">${escapeHtml(identity.name)}</div>
        <div class="follow-overlay-count">You already follow this person.</div>
        <div class="follow-overlay-actions">
          <button class="follow-overlay-btn follow-overlay-btn--cancel" data-action="cancel">Dismiss</button>
        </div>
      `;
      overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => overlay.remove());
      return;
    }

    overlay.innerHTML = `
      <div class="follow-overlay-name">${escapeHtml(identity.name)}</div>
      <div class="follow-overlay-count">This will update your follows to <strong>${currentCount + 1}</strong> people.</div>
      <div class="follow-overlay-actions">
        <button class="follow-overlay-btn follow-overlay-btn--cancel" data-action="cancel">Cancel</button>
        <button class="follow-overlay-btn follow-overlay-btn--follow" data-action="follow">Follow</button>
      </div>
    `;

    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => overlay.remove());
    overlay.querySelector('[data-action="follow"]').addEventListener("click", async (e) => {
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = "Following...";

      try {
        const result = await safeAddFollow(targetPubkey);
        showToast(`Followed ${identity.name} (${result.followCount} follows)`);
        overlay.remove();
      } catch (err) {
        if (err.message === "already_following") {
          showToast("Already following this person");
          overlay.remove();
        } else {
          showToast(`Follow failed: ${err.message}`);
          btn.disabled = false;
          btn.textContent = "Follow";
        }
      }
    });
  } catch (e) {
    console.error("[Follow] Error showing overlay:", e);
    overlay.innerHTML = `
      <div class="follow-overlay-count">Error: ${escapeHtml(e.message || String(e))}</div>
      <div class="follow-overlay-actions">
        <button class="follow-overlay-btn follow-overlay-btn--cancel" data-action="cancel">Dismiss</button>
      </div>
    `;
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => overlay.remove());
  }
}

function renderSocialSubSwitcher() {
  const postList = document.getElementById("postList");
  const switcher = document.createElement("div");
  switcher.className = "social-sub-switcher";
  switcher.innerHTML = `
    <button class="social-sub-btn${socialSubMode === "global" ? " active" : ""}" data-sub="global">Global</button>
    <button class="social-sub-btn${socialSubMode === "follows" ? " active" : ""}" data-sub="follows">My Follows</button>
  `;
  postList.prepend(switcher);
  switcher.querySelectorAll(".social-sub-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      socialSubMode = btn.dataset.sub;
      subscribeToSocial();
    });
  });
}

async function subscribeToSocial() {
  currentCompareState = null;
  if (!pool) await initPool();

  showLoading();
  clearPosts();

  const postList = document.getElementById("postList");
  postList.innerHTML = "";
  renderSocialSubSwitcher();

  try {
    let events;
    if (socialSubMode === "follows") {
      const userPubkey = getCurrentViewerPubkey();
      if (!userPubkey) {
        postList.innerHTML = "";
        renderSocialSubSwitcher();
        postList.insertAdjacentHTML("beforeend", '<div class="empty-state"><div class="empty-state-icon">📭</div><div class="empty-state-text">Log in to see posts from your follows.</div></div>');
        return;
      }
      const followPubkeys = await getFollowPubkeys(userPubkey);
      if (followPubkeys.length === 0) {
        postList.innerHTML = "";
        renderSocialSubSwitcher();
        postList.insertAdjacentHTML("beforeend", '<div class="empty-state"><div class="empty-state-icon">📭</div><div class="empty-state-text">No follows found. Follow people on Nostr to see their posts here.</div></div>');
        return;
      }
      events = await pool.querySync(RELAYS, {
        kinds: [1],
        "#t": ["word5"],
        authors: followPubkeys,
        limit: 50,
      });
    } else {
      events = await pool.querySync(RELAYS, {
        kinds: [1],
        "#t": ["word5"],
        limit: 50,
      });
    }

    if (!events || events.length === 0) {
      showEmptyState(socialSubMode === "follows"
        ? "No word5 posts from your follows yet."
        : "No word5 posts found yet. Be the first to share!");
      // Re-add switcher since showEmptyState replaces content
      const el = document.getElementById("postList");
      const empty = el.innerHTML;
      el.innerHTML = "";
      renderSocialSubSwitcher();
      el.insertAdjacentHTML("beforeend", empty);
      return;
    }

    events.sort((a, b) => b.created_at - a.created_at);
    for (const event of events) {
      await addPost(event);
    }
  } catch (e) {
    console.error("[Social] Error:", e);
    showEmptyState("Error loading posts. Please try again.");
  }
}

async function renderFollowEntry(summary, rank, viewerPubkey) {
  const identity = await getDisplayIdentity(summary.pubkey);
  const entry = document.createElement("button");
  entry.type = "button";
  entry.className = "leaderboard-entry leaderboard-entry--clickable";
  entry.dataset.pubkey = summary.pubkey;

  const lastPlayedText = summary.lastPlayedAt
    ? `Last played ${formatRelativeTime(summary.lastPlayedAt)}`
    : "No published games";
  const recentWindowText =
    summary.gamesPlayed > 0
      ? `${summary.score} pts in ${COMPARE_WINDOW_DAYS}d · ${summary.gamesPlayed} recent games`
      : `0 pts in ${COMPARE_WINDOW_DAYS}d · no recent games`;

  entry.innerHTML = `
    <div class="lb-rank">#${rank}</div>
    <div class="lb-avatar follow-avatar">${renderAvatarHtml(identity.avatar)}</div>
    <div class="lb-info">
      <div class="lb-name follow-name">${escapeHtml(identity.name)}</div>
      <div class="lb-stats">${escapeHtml(recentWindowText)}</div>
      <div class="lb-stats follow-meta">${escapeHtml(lastPlayedText)}</div>
    </div>
    <div class="lb-streak">
      <div class="lb-streak-value">vs</div>
      <div class="lb-streak-label">compare</div>
    </div>
  `;

  entry.addEventListener("click", () => {
    loadCompareView({
      leftPubkey: viewerPubkey,
      rightPubkey: summary.pubkey,
      updateHistory: true,
    });
  });

  return entry;
}

async function subscribeToFollows() {
  currentCompareState = null;
  if (!pool) await initPool();

  showLoading();
  clearPosts();

  const userPubkey = getCurrentViewerPubkey();
  if (!userPubkey) {
    showEmptyState("No identity found. Create or import a key to compare with follows.");
    return;
  }

  try {
    const followPubkeys = await getFollowPubkeys(userPubkey);
    if (followPubkeys.length === 0) {
      showEmptyState("No contacts found for this key. Follow some people to compare scores here.");
      return;
    }

    const events = await pool.querySync(RELAYS, {
      kinds: [1],
      "#t": ["word5"],
      authors: followPubkeys,
      limit: 300,
    });

    const recentScoreMap = buildScoreMap(
      events,
      COMPARE_WINDOW_DAYS,
      new Set(followPubkeys)
    );
    const allTimeScoreMap = buildScoreMap(events, 3650, new Set(followPubkeys));

    const summaries = Array.from(allTimeScoreMap.entries())
      .map(([pubkey, allEntries]) => {
        const recentEntries = recentScoreMap.get(pubkey) || [];
        const recentSummary = buildPlayerSummary(pubkey, recentEntries);
        return {
          ...recentSummary,
          lastPlayedAt: allEntries[0]?.createdAt || 0,
          allTimeGamesPlayed: allEntries.length,
        };
      })
      .sort((a, b) => {
        const aRecent = a.gamesPlayed > 0 ? 1 : 0;
        const bRecent = b.gamesPlayed > 0 ? 1 : 0;
        if (bRecent !== aRecent) return bRecent - aRecent;
        if (b.score !== a.score) return b.score - a.score;
        return b.lastPlayedAt - a.lastPlayedAt;
      });

    if (summaries.length === 0) {
      showEmptyState("No published WORD5 results from your follows yet.");
      return;
    }

    await loadProfiles([userPubkey, ...summaries.map((summary) => summary.pubkey)]);

    const postList = document.getElementById("postList");
    postList.innerHTML = `
      <div class="compare-intro">
        <div class="compare-intro-title">Pick an opponent</div>
        <div class="compare-intro-copy">Tap someone you follow to compare the last ${COMPARE_WINDOW_DAYS} days of published WORD5 results. The list includes anyone you follow who has ever posted WORD5.</div>
      </div>
    `;

    for (let index = 0; index < summaries.length; index += 1) {
      const entry = await renderFollowEntry(summaries[index], index + 1, userPubkey);
      postList.appendChild(entry);
    }
  } catch (e) {
    console.error("[Follows] Error:", e);
    showEmptyState("Error loading follows. Please try again.");
  }
}

function getWinner(left, right) {
  if (left.score === right.score) return null;
  return left.score > right.score ? left.pubkey : right.pubkey;
}

function isProbablyImageUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function formatDateLabel(timestamp) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function bytesToHex(bytes) {
  return Array.from(bytes || [])
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(blob) {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return bytesToHex(new Uint8Array(digest));
}

function encodeNostrAuthorizationHeader(event) {
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

async function createBlossomUploadAuth({
  signer,
  sha256,
  serverUrl,
  message = "Upload Blob",
}) {
  const now = Math.floor(Date.now() / 1000);
  return signer.signEvent({
    kind: 24242,
    created_at: now,
    tags: [
      ["t", "upload"],
      ["x", sha256],
      ["server", new URL("/", serverUrl).toString()],
      ["expiration", String(now + 60 * 60)],
    ],
    content: message,
  });
}

async function loadAvatarBitmap(url) {
  if (!isProbablyImageUrl(url)) return null;

  try {
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok) {
      throw new Error(`Avatar fetch failed (${response.status})`);
    }
    const blob = await response.blob();
    if ("createImageBitmap" in window) {
      return await createImageBitmap(blob);
    }
    const objectUrl = URL.createObjectURL(blob);
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Avatar decode failed"));
        img.src = objectUrl;
      });
      return image;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch (_) {
    return null;
  }
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawAvatar(ctx, bitmap, label, x, y, size) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  if (bitmap) {
    ctx.drawImage(bitmap, x, y, size, size);
  } else {
    ctx.fillStyle = "#2a2a2b";
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 42px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((label || "?").slice(0, 1).toUpperCase(), x + size / 2, y + size / 2);
  }

  ctx.restore();
}

function fitText(ctx, text, maxWidth, initialSize, weight = 700, minSize = 24) {
  let size = initialSize;
  while (size > minSize) {
    ctx.font = `${weight} ${size}px sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) {
      return size;
    }
    size -= 2;
  }
  return minSize;
}

function truncateText(ctx, text, maxWidth) {
  if (!text) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  let output = text;
  while (output.length > 1) {
    output = output.slice(0, -1);
    if (ctx.measureText(`${output}…`).width <= maxWidth) {
      return `${output}…`;
    }
  }
  return "…";
}

async function generateDuelImage(matchup, leftIdentity, rightIdentity) {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 675;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context unavailable");

  const winnerPubkey = getWinner(matchup.left, matchup.right);
  const [leftAvatar, rightAvatar] = await Promise.all([
    loadAvatarBitmap(leftIdentity.avatar),
    loadAvatarBitmap(rightIdentity.avatar),
  ]);

  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#0f1012");
  gradient.addColorStop(1, "#1b1b1f");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = "700 28px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("WORD5 DUEL", 72, 70);

  ctx.fillStyle = "rgba(255,255,255,0.24)";
  ctx.font = "600 24px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(`LAST ${COMPARE_WINDOW_DAYS} DAYS`, 1128, 68);

  const cardY = 84;
  const cardWidth = 410;
  const cardHeight = 468;
  const leftX = 72;
  const rightX = canvas.width - 72 - cardWidth;
  const accentColor = "#9333ea";

  for (const cardX of [leftX, rightX]) {
    ctx.save();
    drawRoundedRect(ctx, cardX, cardY, cardWidth, cardHeight, 28);
    ctx.fillStyle = "#18181b";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  }

  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.font = "500 54px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("VS", canvas.width / 2, cardY + 236);

  const avatarSize = 150;
  drawAvatar(ctx, leftAvatar, leftIdentity.name, leftX + (cardWidth - avatarSize) / 2, cardY + 56, avatarSize);
  drawAvatar(ctx, rightAvatar, rightIdentity.name, rightX + (cardWidth - avatarSize) / 2, cardY + 56, avatarSize);

  function drawCardText(cardX, identity, player, isWinner) {
    const centerX = cardX + cardWidth / 2;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    const maxTextWidth = cardWidth - 72;
    const nameSize = fitText(ctx, identity.name, maxTextWidth, 58, 700, 34);
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${nameSize}px sans-serif`;
    ctx.fillText(truncateText(ctx, identity.name, maxTextWidth), centerX, cardY + 314);

    ctx.font = "500 26px sans-serif";
    const handle = truncateText(ctx, identity.handle, maxTextWidth);
    ctx.fillStyle = "rgba(255,255,255,0.48)";
    ctx.fillText(handle, centerX, cardY + 360);

    if (isWinner) {
      ctx.fillStyle = "#fbbf24";
      ctx.font = "500 34px sans-serif";
      ctx.fillText("🏆", centerX, cardY + 404);
    }

    ctx.fillStyle = accentColor;
    ctx.font = "800 108px sans-serif";
    ctx.fillText(String(player.score), centerX, cardY + 490);

    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.font = "600 20px sans-serif";
    ctx.fillText("POINTS", centerX, cardY + 518);
  }

  drawCardText(leftX, leftIdentity, matchup.left, winnerPubkey === matchup.left.pubkey);
  drawCardText(rightX, rightIdentity, matchup.right, winnerPubkey === matchup.right.pubkey);

  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(72, 586);
  ctx.lineTo(1128, 586);
  ctx.stroke();

  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.font = "600 34px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(
    `${leftIdentity.name} vs ${rightIdentity.name}`,
    canvas.width / 2,
    630
  );

  ctx.fillStyle = "rgba(255,255,255,0.42)";
  ctx.font = "500 22px sans-serif";
  ctx.fillText(
    `${formatDateLabel(Date.now())} · otherstuff.ai/word5`,
    canvas.width / 2,
    660
  );

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error("Failed to render duel image"));
    }, "image/png");
  });

  return blob;
}

async function uploadBlobToBlossom({ blob, signer, serverUrl, sha256, contentType }) {
  const server = new URL("/", serverUrl);
  const uploadUrl = new URL("/upload", server).toString();
  const auth = await createBlossomUploadAuth({
    signer,
    sha256,
    serverUrl,
    message: "Upload WORD5 duel card",
  });
  const uploadHeaders = {
    Authorization: encodeNostrAuthorizationHeader(auth),
    "X-SHA-256": sha256,
  };
  if (contentType) {
    uploadHeaders["Content-Type"] = contentType;
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: uploadHeaders,
    body: blob,
  });

  if (!uploadResponse.ok) {
    const message = await uploadResponse.text();
    throw new Error(message || `Blossom upload failed (${uploadResponse.status})`);
  }

  const descriptor = await uploadResponse.json();
  if (!descriptor?.url) {
    throw new Error("Blossom upload succeeded without a blob URL");
  }

  return descriptor;
}

async function renderCompareSummary(player, winnerPubkey) {
  const identity = await getDisplayIdentity(player.pubkey);
  const isWinner = winnerPubkey === player.pubkey;

  return `
    <div class="compare-summary" data-pubkey="${player.pubkey}">
      <div class="compare-avatar">${renderAvatarHtml(identity.avatar)}</div>
      <div class="compare-name-row">
        <div class="compare-name">${escapeHtml(identity.name)}${
    isWinner ? ' <span class="compare-trophy">🏆</span>' : ""
  }</div>
        <div class="compare-handle" data-handle="true">${escapeHtml(identity.handle)}</div>
      </div>
      <div class="compare-score">${player.score}</div>
    </div>
  `;
}

function renderCompareEntries(player, identity) {
  if (player.entries.length === 0) {
    return `
      <div class="compare-section">
        <div class="compare-section-title">${escapeHtml(identity.name)}</div>
        <div class="compare-empty">No published WORD5 results in the last ${COMPARE_WINDOW_DAYS} days.</div>
      </div>
    `;
  }

  const rows = player.entries
    .map(
      (entry) => `
        <div class="compare-row">
          <div class="compare-row-main">
            <div class="compare-row-puzzle">#${entry.puzzle}</div>
            <div class="compare-row-result">${entry.result}/6</div>
          </div>
          <div class="compare-row-side">
            <div class="compare-row-points">${entry.points} pts</div>
            <div class="compare-row-time">${formatRelativeTime(entry.createdAt)}</div>
          </div>
        </div>
      `
    )
    .join("");

  return `
    <div class="compare-section">
      <div class="compare-section-title">${escapeHtml(identity.name)}</div>
      ${rows}
    </div>
  `;
}

function formatCompareCell(entry) {
  if (!entry) {
    return `
      <div class="compare-matchup-result compare-matchup-result--missed">Missed</div>
      <div class="compare-matchup-points">0 pts</div>
    `;
  }

  return `
    <div class="compare-matchup-result">${escapeHtml(entry.result)}/6</div>
    <div class="compare-matchup-points">${entry.points} pts</div>
  `;
}

function renderCompareTimeline(left, right, leftIdentity, rightIdentity) {
  const byPuzzle = new Map();

  for (const entry of left.entries) {
    const row = byPuzzle.get(entry.puzzle) || {};
    row.left = entry;
    byPuzzle.set(entry.puzzle, row);
  }

  for (const entry of right.entries) {
    const row = byPuzzle.get(entry.puzzle) || {};
    row.right = entry;
    byPuzzle.set(entry.puzzle, row);
  }

  const puzzles = Array.from(byPuzzle.keys()).sort((a, b) => b - a);
  if (puzzles.length === 0) {
    return `
      <div class="compare-section">
        <div class="compare-section-title">Recent matchup log</div>
        <div class="compare-empty">Neither player has published WORD5 results in the last ${COMPARE_WINDOW_DAYS} days.</div>
      </div>
    `;
  }

  const rows = puzzles
    .map((puzzle) => {
      const row = byPuzzle.get(puzzle) || {};
      const timestamp = Math.max(row.left?.createdAt || 0, row.right?.createdAt || 0);
      return `
        <div class="compare-matchup-row">
          <div class="compare-matchup-puzzle">
            <div class="compare-row-puzzle">#${puzzle}</div>
            <div class="compare-row-time">${formatRelativeTime(timestamp)}</div>
          </div>
          <div class="compare-matchup-cell">
            ${formatCompareCell(row.left)}
          </div>
          <div class="compare-matchup-cell">
            ${formatCompareCell(row.right)}
          </div>
        </div>
      `;
    })
    .join("");

  return `
    <div class="compare-section">
      <div class="compare-section-title">Recent matchup log</div>
      <div class="compare-matchup-header">
        <div class="compare-matchup-label">Puzzle</div>
        <div class="compare-matchup-label">${escapeHtml(leftIdentity.name)}</div>
        <div class="compare-matchup-label">${escapeHtml(rightIdentity.name)}</div>
      </div>
      ${rows}
    </div>
  `;
}

async function publishCompareShare(matchup, button) {
  if (!window.NostrSigners) {
    showToast("Nostr not ready");
    return;
  }

  const leftIdentity = await getDisplayIdentity(matchup.left.pubkey);
  const rightIdentity = await getDisplayIdentity(matchup.right.pubkey);

  if (button) {
    button.disabled = true;
    button.textContent = "Uploading...";
  }

  try {
    const signer = await window.NostrSigners.getActiveSigner();
    const nip19 = await getNip19();
    const imageBlob = await generateDuelImage(matchup, leftIdentity, rightIdentity);
    const imageSha = await sha256Hex(imageBlob);
    const descriptor = await uploadBlobToBlossom({
      blob: imageBlob,
      signer,
      serverUrl: BLOSSOM_UPLOAD_SERVER,
      sha256: imageSha,
      contentType: imageBlob.type || "image/png",
    });
    const leftNpub = nip19.npubEncode(matchup.left.pubkey);
    const rightNpub = nip19.npubEncode(matchup.right.pubkey);
    const content = [
      descriptor.url,
      "",
      `WORD5 Duel · ${leftIdentity.name} vs ${rightIdentity.name}`,
      `nostr:${leftNpub} vs nostr:${rightNpub}`,
      "Play WORD5 and challenge your friends:",
      "https://otherstuff.ai/word5/",
    ].join("\n");

    if (button) {
      button.textContent = "Posting...";
    }

    const unsigned = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["t", "word5duel"],
        ["t", "word5challenge"],
        ["game", "word5"],
        ["window", `${COMPARE_WINDOW_DAYS}d`],
        ["score_left", String(matchup.left.score)],
        ["score_right", String(matchup.right.score)],
        ["r", descriptor.url],
        [
          "imeta",
          `url ${descriptor.url}`,
          `x ${descriptor.sha256 || imageSha}`,
          `size ${descriptor.size || imageBlob.size}`,
          `m ${descriptor.type || imageBlob.type || "image/png"}`,
        ],
        ["p", matchup.left.pubkey],
        ["p", matchup.right.pubkey],
      ],
      content,
    };

    const signed = await signer.signEvent(unsigned);
    const publishPromises = pool.publish(RELAYS, signed);
    const results = await Promise.allSettled(publishPromises);
    const succeeded = results.some((result) => result.status === "fulfilled");

    if (!succeeded) {
      throw new Error("No relay confirmed the duel post");
    }

    showToast("Shared duel to Nostr");
  } catch (error) {
    console.error("[Compare] Share failed:", error);
    showToast(`Share failed: ${error?.message || error}`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Share";
    }
  }
}

async function loadCompareView({ leftPubkey, rightPubkey, updateHistory = true }) {
  currentCompareState = null;
  if (!pool) await initPool();

  showLoading();
  closeSubscription();
  currentTab = "follows";

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === "follows");
  });

  const postList = document.getElementById("postList");
  if (!leftPubkey || !rightPubkey) {
    showEmptyState("Missing players for this comparison.");
    return;
  }

  try {
    const events = await pool.querySync(RELAYS, {
      kinds: [1],
      "#t": ["word5"],
      authors: [leftPubkey, rightPubkey],
      limit: 240,
    });

    await loadProfiles([leftPubkey, rightPubkey]);

    const scoreMap = buildScoreMap(
      events,
      COMPARE_WINDOW_DAYS,
      new Set([leftPubkey, rightPubkey])
    );

    const left = buildPlayerSummary(leftPubkey, scoreMap.get(leftPubkey) || []);
    const right = buildPlayerSummary(rightPubkey, scoreMap.get(rightPubkey) || []);
    const winnerPubkey = getWinner(left, right);
    const leftIdentity = await getDisplayIdentity(leftPubkey);
    const rightIdentity = await getDisplayIdentity(rightPubkey);

    currentCompareState = { left, right };

    postList.innerHTML = `
      <div class="compare-view">
        <div class="compare-toolbar">
          <button type="button" class="compare-back-btn">Back to follows</button>
          <div class="compare-window-label">Last ${COMPARE_WINDOW_DAYS} days</div>
        </div>
        <div class="compare-scoreboard">
          ${await renderCompareSummary(left, winnerPubkey)}
          <div class="compare-versus">vs</div>
          ${await renderCompareSummary(right, winnerPubkey)}
        </div>
        <div class="compare-caption">${escapeHtml(
          leftIdentity.name
        )} vs ${escapeHtml(rightIdentity.name)}${
      winnerPubkey ? " · trophy for the leader" : " · tie game"
    }</div>
        <button type="button" class="nostr-btn compare-share-btn">Share</button>
        <div class="compare-share-note">Publish this head-to-head and invite people to play WORD5.</div>
        <div class="compare-section-list">
          ${renderCompareTimeline(left, right, leftIdentity, rightIdentity)}
        </div>
      </div>
    `;

    const backButton = postList.querySelector(".compare-back-btn");
    if (backButton) {
      backButton.addEventListener("click", () => {
        switchTab("follows");
      });
    }

    const shareButton = postList.querySelector(".compare-share-btn");
    if (shareButton) {
      shareButton.addEventListener("click", () =>
        publishCompareShare(currentCompareState, shareButton)
      );
    }

    if (updateHistory) {
      updateUrl(
        {
          tab: "follows",
          player: leftPubkey,
          opponent: rightPubkey,
        },
        false
      );
    }
  } catch (error) {
    console.error("[Compare] Error:", error);
    showEmptyState("Error loading comparison. Please try again.");
  }
}

function getTagValue(event, tagName) {
  const tag = event.tags.find((candidate) => candidate[0] === tagName);
  return tag ? parseInt(tag[1], 10) || 0 : 0;
}

async function renderLeaderboardEntry(event, rank) {
  const identity = await getDisplayIdentity(event.pubkey);

  const maxStreak = getTagValue(event, "maxStreak");
  const played = getTagValue(event, "played");
  const won = getTagValue(event, "won");
  const winPct = played > 0 ? Math.round((won / played) * 100) : 0;

  const entry = document.createElement("div");
  entry.className = "leaderboard-entry";
  entry.dataset.pubkey = event.pubkey;

  let rankDisplay = `#${rank}`;
  if (rank === 1) rankDisplay = "🥇";
  else if (rank === 2) rankDisplay = "🥈";
  else if (rank === 3) rankDisplay = "🥉";

  entry.style.position = "relative";
  entry.style.cursor = "pointer";
  entry.innerHTML = `
    <div class="lb-rank">${rankDisplay}</div>
    <div class="lb-avatar">${renderAvatarHtml(identity.avatar)}</div>
    <div class="lb-info">
      <div class="lb-name">${escapeHtml(identity.name)}</div>
      <div class="lb-stats">${played} played · ${winPct}% win</div>
    </div>
    <div class="lb-streak">
      <div class="lb-streak-value">${maxStreak}</div>
      <div class="lb-streak-label">best</div>
    </div>
  `;

  entry.addEventListener("click", () => {
    showFollowOverlay(entry, event.pubkey);
  });

  return entry;
}

async function subscribeToTop() {
  currentCompareState = null;
  if (!pool) await initPool();

  showLoading();
  clearPosts();

  try {
    const events = await pool.querySync(RELAYS, {
      kinds: [1],
      "#t": ["word5"],
      limit: 200,
    });

    const bestByUser = new Map();
    for (const event of events) {
      const maxStreak = getTagValue(event, "maxStreak");
      if (maxStreak <= 0) continue;

      const existing = bestByUser.get(event.pubkey);
      if (!existing || maxStreak > getTagValue(existing, "maxStreak")) {
        bestByUser.set(event.pubkey, event);
      }
    }

    await displayLeaderboard(Array.from(bestByUser.values()));
  } catch (e) {
    console.error("[Top] Error:", e);
    showEmptyState("Error loading leaderboard. Please try again.");
  }
}

async function displayLeaderboard(events) {
  const postList = document.getElementById("postList");
  const loading = postList.querySelector(".loading");
  if (loading) loading.remove();

  const withStreaks = events.filter((event) => getTagValue(event, "maxStreak") > 0);
  if (withStreaks.length === 0) {
    showEmptyState("No streak data found yet. Play and share your results to appear on the leaderboard!");
    return;
  }

  withStreaks.sort(
    (a, b) => getTagValue(b, "maxStreak") - getTagValue(a, "maxStreak")
  );
  const top = withStreaks.slice(0, 50);

  postList.innerHTML = "";
  await loadProfiles(top.map((event) => event.pubkey));

  for (let index = 0; index < top.length; index += 1) {
    const entry = await renderLeaderboardEntry(top[index], index + 1);
    postList.appendChild(entry);
  }
}

function getRouteFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get("tab");
  return {
    tab: ["social", "follows", "top", "league"].includes(tab) ? tab : "social",
    player: params.get("player") || "",
    opponent: params.get("opponent") || "",
  };
}

function updateUrl(route, replace = false) {
  const url = new URL(window.location.href);
  url.searchParams.set("tab", route.tab || "social");

  if (route.player && route.opponent) {
    url.searchParams.set("player", route.player);
    url.searchParams.set("opponent", route.opponent);
  } else {
    url.searchParams.delete("player");
    url.searchParams.delete("opponent");
  }

  if (replace) {
    history.replaceState(route, "", url);
  } else {
    history.pushState(route, "", url);
  }
}

function switchTab(tabName, updateHistory = true) {
  closeSubscription();
  currentCompareState = null;
  currentTab = tabName;

  if (updateHistory) {
    updateUrl({ tab: tabName }, false);
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  switch (tabName) {
    case "social":
      subscribeToSocial();
      break;
    case "follows":
      subscribeToFollows();
      break;
    case "top":
      subscribeToTop();
      break;
    case "league":
      if (window.LeagueManager?.renderLeagueList) {
        window.LeagueManager.renderLeagueList();
      } else {
        showEmptyState("League module not loaded.");
      }
      break;
  }
}

async function init() {
  if (window.NostrSession?.whenReady) {
    await window.NostrSession.whenReady;
  }

  await initPool();

  if (window.Word5Cache?.open) {
    await window.Word5Cache.open().catch((e) => console.log("[Cache] Init error:", e));
  }

  // Expose shared utilities for league.js and other modules
  window.SocialBoard = {
    parseWord5Event,
    SCORE_BY_RESULT,
    escapeHtml,
    renderAvatarHtml,
    getDisplayIdentity,
    loadProfiles,
    shortenNpub,
    formatRelativeTime,
    showLoading,
    clearPosts,
    showEmptyState,
    showToast,
    initPool,
    get pool() { return pool; },
    RELAYS,
  };

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  window.addEventListener("popstate", async (event) => {
    const route = event.state || getRouteFromUrl();
    if (route.tab === "follows" && route.player && route.opponent) {
      await loadCompareView({
        leftPubkey: route.player,
        rightPubkey: route.opponent,
        updateHistory: false,
      });
      return;
    }
    switchTab(route.tab || "social", false);
  });

  const initialRoute = getRouteFromUrl();
  updateUrl(initialRoute, true);

  if (initialRoute.tab === "follows" && initialRoute.player && initialRoute.opponent) {
    await loadCompareView({
      leftPubkey: initialRoute.player,
      rightPubkey: initialRoute.opponent,
      updateHistory: false,
    });
    return;
  }

  switchTab(initialRoute.tab, false);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
