// League management module for Word5
// Dependencies: Word5Cache, NostrSession, NostrSigners, nostr-tools SimplePool
(function () {
  const LEAGUE_KIND = 30078;
  const LEAGUE_TAG = "word5league";
  const MAX_MEMBERS = 10; // creator counts as 1

  function getPool() {
    return window.SocialBoard?.pool || null;
  }

  function getRelays() {
    return window.SocialBoard?.RELAYS || ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.snort.social"];
  }

  function sb() { return window.SocialBoard || {}; }

  // --- Week boundary helpers ---

  function getWeekBoundary(date) {
    const d = date ? new Date(date) : new Date();
    const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    // Monday = 1, Sunday = 0 → shift to Monday start
    const day = utc.getUTCDay();
    const diff = day === 0 ? 6 : day - 1;
    const monday = new Date(utc);
    monday.setUTCDate(utc.getUTCDate() - diff);
    monday.setUTCHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    sunday.setUTCHours(23, 59, 59, 999);
    return {
      start: Math.floor(monday.getTime() / 1000),
      end: Math.floor(sunday.getTime() / 1000),
      label: formatWeekLabel(monday, sunday),
    };
  }

  function formatWeekLabel(mon, sun) {
    const opts = { month: "short", day: "numeric" };
    const mStr = mon.toLocaleDateString(undefined, opts);
    const sStr = sun.toLocaleDateString(undefined, { ...opts, year: "numeric" });
    return `${mStr} – ${sStr}`;
  }

  function shiftWeek(weekStart, delta) {
    const d = new Date(weekStart * 1000);
    d.setUTCDate(d.getUTCDate() + delta * 7);
    return getWeekBoundary(d);
  }

  function getTodayDayIndex(week) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec < week.start || nowSec > week.end) return 0;
    return Math.min(6, Math.floor((nowSec - week.start) / 86400));
  }

  function getDayLabel(weekStart, dayIndex) {
    const d = new Date((weekStart + dayIndex * 86400) * 1000);
    return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  }

  // --- Nostr event helpers ---

  function generateSlug() {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let slug = "";
    for (let i = 0; i < 8; i++) slug += chars[Math.floor(Math.random() * chars.length)];
    return slug;
  }

  function parseLeagueEvent(event) {
    if (!event || event.kind !== LEAGUE_KIND) return null;
    const tags = event.tags || [];
    const tTag = tags.find((t) => t[0] === "t" && t[1] === LEAGUE_TAG);
    if (!tTag) return null;

    const dTag = (tags.find((t) => t[0] === "d") || [])[1] || "";
    const name = (tags.find((t) => t[0] === "name") || [])[1] || "Unnamed League";
    const description = (tags.find((t) => t[0] === "description") || [])[1] || "";
    const image = (tags.find((t) => t[0] === "image") || [])[1] || "";
    const members = tags.filter((t) => t[0] === "p").map((t) => t[1]);

    return {
      eventId: event.id,
      dTag,
      name,
      description,
      image,
      creator: event.pubkey,
      members,
      createdAt: event.created_at,
      raw: event,
    };
  }

  // --- Core functions ---

  async function createLeague({ name, description, image, memberPubkeys }) {
    const signer = await window.NostrSigners.getActiveSigner();
    const creatorPk = await signer.getPublicKey();
    const slug = generateSlug();

    // Dedupe members and ensure creator is included
    const memberSet = new Set(memberPubkeys || []);
    memberSet.add(creatorPk);
    if (memberSet.size > MAX_MEMBERS) {
      throw new Error(`League cannot have more than ${MAX_MEMBERS} members (including you)`);
    }

    const pTags = Array.from(memberSet).map((pk) => ["p", pk]);
    const tags = [
      ["d", slug],
      ["name", name],
      ["description", description || ""],
      ["image", image || ""],
      ["t", LEAGUE_TAG],
      ...pTags,
    ];

    const event = await signer.signEvent({
      kind: LEAGUE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: "",
    });

    const pool = getPool();
    if (pool) {
      await Promise.any(pool.publish(getRelays(), event));
    }

    const parsed = parseLeagueEvent(event);
    if (parsed) {
      await window.Word5Cache.putLeague(parsed);
    }
    return parsed;
  }

  async function updateLeague(dTag, patch) {
    const signer = await window.NostrSigners.getActiveSigner();
    const creatorPk = await signer.getPublicKey();

    // Fetch current league from cache
    const existing = await window.Word5Cache.getLeague(dTag, creatorPk);
    if (!existing) throw new Error("League not found");
    if (existing.creator !== creatorPk) throw new Error("Only the creator can modify a league");

    const name = patch.name ?? existing.name;
    const description = patch.description ?? existing.description;
    const image = patch.image ?? existing.image;
    let members = patch.memberPubkeys ? new Set(patch.memberPubkeys) : new Set(existing.members);
    members.add(creatorPk);
    if (members.size > MAX_MEMBERS) {
      throw new Error(`League cannot have more than ${MAX_MEMBERS} members`);
    }

    const pTags = Array.from(members).map((pk) => ["p", pk]);
    const tags = [
      ["d", dTag],
      ["name", name],
      ["description", description],
      ["image", image],
      ["t", LEAGUE_TAG],
      ...pTags,
    ];

    const event = await signer.signEvent({
      kind: LEAGUE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: "",
    });

    const pool = getPool();
    if (pool) {
      await Promise.any(pool.publish(getRelays(), event));
    }

    const parsed = parseLeagueEvent(event);
    if (parsed) {
      await window.Word5Cache.putLeague(parsed);
    }
    return parsed;
  }

  // --- Leave / Rejoin ---

  const LEAVE_TAG = "word5league-leave";
  const REJOIN_TAG = "word5league-rejoin";

  function leagueLeaveDTag(leagueDTag, creatorPubkey) {
    return `leave-${leagueDTag}-${creatorPubkey}`;
  }

  async function leaveLeague(leagueDTag, creatorPubkey) {
    const signer = await window.NostrSigners.getActiveSigner();
    const myPubkey = await signer.getPublicKey();

    if (myPubkey === creatorPubkey) {
      throw new Error("The creator cannot leave their own league");
    }

    const dTag = leagueLeaveDTag(leagueDTag, creatorPubkey);

    const event = await signer.signEvent({
      kind: LEAGUE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", dTag],
        ["t", LEAVE_TAG],
        ["p", creatorPubkey],
        ["league", leagueDTag, creatorPubkey],
      ],
      content: "",
    });

    const pool = getPool();
    if (pool) {
      await Promise.any(pool.publish(getRelays(), event));
    }

    // Local hide — immediate UI update
    await window.Word5Cache.setMeta(
      `league-left-${leagueDTag}-${creatorPubkey}`,
      Math.floor(Date.now() / 1000)
    );

    return event;
  }

  async function rejoinLeague(leagueDTag, creatorPubkey) {
    const signer = await window.NostrSigners.getActiveSigner();

    const dTag = leagueLeaveDTag(leagueDTag, creatorPubkey);

    // Publish rejoin event (replaces the leave event — same d tag)
    const event = await signer.signEvent({
      kind: LEAGUE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", dTag],
        ["t", REJOIN_TAG],
        ["p", creatorPubkey],
        ["league", leagueDTag, creatorPubkey],
      ],
      content: "",
    });

    const pool = getPool();
    if (pool) {
      await Promise.any(pool.publish(getRelays(), event));
    }

    // Remove local hide
    await window.Word5Cache.setMeta(`league-left-${leagueDTag}-${creatorPubkey}`, null);

    return event;
  }

  async function isLeagueHidden(leagueDTag, creatorPubkey) {
    const meta = await window.Word5Cache.getMeta(`league-left-${leagueDTag}-${creatorPubkey}`);
    return meta?.value != null;
  }

  async function processLeaveRequests(pubkey) {
    const pool = getPool();
    if (!pool) return;

    // Find leave requests addressed to me (as league creator)
    const leaveEvents = await pool.querySync(getRelays(), {
      kinds: [LEAGUE_KIND],
      "#t": [LEAVE_TAG],
      "#p": [pubkey],
    });

    if (!leaveEvents || leaveEvents.length === 0) return;

    // Dedupe: latest event per d-tag (replaceable)
    const latestByDTag = new Map();
    for (const ev of leaveEvents) {
      const dTag = (ev.tags.find((t) => t[0] === "d") || [])[1];
      if (!dTag) continue;
      const existing = latestByDTag.get(dTag);
      if (!existing || ev.created_at > existing.created_at) {
        latestByDTag.set(dTag, ev);
      }
    }

    // Also fetch rejoin events to see if any leave was cancelled
    const rejoinEvents = await pool.querySync(getRelays(), {
      kinds: [LEAGUE_KIND],
      "#t": [REJOIN_TAG],
      "#p": [pubkey],
    });

    const rejoinByDTag = new Map();
    for (const ev of rejoinEvents) {
      const dTag = (ev.tags.find((t) => t[0] === "d") || [])[1];
      if (!dTag) continue;
      const existing = rejoinByDTag.get(dTag);
      if (!existing || ev.created_at > existing.created_at) {
        rejoinByDTag.set(dTag, ev);
      }
    }

    for (const [dTag, leaveEv] of latestByDTag) {
      // Check if a rejoin was published after the leave
      const rejoinEv = rejoinByDTag.get(dTag);
      if (rejoinEv && rejoinEv.created_at > leaveEv.created_at) {
        continue; // Leave was cancelled by rejoin
      }

      const leagueTag = leaveEv.tags.find((t) => t[0] === "league");
      if (!leagueTag) continue;

      const leagueDTag = leagueTag[1];
      const leavingPubkey = leaveEv.pubkey;

      // Load the league from cache
      const league = await window.Word5Cache.getLeague(leagueDTag, pubkey);
      if (!league) continue;

      // Ignore leave events older than the current league event —
      // if the league was updated after the leave, the creator already handled it
      if (leaveEv.created_at < league.createdAt) continue;

      // Check if this member is still in the league
      if (!league.members.includes(leavingPubkey)) continue;

      // Remove the member and republish
      const newMembers = league.members.filter((pk) => pk !== leavingPubkey);
      try {
        await updateLeague(leagueDTag, { memberPubkeys: newMembers });
        console.log(`[League] Processed leave request: removed ${leavingPubkey.slice(0, 8)} from ${league.name}`);
      } catch (e) {
        console.log("[League] Failed to process leave request:", e);
      }
    }
  }

  async function syncMyLeagues() {
    const pool = getPool();
    if (!pool) return [];

    const player = window.NostrSession?.getPlayer();
    const pubkey = player?.linked_pubkey || player?.pubkey;
    if (!pubkey) return [];

    const metaKey = `league-sync-since-${pubkey}`;
    const meta = await window.Word5Cache.getMeta(metaKey);
    const since = meta?.value || 0;

    // Query leagues where user is tagged or is author
    const [byTag, byAuthor] = await Promise.all([
      pool.querySync(getRelays(), {
        kinds: [LEAGUE_KIND],
        "#p": [pubkey],
        "#t": [LEAGUE_TAG],
        since: since || undefined,
      }),
      pool.querySync(getRelays(), {
        kinds: [LEAGUE_KIND],
        authors: [pubkey],
        "#t": [LEAGUE_TAG],
        since: since || undefined,
      }),
    ]);

    const seen = new Set();
    const leagues = [];
    for (const ev of [...byTag, ...byAuthor]) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      const parsed = parseLeagueEvent(ev);
      if (parsed) {
        await window.Word5Cache.putLeague(parsed);
        leagues.push(parsed);

        // Auto-unhide: if we're tagged in a league that was updated after we left, remove the local hide
        if (parsed.members.includes(pubkey) || parsed.creator === pubkey) {
          const hideKey = `league-left-${parsed.dTag}-${parsed.creator}`;
          const hideMeta = await window.Word5Cache.getMeta(hideKey);
          if (hideMeta?.value != null && parsed.createdAt > hideMeta.value) {
            await window.Word5Cache.setMeta(hideKey, null);
            console.log(`[League] Auto-unhid "${parsed.name}" — re-added after leave`);
          }
        }
      }
    }

    await window.Word5Cache.setMeta(metaKey, Math.floor(Date.now() / 1000));

    // Process any leave requests for leagues I created
    try {
      await processLeaveRequests(pubkey);
    } catch (e) {
      console.log("[League] Error processing leave requests:", e);
    }

    return leagues;
  }

  async function loadWeekScores(league, weekStart, weekEnd) {
    const pool = getPool();
    if (!pool) return [];

    const allMembers = [league.creator, ...league.members];
    const memberSet = new Set(allMembers);

    // Cache first
    let cached = await window.Word5Cache.getScoresForWindow(
      Array.from(memberSet), weekStart, weekEnd
    );

    // Also fetch from relays
    try {
      const events = await pool.querySync(getRelays(), {
        kinds: [1],
        "#t": ["word5"],
        authors: Array.from(memberSet),
        since: weekStart,
        until: weekEnd + 1,
        limit: 500,
      });

      const parseWord5Event = sb().parseWord5Event;
      if (parseWord5Event && events?.length) {
        const scores = [];
        for (const ev of events) {
          const parsed = parseWord5Event(ev);
          if (parsed) {
            scores.push(parsed);
          }
        }
        if (scores.length) {
          await window.Word5Cache.putScores(scores);
        }
        // Re-read from cache for deduped results
        cached = await window.Word5Cache.getScoresForWindow(
          Array.from(memberSet), weekStart, weekEnd
        );
      }
    } catch (e) {
      console.log("[League] Relay score fetch error:", e);
    }

    return cached;
  }

  function buildWeeklyScoreboard(league, scores) {
    const memberSet = new Set([league.creator, ...league.members]);
    const parseWord5Event = sb().parseWord5Event;
    const SCORE_BY_RESULT = sb().SCORE_BY_RESULT || { "1": 10, "2": 7, "3": 5, "4": 3, "5": 2, "6": 1, X: 0 };

    // Dedupe: latest event per pubkey+puzzle
    const latestByKey = new Map();
    for (const s of scores) {
      if (!memberSet.has(s.pubkey)) continue;
      const key = `${s.pubkey}:${s.puzzle}`;
      const existing = latestByKey.get(key);
      if (!existing || s.createdAt > existing.createdAt) {
        latestByKey.set(key, s);
      }
    }

    // Group by member
    const perMember = new Map();
    for (const pk of memberSet) {
      perMember.set(pk, { pubkey: pk, entries: [], totalPoints: 0 });
    }
    for (const entry of latestByKey.values()) {
      const m = perMember.get(entry.pubkey);
      if (m) {
        m.entries.push(entry);
        m.totalPoints += entry.points;
      }
    }

    // Sort by total points desc
    const board = Array.from(perMember.values()).sort((a, b) => b.totalPoints - a.totalPoints);
    return board;
  }

  async function loadFollowList(pubkey) {
    const pool = getPool();
    if (!pool) return [];
    const events = await pool.querySync(getRelays(), {
      kinds: [3],
      authors: [pubkey],
      limit: 1,
    });
    if (!events || events.length === 0) return [];
    return events[0].tags
      .filter((t) => t[0] === "p" && t[1])
      .map((t) => t[1]);
  }

  // Cache of mutual follows for the current user, populated by loadMutualContacts
  let mutualFollowSet = new Set();

  async function loadMutualContacts(pubkey) {
    const iFollow = await loadFollowList(pubkey);
    if (!iFollow.length) { mutualFollowSet = new Set(); return []; }

    const pool = getPool();
    if (!pool) { mutualFollowSet = new Set(); return []; }

    // Fetch kind 3 for everyone I follow, check who follows me back
    const theirContactEvents = await pool.querySync(getRelays(), {
      kinds: [3],
      authors: iFollow,
      limit: iFollow.length,
    });

    // Keep latest kind 3 per author
    const latestByAuthor = new Map();
    for (const ev of theirContactEvents) {
      const existing = latestByAuthor.get(ev.pubkey);
      if (!existing || ev.created_at > existing.created_at) {
        latestByAuthor.set(ev.pubkey, ev);
      }
    }

    const mutuals = [];
    for (const pk of iFollow) {
      const ev = latestByAuthor.get(pk);
      if (!ev) continue;
      const followsMe = ev.tags.some((t) => t[0] === "p" && t[1] === pubkey);
      if (followsMe) mutuals.push(pk);
    }

    mutualFollowSet = new Set(mutuals);
    return mutuals;
  }

  async function isMutualFollow(userPubkey, targetPubkey) {
    if (mutualFollowSet.has(targetPubkey)) return true;

    // Check both directions individually for manual npub adds
    const pool = getPool();
    if (!pool) return false;

    const [myContacts, theirContacts] = await Promise.all([
      pool.querySync(getRelays(), { kinds: [3], authors: [userPubkey], limit: 1 }),
      pool.querySync(getRelays(), { kinds: [3], authors: [targetPubkey], limit: 1 }),
    ]);

    const iFollowThem = (myContacts?.[0]?.tags || []).some(
      (t) => t[0] === "p" && t[1] === targetPubkey
    );
    const theyFollowMe = (theirContacts?.[0]?.tags || []).some(
      (t) => t[0] === "p" && t[1] === userPubkey
    );

    return iFollowThem && theyFollowMe;
  }

  // --- UI Rendering ---

  let currentLeagueView = null; // { dTag, author, week }

  async function renderLeagueList() {
    const showLoading = sb().showLoading;
    const clearPosts = sb().clearPosts;
    const showEmptyState = sb().showEmptyState;
    const escapeHtml = sb().escapeHtml;
    const postList = document.getElementById("postList");

    if (showLoading) showLoading();

    try {
      const player = window.NostrSession?.getPlayer();
      const pubkey = player?.linked_pubkey || player?.pubkey;
      if (!pubkey) {
        if (showEmptyState) showEmptyState("Log in to see your leagues.");
        return;
      }

      // Sync from relays then read cache
      await syncMyLeagues();
      const allLeagues = await window.Word5Cache.getLeaguesForUser(pubkey);

      // Filter out locally hidden (left) leagues
      const leagues = [];
      for (const l of allLeagues || []) {
        const hidden = await isLeagueHidden(l.dTag, l.creator);
        if (!hidden) leagues.push(l);
      }

      if (!leagues || leagues.length === 0) {
        postList.innerHTML = "";
        postList.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">🏆</div>
            <div class="empty-state-text">No leagues yet</div>
          </div>
          <div style="display:flex;justify-content:center;padding:16px;">
            <button class="league-create-btn" id="leagueCreateBtn">+ Create League</button>
          </div>
        `;
        document.getElementById("leagueCreateBtn")?.addEventListener("click", openCreateLeague);
        return;
      }

      postList.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #2a2a2b;">
          <div style="font-weight:700;font-size:16px;color:#fff;">Your Leagues</div>
          <button class="league-create-btn" id="leagueCreateBtn">+ New</button>
        </div>
      `;
      document.getElementById("leagueCreateBtn")?.addEventListener("click", openCreateLeague);

      for (const league of leagues) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "league-card";
        const memberCount = new Set([league.creator, ...league.members]).size;
        card.innerHTML = `
          <div class="league-header">
            ${league.image ? `<img class="league-img" src="${escapeHtml(league.image)}" alt="" onerror="this.style.display='none'">` : ""}
            <div class="league-header-text">
              <div class="league-name">${escapeHtml(league.name)}</div>
              <div class="league-meta">${memberCount} member${memberCount !== 1 ? "s" : ""}</div>
            </div>
          </div>
        `;
        card.addEventListener("click", () => {
          renderLeagueDetail(league.dTag, league.creator);
        });
        postList.appendChild(card);
      }
    } catch (e) {
      console.error("[League] Error loading leagues:", e);
      if (showEmptyState) showEmptyState("Error loading leagues.");
    }
  }

  async function renderLeagueDetail(dTag, author) {
    const postList = document.getElementById("postList");
    const escapeHtml = sb().escapeHtml || ((s) => s);
    const showLoading = sb().showLoading;
    const renderAvatarHtml = sb().renderAvatarHtml || (() => "<span>👤</span>");
    const getDisplayIdentity = sb().getDisplayIdentity;
    const loadProfiles = sb().loadProfiles;

    if (showLoading) showLoading();

    const league = await window.Word5Cache.getLeague(dTag, author);
    if (!league) {
      postList.innerHTML = '<div class="empty-state"><div class="empty-state-text">League not found.</div></div>';
      return;
    }

    const week = currentLeagueView?.dTag === dTag ? currentLeagueView.week : getWeekBoundary();
    const viewMode = currentLeagueView?.dTag === dTag && currentLeagueView.viewMode ? currentLeagueView.viewMode : "week";
    const dayIndex = currentLeagueView?.dTag === dTag && currentLeagueView.dayIndex != null ? currentLeagueView.dayIndex : getTodayDayIndex(week);
    currentLeagueView = { dTag, author, week, viewMode, dayIndex };

    const allMembers = Array.from(new Set([league.creator, ...league.members]));
    if (loadProfiles) await loadProfiles(allMembers);

    const scores = await loadWeekScores(league, week.start, week.end);
    const board = buildWeeklyScoreboard(league, scores);

    postList.innerHTML = "";

    // Header row: Back | image + title | view toggle
    const isWeekView = viewMode === "week";
    const toggleLabel = isWeekView ? "Week" : "Daily";
    const toggleColor = isWeekView ? "#9333ea" : "#f97316";
    const leagueImgHtml = league.image
      ? `<img src="${escapeHtml(league.image)}" alt="" style="width:40px;height:40px;border-radius:8px;object-fit:cover;flex-shrink:0;" onerror="this.style.display='none'">`
      : "";

    const header = document.createElement("div");
    header.className = "league-detail-header";
    header.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #2a2a2b;">
        <button class="compare-back-btn" id="leagueBackBtn">Back</button>
        ${leagueImgHtml}
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:16px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(league.name)}</div>
          <div style="font-size:12px;color:#818384;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(league.description || "")}</div>
        </div>
        <button id="leagueViewToggle" style="background:${toggleColor};color:#fff;border:none;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;">${toggleLabel}</button>
      </div>
    `;
    postList.appendChild(header);
    document.getElementById("leagueBackBtn")?.addEventListener("click", renderLeagueList);
    document.getElementById("leagueViewToggle")?.addEventListener("click", () => {
      currentLeagueView.viewMode = isWeekView ? "daily" : "week";
      currentLeagueView.dayIndex = getTodayDayIndex(week);
      renderLeagueDetail(dTag, author);
    });

    // Navigation row — week arrows for week view, day arrows for daily view
    const nav = document.createElement("div");
    nav.className = "week-nav";

    if (isWeekView) {
      nav.innerHTML = `
        <button class="compare-back-btn" id="navPrev">&lt;</button>
        <span style="font-size:13px;color:#fff;font-weight:600;">${week.label}</span>
        <button class="compare-back-btn" id="navNext">&gt;</button>
      `;
      postList.appendChild(nav);
      document.getElementById("navPrev")?.addEventListener("click", () => {
        currentLeagueView.week = shiftWeek(week.start, -1);
        renderLeagueDetail(dTag, author);
      });
      document.getElementById("navNext")?.addEventListener("click", () => {
        currentLeagueView.week = shiftWeek(week.start, 1);
        renderLeagueDetail(dTag, author);
      });
    } else {
      const dayLabel = getDayLabel(week.start, dayIndex);
      nav.innerHTML = `
        <button class="compare-back-btn" id="navPrev">&lt;</button>
        <span style="font-size:13px;color:#fff;font-weight:600;">${dayLabel}</span>
        <button class="compare-back-btn" id="navNext">&gt;</button>
      `;
      postList.appendChild(nav);
      document.getElementById("navPrev")?.addEventListener("click", () => {
        if (dayIndex > 0) {
          currentLeagueView.dayIndex = dayIndex - 1;
        } else {
          // Go to previous week, Sunday
          currentLeagueView.week = shiftWeek(week.start, -1);
          currentLeagueView.dayIndex = 6;
        }
        renderLeagueDetail(dTag, author);
      });
      document.getElementById("navNext")?.addEventListener("click", () => {
        if (dayIndex < 6) {
          currentLeagueView.dayIndex = dayIndex + 1;
        } else {
          // Go to next week, Monday
          currentLeagueView.week = shiftWeek(week.start, 1);
          currentLeagueView.dayIndex = 0;
        }
        renderLeagueDetail(dTag, author);
      });
    }

    // 7-day winners strip — shown in both views
    const memberSet = new Set([league.creator, ...league.members]);
    const dayData = buildDayData(scores, memberSet, week.start);
    await renderWinnersStrip(postList, dayData, isWeekView ? -1 : dayIndex, dTag, author);

    if (viewMode === "daily") {
      await renderDailyView(postList, league, dayData, dayIndex, dTag, author);
    } else {
      await renderWeeklyBoard(postList, board, week, dTag, author);
    }

    // Bottom action: Edit for creator, Leave for members
    const player = window.NostrSession?.getPlayer();
    const myPubkey = player?.linked_pubkey || player?.pubkey;
    if (myPubkey && myPubkey === author) {
      const editRow = document.createElement("div");
      editRow.style.cssText = "display:flex;justify-content:center;padding:24px 16px 16px;";
      editRow.innerHTML = `<button id="leagueEditBtn" style="background:#9333ea;border:none;color:#fff;border-radius:999px;padding:8px 24px;font-size:13px;font-weight:600;cursor:pointer;">Edit League</button>`;
      postList.appendChild(editRow);

      document.getElementById("leagueEditBtn")?.addEventListener("click", () => {
        openEditLeague(dTag, author);
      });
    } else if (myPubkey && myPubkey !== author) {
      const leaveRow = document.createElement("div");
      leaveRow.style.cssText = "display:flex;justify-content:center;padding:24px 16px 16px;";
      leaveRow.innerHTML = `<button id="leagueLeaveBtn" style="background:transparent;border:1px solid #3a3a3c;color:#818384;border-radius:999px;padding:6px 18px;font-size:12px;cursor:pointer;">Leave League</button>`;
      postList.appendChild(leaveRow);

      document.getElementById("leagueLeaveBtn")?.addEventListener("click", async () => {
        const btn = document.getElementById("leagueLeaveBtn");
        if (!btn) return;

        if (btn.dataset.confirmed !== "true") {
          btn.textContent = "Tap again to confirm";
          btn.style.borderColor = "#f97316";
          btn.style.color = "#f97316";
          btn.dataset.confirmed = "true";
          setTimeout(() => {
            if (btn.dataset.confirmed === "true") {
              btn.textContent = "Leave League";
              btn.style.borderColor = "#3a3a3c";
              btn.style.color = "#818384";
              btn.dataset.confirmed = "";
            }
          }, 3000);
          return;
        }

        btn.disabled = true;
        btn.textContent = "Leaving...";
        try {
          await leaveLeague(dTag, author);
          window.NostrUI?.showToast?.("Left league");
          renderLeagueList();
        } catch (e) {
          window.NostrUI?.showToast?.(`Error: ${e.message || e}`);
          btn.disabled = false;
          btn.textContent = "Leave League";
          btn.dataset.confirmed = "";
        }
      });
    }
  }

  async function renderWeeklyBoard(postList, board, week, dTag, author) {
    const escapeHtml = sb().escapeHtml || ((s) => s);
    const renderAvatarHtml = sb().renderAvatarHtml || (() => "<span>👤</span>");
    const getDisplayIdentity = sb().getDisplayIdentity;

    const scoreboard = document.createElement("div");
    scoreboard.className = "league-scoreboard";

    for (let i = 0; i < board.length; i++) {
      const m = board[i];
      const identity = getDisplayIdentity ? await getDisplayIdentity(m.pubkey) : { name: m.pubkey.slice(0, 8), avatar: "" };

      const row = document.createElement("button");
      row.type = "button";
      row.className = "leaderboard-entry leaderboard-entry--clickable league-daily-row";
      row.dataset.pubkey = m.pubkey;
      row.innerHTML = `
        <div class="lb-rank">#${i + 1}</div>
        <div class="lb-avatar">${renderAvatarHtml(identity.avatar)}</div>
        <div class="lb-info">
          <div class="lb-name">${escapeHtml(identity.name)}</div>
          <div class="lb-stats">${m.entries.length} game${m.entries.length !== 1 ? "s" : ""} played</div>
        </div>
        <div class="lb-streak">
          <div class="lb-streak-value">${m.totalPoints}</div>
          <div class="lb-streak-label">pts</div>
        </div>
      `;
      row.addEventListener("click", () => {
        renderMemberDetail(m.pubkey, week.start, week.end, dTag, author);
      });
      scoreboard.appendChild(row);
    }
    postList.appendChild(scoreboard);
  }

  function buildDayData(scores, memberSet, weekStart) {
    // Dedupe scores: latest per pubkey+puzzle
    const latestByKey = new Map();
    for (const s of scores) {
      if (!memberSet.has(s.pubkey)) continue;
      const key = `${s.pubkey}:${s.puzzle}`;
      const existing = latestByKey.get(key);
      if (!existing || s.createdAt > existing.createdAt) {
        latestByKey.set(key, s);
      }
    }

    const days = [];
    for (let i = 0; i < 7; i++) {
      const start = weekStart + i * 86400;
      const end = start + 86400 - 1;

      const dayScores = new Map();
      for (const s of latestByKey.values()) {
        if (s.createdAt >= start && s.createdAt <= end) {
          const existing = dayScores.get(s.pubkey);
          if (!existing || s.createdAt > existing.createdAt) {
            dayScores.set(s.pubkey, s);
          }
        }
      }

      const ranked = Array.from(memberSet).map((pk) => {
        const entry = dayScores.get(pk);
        return { pubkey: pk, entry, points: entry?.points || 0 };
      }).sort((a, b) => b.points - a.points);

      // Find winner(s) — could be a tie
      const topScore = ranked[0]?.points || 0;
      const winners = topScore > 0 ? ranked.filter((r) => r.points === topScore).map((r) => r.pubkey) : [];

      days.push({ start, end, ranked, winners });
    }
    return days;
  }

  // Avatar helper with inline img sizing — works outside .lb-avatar CSS context
  function inlineAvatarImg(avatarUrl) {
    const escapeHtml = sb().escapeHtml || ((s) => s);
    if (avatarUrl) {
      return `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.innerHTML='👤'">`;
    }
    return "<span>👤</span>";
  }

  async function renderWinnersStrip(postList, days, selectedIndex, dTag, author) {
    const getDisplayIdentity = sb().getDisplayIdentity;
    const nowSec = Math.floor(Date.now() / 1000);
    const dayLabels = ["M", "T", "W", "T", "F", "S", "S"];

    const strip = document.createElement("div");
    strip.style.cssText = "display:flex;justify-content:space-around;align-items:center;padding:12px 8px;border-bottom:1px solid #2a2a2b;";

    for (let i = 0; i < 7; i++) {
      const day = days[i];
      const isSelected = i === selectedIndex;
      const isToday = day.start <= nowSec && nowSec <= day.end;

      let avatarHtml;
      if (day.winners.length === 0) {
        avatarHtml = `<div style="width:36px;height:36px;border-radius:50%;background:#2a2a2b;display:flex;align-items:center;justify-content:center;color:#818384;font-size:11px;">—</div>`;
      } else if (day.winners.length === 1) {
        const identity = getDisplayIdentity ? await getDisplayIdentity(day.winners[0]) : { avatar: "" };
        avatarHtml = `<div style="width:36px;height:36px;border-radius:50%;background:#2a2a2b;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:16px;">${inlineAvatarImg(identity.avatar)}</div>`;
      } else {
        const id1 = getDisplayIdentity ? await getDisplayIdentity(day.winners[0]) : { avatar: "" };
        const id2 = getDisplayIdentity ? await getDisplayIdentity(day.winners[1]) : { avatar: "" };
        avatarHtml = `
          <div style="position:relative;width:36px;height:36px;">
            <div style="position:absolute;top:0;left:0;width:24px;height:24px;border-radius:50%;background:#2a2a2b;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:11px;border:2px solid #121213;z-index:2;">${inlineAvatarImg(id1.avatar)}</div>
            <div style="position:absolute;bottom:0;right:0;width:24px;height:24px;border-radius:50%;background:#2a2a2b;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:11px;border:2px solid #121213;z-index:1;">${inlineAvatarImg(id2.avatar)}</div>
          </div>
        `;
      }

      const borderColor = isSelected ? "#f97316" : "transparent";
      const labelColor = isToday ? "#f97316" : "#818384";

      const cell = document.createElement("button");
      cell.type = "button";
      cell.style.cssText = "background:transparent;border:none;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;padding:2px;";
      cell.innerHTML = `
        <div style="border:2px solid ${borderColor};border-radius:50%;padding:1px;">${avatarHtml}</div>
        <div style="font-size:10px;font-weight:700;color:${labelColor};">${dayLabels[i]}</div>
      `;
      cell.addEventListener("click", () => {
        currentLeagueView.viewMode = "daily";
        currentLeagueView.dayIndex = i;
        renderLeagueDetail(dTag, author);
      });
      strip.appendChild(cell);
    }
    postList.appendChild(strip);
  }

  async function renderDailyView(postList, league, dayData, dayIndex, dTag, author) {
    const escapeHtml = sb().escapeHtml || ((s) => s);
    const renderAvatarHtml = sb().renderAvatarHtml || (() => "<span>👤</span>");
    const getDisplayIdentity = sb().getDisplayIdentity;

    const today = dayData[dayIndex];
    if (!today) return;

    for (const m of today.ranked) {
      const identity = getDisplayIdentity ? await getDisplayIdentity(m.pubkey) : { name: m.pubkey.slice(0, 8), avatar: "" };
      const resultText = m.entry ? `${m.entry.result}/6` : "—";
      const pointsText = m.entry ? `${m.points}` : "0";
      const resultColor = m.entry ? "#f97316" : "#818384";
      const isWinner = today.winners.includes(m.pubkey);

      const row = document.createElement("div");
      row.className = "leaderboard-entry";
      row.dataset.pubkey = m.pubkey;
      row.innerHTML = `
        <div class="lb-avatar" style="width:36px;height:36px;font-size:16px;${isWinner ? "border:2px solid #f97316;border-radius:50%;" : ""}">${renderAvatarHtml(identity.avatar)}</div>
        <div class="lb-info">
          <div class="lb-name" style="font-size:14px;">${escapeHtml(identity.name)}</div>
        </div>
        <div style="font-size:14px;font-weight:700;color:${resultColor};min-width:36px;text-align:center;">${resultText}</div>
        <div style="font-size:16px;font-weight:700;color:#9333ea;min-width:32px;text-align:right;">${pointsText}</div>
      `;
      postList.appendChild(row);
    }
  }

  async function renderMemberDetail(pubkey, weekStart, weekEnd, dTag, author) {
    const postList = document.getElementById("postList");
    const escapeHtml = sb().escapeHtml || ((s) => s);
    const getDisplayIdentity = sb().getDisplayIdentity;
    const renderAvatarHtml = sb().renderAvatarHtml || (() => "<span>👤</span>");
    const loadProfiles = sb().loadProfiles;

    if (loadProfiles) await loadProfiles([pubkey]);
    const identity = getDisplayIdentity ? await getDisplayIdentity(pubkey) : { name: pubkey.slice(0, 8), avatar: "" };

    const scores = await window.Word5Cache.getScoresForWindow([pubkey], weekStart, weekEnd);

    // Dedupe by puzzle
    const byPuzzle = new Map();
    for (const s of scores) {
      if (s.pubkey !== pubkey) continue;
      const existing = byPuzzle.get(s.puzzle);
      if (!existing || s.createdAt > existing.createdAt) {
        byPuzzle.set(s.puzzle, s);
      }
    }
    const entries = Array.from(byPuzzle.values()).sort((a, b) => b.createdAt - a.createdAt);
    const totalPts = entries.reduce((sum, e) => sum + e.points, 0);

    postList.innerHTML = "";

    // Header
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid #2a2a2b;";
    header.innerHTML = `
      <button class="compare-back-btn" id="memberBackBtn">Back</button>
      <div class="lb-avatar" style="width:48px;height:48px;font-size:20px;">${renderAvatarHtml(identity.avatar)}</div>
      <div>
        <div style="font-weight:700;font-size:16px;color:#fff;">${escapeHtml(identity.name)}</div>
        <div style="font-size:13px;color:#818384;">${totalPts} pts · ${entries.length} game${entries.length !== 1 ? "s" : ""}</div>
      </div>
    `;
    postList.appendChild(header);
    document.getElementById("memberBackBtn")?.addEventListener("click", () => {
      renderLeagueDetail(dTag, author);
    });

    if (entries.length === 0) {
      postList.innerHTML += '<div class="empty-state"><div class="empty-state-text">No games played this week.</div></div>';
      return;
    }

    // Daily results
    const section = document.createElement("div");
    section.className = "compare-section";
    section.style.margin = "12px 16px";
    let html = '<div class="compare-section-title">Daily Results</div>';
    for (const e of entries) {
      const date = new Date(e.createdAt * 1000).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      html += `
        <div class="compare-row">
          <div class="compare-row-main">
            <span class="compare-row-puzzle">#${e.puzzle}</span>
            <span class="compare-row-result">${e.result}/6</span>
          </div>
          <div class="compare-row-side">
            <span class="compare-row-points">${e.points} pts</span>
            <span class="compare-row-time">${date}</span>
          </div>
        </div>
      `;
    }
    section.innerHTML = html;
    postList.appendChild(section);
  }

  // Store rendered picker rows for search filtering
  let pickerRows = []; // [{ pubkey, name, element }]

  function renderPickerRow(pk, identity) {
    const renderAvatarHtml = sb().renderAvatarHtml || (() => "<span>👤</span>");
    const escapeHtml = sb().escapeHtml || ((s) => s);
    const label = document.createElement("label");
    label.className = "member-picker-row";
    label.dataset.pubkey = pk;
    label.dataset.searchName = (identity.name || "").toLowerCase();
    label.innerHTML = `
      <input type="checkbox" value="${pk}" class="league-member-checkbox">
      <div class="lb-avatar" style="width:32px;height:32px;font-size:14px;flex-shrink:0;">${renderAvatarHtml(identity.avatar)}</div>
      <span style="font-size:13px;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(identity.name)}</span>
    `;
    return label;
  }

  function filterPickerRows(query) {
    const q = (query || "").toLowerCase().trim();
    for (const row of pickerRows) {
      const match = !q || row.name.includes(q) || row.pubkey.includes(q);
      row.element.style.display = match ? "" : "none";
    }
  }

  async function addNpubToList() {
    const input = document.getElementById("leagueNpubInput");
    const contactsContainer = document.getElementById("leagueContactPicker");
    if (!input || !contactsContainer) return;

    const raw = input.value.trim();
    if (!raw) return;

    try {
      const { nip19 } = await import("https://esm.sh/nostr-tools@2.10.0?bundle");
      let pubkey;
      if (raw.startsWith("npub1")) {
        const decoded = nip19.decode(raw);
        if (decoded.type !== "npub") throw new Error("Not a valid npub");
        pubkey = decoded.data;
      } else if (/^[0-9a-f]{64}$/i.test(raw)) {
        pubkey = raw.toLowerCase();
      } else {
        throw new Error("Enter an npub or hex pubkey");
      }

      // Check if already in the list
      const existingRow = pickerRows.find((r) => r.pubkey === pubkey);
      if (existingRow) {
        const checkbox = contactsContainer.querySelector(`input[value="${pubkey}"]`);
        if (checkbox) checkbox.checked = true;
        // Clear search filter and scroll into view
        const searchInput = document.getElementById("leagueMemberSearch");
        if (searchInput) { searchInput.value = ""; filterPickerRows(""); }
        existingRow.element.scrollIntoView({ block: "center", behavior: "smooth" });
        existingRow.element.style.outline = "2px solid #9333ea";
        setTimeout(() => { existingRow.element.style.outline = ""; }, 2000);
        input.value = "";
        window.NostrUI?.showToast?.("Selected — highlighted in list");
        return;
      }

      // Verify mutual follow
      const player = window.NostrSession?.getPlayer();
      const userPk = player?.linked_pubkey || player?.pubkey;
      if (!userPk) throw new Error("Not logged in");

      window.NostrUI?.showToast?.("Checking mutual follow...");
      const mutual = await isMutualFollow(userPk, pubkey);
      if (!mutual) {
        throw new Error("Must be a mutual follow — you both need to follow each other");
      }

      // Load profile if possible
      if (sb().loadProfiles) await sb().loadProfiles([pubkey]);
      const getDisplayIdentity = sb().getDisplayIdentity;
      const identity = getDisplayIdentity ? await getDisplayIdentity(pubkey) : { name: pubkey.slice(0, 12), avatar: "" };

      const el = renderPickerRow(pubkey, identity);
      el.querySelector("input").checked = true;
      contactsContainer.prepend(el);
      pickerRows.unshift({ pubkey, name: (identity.name || "").toLowerCase(), element: el });

      input.value = "";
      window.NostrUI?.showToast?.("Added to list");
    } catch (e) {
      window.NostrUI?.showToast?.(`Invalid: ${e.message || e}`);
    }
  }

  // Track edit mode: null = create, { dTag, author } = editing
  let editingLeague = null;

  async function openCreateLeague() {
    editingLeague = null;
    await openLeagueForm(null);
  }

  async function openEditLeague(dTag, author) {
    const league = await window.Word5Cache.getLeague(dTag, author);
    if (!league) {
      window.NostrUI?.showToast?.("League not found");
      return;
    }
    editingLeague = { dTag, author };
    await openLeagueForm(league);
  }

  async function openLeagueForm(existingLeague) {
    const modal = document.getElementById("leagueCreateModal");
    if (!modal) return;

    const player = window.NostrSession?.getPlayer();
    const pubkey = player?.linked_pubkey || player?.pubkey;
    if (!pubkey) {
      window.NostrUI?.showToast?.("Log in first.");
      return;
    }

    const isEdit = existingLeague != null;
    const titleEl = document.getElementById("leagueModalTitle");
    const submitBtn = document.getElementById("leagueSubmitBtn");
    if (titleEl) titleEl.textContent = isEdit ? "Edit League" : "Create League";
    if (submitBtn) submitBtn.textContent = isEdit ? "Save Changes" : "Create League";

    // Load contacts for picker
    const contactsContainer = document.getElementById("leagueContactPicker");
    const statusEl = document.getElementById("leagueCreateStatus");
    const searchInput = document.getElementById("leagueMemberSearch");
    const npubInput = document.getElementById("leagueNpubInput");
    if (contactsContainer) contactsContainer.innerHTML = '<div style="color:#818384;padding:8px;">Loading contacts...</div>';
    if (statusEl) statusEl.textContent = "";
    if (searchInput) searchInput.value = "";
    if (npubInput) npubInput.value = "";
    pickerRows = [];

    modal.style.display = "flex";

    // Populate form
    const nameInput = document.getElementById("leagueNameInput");
    const descInput = document.getElementById("leagueDescInput");
    const imageInput = document.getElementById("leagueImageInput");
    if (nameInput) nameInput.value = isEdit ? existingLeague.name : "";
    if (descInput) descInput.value = isEdit ? (existingLeague.description || "") : "";
    if (imageInput) imageInput.value = "";

    // Show current image in edit mode
    if (isEdit && existingLeague.image) {
      statusEl.innerHTML = `<div style="margin-bottom:4px;">Current image:</div><img src="${sb().escapeHtml ? sb().escapeHtml(existingLeague.image) : existingLeague.image}" style="width:48px;height:48px;border-radius:8px;object-fit:cover;" onerror="this.style.display='none'">`;
    }

    // Existing members to pre-check (for edit mode)
    const existingMembers = isEdit ? new Set(existingLeague.members) : new Set();
    // Track pubkeys already added to avoid duplicates
    const addedPubkeys = new Set();

    try {
      const contacts = await loadMutualContacts(pubkey);

      const getDisplayIdentity = sb().getDisplayIdentity;
      contactsContainer.innerHTML = "";

      // 1. Always add the creator (self) first, pre-checked and disabled
      const selfIdentity = getDisplayIdentity ? await getDisplayIdentity(pubkey) : { name: "You", avatar: "" };
      const selfEl = renderPickerRow(pubkey, selfIdentity);
      const selfCheckbox = selfEl.querySelector("input");
      if (selfCheckbox) {
        selfCheckbox.checked = true;
        selfCheckbox.disabled = true;
      }
      contactsContainer.appendChild(selfEl);
      pickerRows.push({ pubkey, name: (selfIdentity.name || "").toLowerCase(), element: selfEl });
      addedPubkeys.add(pubkey);

      // 2. In edit mode, add ALL existing members first (checked)
      if (isEdit) {
        const allMembers = Array.from(existingMembers).filter((pk) => pk !== pubkey);
        if (sb().loadProfiles) await sb().loadProfiles(allMembers);
        for (const pk of allMembers) {
          const identity = getDisplayIdentity ? await getDisplayIdentity(pk) : { name: pk.slice(0, 12), avatar: "" };
          const el = renderPickerRow(pk, identity);
          el.querySelector("input").checked = true;
          contactsContainer.appendChild(el);
          pickerRows.push({ pubkey: pk, name: (identity.name || "").toLowerCase(), element: el });
          addedPubkeys.add(pk);
        }
      }

      // 3. Add mutual contacts not already shown
      if (sb().loadProfiles) {
        const toLoad = contacts.filter((pk) => !addedPubkeys.has(pk)).slice(0, 50);
        if (toLoad.length) await sb().loadProfiles(toLoad);
      }

      for (const pk of contacts) {
        if (addedPubkeys.has(pk)) continue;
        const identity = getDisplayIdentity ? await getDisplayIdentity(pk) : { name: pk.slice(0, 12), avatar: "" };
        const el = renderPickerRow(pk, identity);
        contactsContainer.appendChild(el);
        pickerRows.push({ pubkey: pk, name: (identity.name || "").toLowerCase(), element: el });
        addedPubkeys.add(pk);
      }

      if (pickerRows.length <= 1 && !isEdit) {
        contactsContainer.insertAdjacentHTML("beforeend", '<div style="color:#818384;padding:8px;">No mutual follows found. You can only add people who follow you back.</div>');
      }
    } catch (e) {
      console.error("[League] Error loading contacts:", e);
      if (contactsContainer) contactsContainer.innerHTML = '<div style="color:#818384;padding:8px;">Error loading contacts.</div>';
    }
  }

  async function handleCreateLeague() {
    const nameInput = document.getElementById("leagueNameInput");
    const descInput = document.getElementById("leagueDescInput");
    const statusEl = document.getElementById("leagueCreateStatus");
    const name = nameInput?.value?.trim();
    if (!name) {
      if (statusEl) statusEl.textContent = "Name is required.";
      return;
    }

    const checked = document.querySelectorAll(".league-member-checkbox:checked");
    const memberPubkeys = Array.from(checked).map((cb) => cb.value);

    const isEdit = editingLeague != null;
    if (statusEl) statusEl.textContent = isEdit ? "Saving changes..." : "Creating league...";

    try {
      // Handle image upload if present
      let image = "";
      const imageInput = document.getElementById("leagueImageInput");
      if (imageInput?.files?.[0]) {
        const file = imageInput.files[0];
        const signer = await window.NostrSigners.getActiveSigner();
        const hash = await window.NostrUI.sha256Hex(file);
        const descriptor = await window.NostrUI.uploadBlobToBlossom({
          blob: file,
          signer,
          serverUrl: "https://blossom.primal.net",
          sha256: hash,
        });
        image = descriptor.url;
      }

      if (isEdit) {
        const patch = {
          name,
          description: descInput?.value?.trim() || "",
          memberPubkeys,
        };
        // Only update image if a new one was uploaded
        if (image) patch.image = image;
        await updateLeague(editingLeague.dTag, patch);
        const modal = document.getElementById("leagueCreateModal");
        if (modal) modal.style.display = "none";
        window.NostrUI?.showToast?.("League updated!");
        renderLeagueDetail(editingLeague.dTag, editingLeague.author);
      } else {
        await createLeague({
          name,
          description: descInput?.value?.trim() || "",
          image,
          memberPubkeys,
        });
        const modal = document.getElementById("leagueCreateModal");
        if (modal) modal.style.display = "none";
        window.NostrUI?.showToast?.("League created!");
        renderLeagueList();
      }

      editingLeague = null;
    } catch (e) {
      console.error("[League] " + (isEdit ? "Update" : "Create") + " error:", e);
      if (statusEl) statusEl.textContent = `Error: ${e.message || e}`;
    }
  }

  function closeCreateModal() {
    const modal = document.getElementById("leagueCreateModal");
    if (modal) modal.style.display = "none";
  }

  // --- Init ---

  function init() {
    document.getElementById("leagueSubmitBtn")?.addEventListener("click", handleCreateLeague);
    document.getElementById("leagueCreateClose")?.addEventListener("click", closeCreateModal);
    document.getElementById("leagueCreateModal")?.addEventListener("click", (e) => {
      if (e.target.id === "leagueCreateModal") closeCreateModal();
    });
    // Type-ahead filter for contact picker
    document.getElementById("leagueMemberSearch")?.addEventListener("input", (e) => {
      filterPickerRows(e.target.value);
    });
    // Add member by npub
    document.getElementById("leagueNpubAddBtn")?.addEventListener("click", addNpubToList);
    document.getElementById("leagueNpubInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addNpubToList(); }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.LeagueManager = {
    renderLeagueList,
    renderLeagueDetail,
    renderMemberDetail,
    openCreateLeague,
    getWeekBoundary,
    syncMyLeagues,
    loadWeekScores,
    buildWeeklyScoreboard,
    loadMutualContacts,
    createLeague,
    updateLeague,
    leaveLeague,
    rejoinLeague,
    isLeagueHidden,
    openEditLeague,
  };
})();
