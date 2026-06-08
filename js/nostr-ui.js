// UI helpers: avatar dropdown, keys modal, import/export, toast.
(function () {
  const state = {
    revealed: false,
    profilePictureFile: null,
    profilePictureUrl: "",
    profilePreviewUrl: "",
    profilePubkey: "",
  };
  const profileCache = new Map();
  const BLOSSOM_UPLOAD_SERVER = "https://blossom.primal.net";
  const WORD5_STORAGE_KEY = "words-game";
  const WORD5_ROTATION_HOURS = 24;
  const WORD5_STREAK_EXPIRY_HOURS = 48;
  const WORD5_REPAIR_LIMIT = 2000;
  const WORD5_REPAIR_SINCE = Math.floor(Date.UTC(2025, 11, 1, 0, 0, 0) / 1000);
  const WORD5_REPAIR_SINCE_LABEL = "Dec 1, 2025";

  const $ = (id) => document.getElementById(id);

  function shortNpub(npub) {
    if (!npub) return "Session";
    return npub.length > 14 ? `${npub.slice(0, 8)}…${npub.slice(-4)}` : npub;
  }

  function getActiveNpub() {
    return window.NostrSigners?.getDisplayNpub?.() || window.NostrSession?.getPlayer()?.npub || null;
  }

  function showToast(msg) {
    let bar = $("toastBar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "toastBar";
      bar.style.position = "fixed";
      bar.style.bottom = "16px";
      bar.style.left = "50%";
      bar.style.transform = "translateX(-50%)";
      bar.style.padding = "10px 14px";
      bar.style.background = "rgba(12, 15, 26, 0.9)";
      bar.style.color = "#f5d100";
      bar.style.fontSize = "12px";
      bar.style.border = "1px solid #f5d100";
      bar.style.borderRadius = "6px";
      bar.style.zIndex = "1500";
      bar.style.transition = "opacity 0.2s ease";
      document.body.appendChild(bar);
    }
    bar.textContent = msg;
    bar.style.opacity = "1";
    clearTimeout(bar._hide);
    bar._hide = setTimeout(() => {
      bar.style.opacity = "0";
    }, 1800);
  }

  async function renderQr(text) {
    const qrContainer = $("keysQrContainer");
    if (!qrContainer) return;
    qrContainer.innerHTML = "";
    const { default: QRCode } = await import(
      "https://esm.sh/qrcode@1.5.3?bundle"
    );
    await QRCode.toCanvas(qrContainer, text, { margin: 1, width: 200 });
  }

  function getRelayList() {
    return window.NostrPost?.DEFAULT_RELAYS || [
      "wss://relay.damus.io",
      "wss://nos.lol",
      "wss://relay.snort.social",
    ];
  }

  function getIdentityPubkey(player) {
    return player?.linked_pubkey || player?.pubkey || null;
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

  async function uploadBlobToBlossom({ blob, signer, serverUrl, sha256 }) {
    const uploadUrl = new URL("/upload", new URL("/", serverUrl)).toString();
    const auth = await createBlossomUploadAuth({
      signer,
      sha256,
      serverUrl,
      message: "Upload WORD5 profile image",
    });
    const headers = {
      Authorization: encodeNostrAuthorizationHeader(auth),
      "X-SHA-256": sha256,
    };
    if (blob.type) {
      headers["Content-Type"] = blob.type;
    }

    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers,
      body: blob,
    });

    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || `Upload failed (${response.status})`);
    }

    const descriptor = await response.json();
    if (!descriptor?.url) {
      throw new Error("Upload succeeded without a blob URL");
    }
    return descriptor;
  }

  function normalizeWord5Result(value) {
    const normalized = String(value || "").trim().toUpperCase();
    return /^[1-6X]$/.test(normalized) ? normalized : "";
  }

  function getWord5PeriodId(createdAt) {
    const secondsPerPeriod = WORD5_ROTATION_HOURS * 60 * 60;
    return Math.floor(Number(createdAt || 0) / secondsPerPeriod);
  }

  function parseWord5PayloadContent(content) {
    if (typeof content !== "string" || !content) return {};
    try {
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== "object") return {};
      if (parsed.game !== "word5") return {};
      return {
        puzzle: Number.parseInt(parsed.puzzle, 10),
        result: normalizeWord5Result(parsed.result),
      };
    } catch (_) {
      return {};
    }
  }

  function hasWord5MetadataTag(tags) {
    return tags.some((tag) =>
      Array.isArray(tag) &&
      tag.length >= 2 &&
      (
        (tag[0] === "t" && String(tag[1] || "").toLowerCase() === "word5") ||
        (tag[0] === "game" && tag[1] === "word5")
      )
    );
  }

  function parseWord5Event(event) {
    if (!event || !Array.isArray(event.tags)) return null;
    if (!hasWord5MetadataTag(event.tags)) return null;

    const tags = Object.fromEntries(
      event.tags
        .filter((tag) => Array.isArray(tag) && tag.length >= 2)
        .map((tag) => [tag[0], tag[1]])
    );
    const payloadData = parseWord5PayloadContent(event.content);
    const puzzle = Number.parseInt(tags.puzzle, 10) || payloadData.puzzle || 0;
    const result = normalizeWord5Result(tags.result) || payloadData.result;

    if (!result || !Number.isFinite(event.created_at)) return null;

    return {
      id: event.id || "",
      kind: Number(event.kind || 0),
      created_at: Number(event.created_at),
      periodId: getWord5PeriodId(event.created_at),
      puzzle,
      result,
      won: result !== "X",
      streak: Number.parseInt(tags.streak, 10) || 0,
      maxStreak: Number.parseInt(tags.maxStreak, 10) || 0,
      played: Number.parseInt(tags.played, 10) || 0,
      taggedWon: Number.parseInt(tags.won, 10) || 0,
    };
  }

  function parseWord5StatsCorrection(event) {
    if (!event || !Array.isArray(event.tags)) return null;
    const tags = Object.fromEntries(
      event.tags
        .filter((tag) => Array.isArray(tag) && tag.length >= 2)
        .map((tag) => [tag[0], tag[1]])
    );
    if (tags.schema !== "word5.stats.v1" && tags.type !== "stats-correction") {
      return null;
    }
    return {
      created_at: Number(event.created_at) || 0,
      stats: {
        played: Number.parseInt(tags.played, 10) || 0,
        won: Number.parseInt(tags.won, 10) || 0,
        streak: Number.parseInt(tags.streak, 10) || 0,
        maxStreak: Number.parseInt(tags.maxStreak, 10) || 0,
      },
    };
  }

  function getWord5EventPreference(entry) {
    if (!entry) return -1;
    let score = 0;
    if (entry.kind === 1) score += 4;
    if (entry.kind === 5555) score += 2;
    if (entry.result && entry.result !== "X") score += 1;
    return score;
  }

  function dedupeWord5Entries(entries) {
    const byPeriod = new Map();
    for (const entry of entries) {
      if (!entry) continue;
      const key = entry.puzzle || `period:${entry.periodId}`;
      const existing = byPeriod.get(key);
      if (!existing) {
        byPeriod.set(key, entry);
        continue;
      }
      const existingScore = getWord5EventPreference(existing);
      const nextScore = getWord5EventPreference(entry);
      if (
        nextScore > existingScore ||
        (nextScore === existingScore && entry.created_at > existing.created_at)
      ) {
        byPeriod.set(key, entry);
      }
    }
    return Array.from(byPeriod.values()).sort((a, b) => {
      const puzzleDiff = (a.puzzle || 0) - (b.puzzle || 0);
      if (puzzleDiff !== 0) return puzzleDiff;
      return a.created_at - b.created_at;
    });
  }

  function isNextWord5Puzzle(prevPuzzle, nextPuzzle) {
    if (!prevPuzzle || !nextPuzzle) return true;
    return ((nextPuzzle - prevPuzzle + 1000) % 1000) === 1;
  }

  function buildWord5Stats(entries) {
    if (!entries.length) return null;

    let totalWon = 0;
    let maxStreak = 0;
    let activeRun = 0;
    let previousPuzzle = 0;

    for (const entry of entries) {
      const continuesStreak = isNextWord5Puzzle(previousPuzzle, entry.puzzle);
      if (entry.won) {
        totalWon += 1;
        activeRun = continuesStreak ? activeRun + 1 : 1;
        maxStreak = Math.max(maxStreak, activeRun);
      } else {
        activeRun = 0;
      }
      previousPuzzle = entry.puzzle || previousPuzzle;
    }
    const trailingWinRun = activeRun;

    const lastEntry = entries[entries.length - 1];
    const hoursSinceLastPost = lastEntry
      ? (Date.now() / 1000 - lastEntry.created_at) / 3600
      : Number.POSITIVE_INFINITY;
    const streakExpired = hoursSinceLastPost > WORD5_STREAK_EXPIRY_HOURS;

    return {
      stats: {
        played: entries.length,
        won: totalWon,
        streak: streakExpired ? 0 : trailingWinRun,
        maxStreak,
      },
      meta: {
        uniqueGames: entries.length,
        trailingWinRun,
        hoursSinceLastPost,
        streakExpired,
        firstPlayedAt: entries[0]?.created_at || 0,
        lastPlayedAt: lastEntry?.created_at || 0,
      },
    };
  }

  function applyCorrectionBaseline(correction, entries) {
    const correctedAt = Number(correction?.created_at) || 0;
    const stats = {
      played: Number(correction?.stats?.played) || 0,
      won: Number(correction?.stats?.won) || 0,
      streak: Number(correction?.stats?.streak) || 0,
      maxStreak: Number(correction?.stats?.maxStreak) || 0,
    };
    let activeRun = stats.streak;
    let previousPuzzle = 0;

    for (const entry of entries) {
      if (entry.created_at <= correctedAt) {
        previousPuzzle = entry.puzzle || previousPuzzle;
        continue;
      }

      stats.played += 1;
      if (entry.won) {
        stats.won += 1;
        activeRun = isNextWord5Puzzle(previousPuzzle, entry.puzzle)
          ? activeRun + 1
          : 1;
        stats.streak = activeRun;
        stats.maxStreak = Math.max(stats.maxStreak, activeRun);
      } else {
        activeRun = 0;
        stats.streak = 0;
      }
      previousPuzzle = entry.puzzle || previousPuzzle;
    }

    return stats;
  }

  function buildLatestTaggedStats(entries, fallbackStats) {
    const latestTagged = entries
      .filter((entry) =>
        entry.streak > 0 ||
        entry.maxStreak > 0 ||
        entry.played > 0 ||
        entry.taggedWon > 0
      )
      .slice()
      .sort((a, b) => b.created_at - a.created_at)[0];
    if (!latestTagged) return null;

    const hoursSinceLastPost = (Date.now() / 1000 - latestTagged.created_at) / 3600;
    const streakExpired = hoursSinceLastPost > WORD5_STREAK_EXPIRY_HOURS;
    const streak = streakExpired ? 0 : latestTagged.streak;
    return {
      stats: {
        played: latestTagged.played || Number(fallbackStats?.played) || 0,
        won: latestTagged.taggedWon || Number(fallbackStats?.won) || 0,
        streak,
        maxStreak: latestTagged.maxStreak || Math.max(Number(fallbackStats?.maxStreak) || 0, streak),
      },
      meta: {
        latestTaggedAt: latestTagged.created_at,
        trailingWinRun: streak,
        hoursSinceLastPost,
        streakExpired,
      },
    };
  }

  async function fetchWord5History(pubkey) {
    const { SimplePool } = await import("https://esm.sh/nostr-tools@2?bundle");
    const pool = new SimplePool();
    const relays = getRelayList();
    try {
      return await pool.querySync(relays, {
        kinds: [1, 5555],
        authors: [pubkey],
        "#t": ["word5"],
        since: WORD5_REPAIR_SINCE,
        limit: WORD5_REPAIR_LIMIT,
      });
    } finally {
      try {
        pool.close(relays);
      } catch (_) {}
    }
  }

  async function reconstructWord5Stats(pubkey) {
    const events = await fetchWord5History(pubkey);
    const parsed = (events || []).map(parseWord5Event).filter(Boolean);
    const entries = dedupeWord5Entries(parsed);
    const summary = buildWord5Stats(entries);
    const taggedStats = buildLatestTaggedStats(entries, summary?.stats);
    const correction = (events || [])
      .map(parseWord5StatsCorrection)
      .filter(Boolean)
      .sort((a, b) => b.created_at - a.created_at)[0] || null;
    if (!summary) {
      return {
        stats: correction?.stats || null,
        entries: [],
        meta: {
          totalEvents: events?.length || 0,
          uniqueGames: 0,
          trailingWinRun: 0,
          hoursSinceLastPost: Number.POSITIVE_INFINITY,
          streakExpired: true,
          firstPlayedAt: 0,
          lastPlayedAt: 0,
          hasCorrection: Boolean(correction),
        },
      };
    }
    const correctedStats = correction
      ? applyCorrectionBaseline(correction, entries)
      : null;
    return {
      stats: correctedStats || taggedStats?.stats || summary.stats,
      entries,
      meta: {
        ...summary.meta,
        ...(taggedStats?.meta || {}),
        totalEvents: events?.length || 0,
        hasCorrection: Boolean(correction),
        usedTaggedStats: Boolean(!correctedStats && taggedStats),
      },
    };
  }

  function readPersistedWord5Stats() {
    try {
      const saved = JSON.parse(localStorage.getItem(WORD5_STORAGE_KEY) || "{}") || {};
      const stats = saved.stats || {};
      return {
        played: Number(stats.played) || 0,
        won: Number(stats.won) || 0,
        streak: Number(stats.streak) || 0,
        maxStreak: Number(stats.maxStreak) || 0,
      };
    } catch (_) {
      return { played: 0, won: 0, streak: 0, maxStreak: 0 };
    }
  }

  function persistWord5Stats(stats) {
    if (!stats) return;
    if (window.Word5App?.applyRepairedStats) {
      window.Word5App.applyRepairedStats(stats);
      return;
    }

    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(WORD5_STORAGE_KEY) || "{}") || {};
    } catch (_) {
      saved = {};
    }
    saved.stats = {
      played: Number(stats.played) || 0,
      won: Number(stats.won) || 0,
      streak: Number(stats.streak) || 0,
      maxStreak: Number(stats.maxStreak) || 0,
    };
    localStorage.setItem(WORD5_STORAGE_KEY, JSON.stringify(saved));
  }

  async function publishWord5StatsCorrection(stats) {
    if (window.NostrSigners?.ready) {
      await window.NostrSigners.ready();
    }
    if (!window.NostrSigners) {
      throw new Error("Nostr signer not available");
    }

    const signer = await window.NostrSigners.getActiveSigner();
    const { SimplePool } = await import("https://esm.sh/nostr-tools@2?bundle");
    const pool = new SimplePool();
    const relays = getRelayList();
    const payload = {
      game: "word5",
      type: "stats-correction",
      stats,
      version: 1,
    };
    const unsigned = {
      kind: 5555,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["t", "word5"],
        ["game", "word5"],
        ["schema", "word5.stats.v1"],
        ["type", "stats-correction"],
        ["streak", String(stats.streak)],
        ["maxStreak", String(stats.maxStreak)],
        ["played", String(stats.played)],
        ["won", String(stats.won)],
        ["version", "1"],
      ],
      content: JSON.stringify(payload),
    };

    try {
      const signed = await signer.signEvent(unsigned);
      const results = await Promise.allSettled(pool.publish(relays, signed));
      if (!results.some((result) => result.status === "fulfilled")) {
        throw new Error("No relay confirmed the stats correction");
      }
      return signed;
    } finally {
      try {
        pool.close(relays);
      } catch (_) {}
    }
  }

  function clearProfilePreviewUrl() {
    if (state.profilePreviewUrl) {
      URL.revokeObjectURL(state.profilePreviewUrl);
      state.profilePreviewUrl = "";
    }
  }

  function renderProfilePreview(src, fallbackText) {
    const preview = $("profilePreview");
    if (!preview) return;
    if (src) {
      preview.innerHTML = `<img src="${src}" alt="" style="width:100%;height:100%;object-fit:cover;">`;
      return;
    }
    const initial = (fallbackText || "?").trim().slice(0, 1).toUpperCase() || "?";
    preview.textContent = initial;
  }

  function updateProfilePictureUi() {
    const fileInput = $("profilePictureInput");
    const urlInput = $("profilePictureUrl");
    const nameInput = $("profileNameInput");
    if (urlInput) {
      urlInput.value = state.profilePictureUrl || "";
    }
    renderProfilePreview(
      state.profilePreviewUrl || state.profilePictureUrl,
      nameInput?.value || "?"
    );
    if (fileInput) {
      fileInput.value = "";
    }
  }

  function ensureProfileManagerUi() {
    if ($("profileModal")) return;

    const style = document.createElement("style");
    style.textContent = `
      #profileModal {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.72);
        align-items: center;
        justify-content: center;
        z-index: 1350;
        padding: 12px;
      }
      #profileModalCard {
        width: min(92vw, 420px);
        background: #1a1a1b;
        border: 1px solid #3a3a3c;
        color: #ffffff;
        border-radius: 12px;
        padding: 18px;
        box-shadow: 0 16px 34px rgba(0,0,0,0.5);
      }
      .profile-modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 14px;
      }
      .profile-modal-subtle {
        font-size: 11px;
        color: #818384;
        line-height: 1.45;
      }
      .profile-preview {
        width: 96px;
        height: 96px;
        border-radius: 50%;
        overflow: hidden;
        border: 2px solid #3a3a3c;
        background: #121213;
        display: flex;
        align-items: center;
        justify-content: center;
        margin: 4px auto 14px;
        font-size: 34px;
        font-weight: 700;
        color: #9333ea;
      }
      .profile-label {
        font-size: 11px;
        color: #818384;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin: 10px 0 6px;
      }
      .profile-textarea {
        min-height: 92px;
        resize: vertical;
      }
      .profile-file-input {
        width: 100%;
        color: #ffffff;
        margin-bottom: 6px;
      }
      .profile-actions {
        display: flex;
        gap: 8px;
        margin-top: 14px;
      }
      .profile-actions .nostr-btn {
        margin-bottom: 0;
      }
      #profileSaveBtn {
        background: #9333ea;
      }
      #profileSaveStatus {
        min-height: 18px;
        margin-top: 10px;
        font-size: 12px;
        color: #818384;
      }
      #profileRepairBtn {
        background: #f97316;
      }
      #profileRepairStatus {
        min-height: 18px;
        margin-top: 10px;
        font-size: 12px;
        color: #818384;
      }
      #bunkerModal {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.72);
        align-items: center;
        justify-content: center;
        z-index: 1360;
        padding: 12px;
      }
      #bunkerModalCard {
        width: min(92vw, 420px);
        background: #1a1a1b;
        border: 1px solid #3a3a3c;
        color: #ffffff;
        border-radius: 12px;
        padding: 18px;
        box-shadow: 0 16px 34px rgba(0,0,0,0.5);
      }
      #bunkerConnectBtn {
        background: #9333ea;
      }
      #bunkerStatus {
        min-height: 18px;
        margin-top: 10px;
        font-size: 12px;
        color: #818384;
      }
      #nsecLoginModal {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.72);
        align-items: center;
        justify-content: center;
        z-index: 1360;
        padding: 12px;
      }
      #nsecLoginModalCard {
        width: min(92vw, 420px);
        background: #1a1a1b;
        border: 1px solid #3a3a3c;
        color: #ffffff;
        border-radius: 12px;
        padding: 18px;
        box-shadow: 0 16px 34px rgba(0,0,0,0.5);
      }
      #nsecLoginImportBtn {
        background: #9333ea;
      }
      #nsecLoginStatus {
        min-height: 18px;
        margin-top: 10px;
        font-size: 12px;
        color: #818384;
      }
    `;
    document.head.appendChild(style);

    const MODAL_OVERLAY_STYLE = "display:none;position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(0,0,0,0.72);align-items:center;justify-content:center;padding:12px;";
    const MODAL_CARD_STYLE = "width:min(92vw,420px);background:#1a1a1b;border:1px solid #3a3a3c;color:#ffffff;border-radius:12px;padding:18px;box-shadow:0 16px 34px rgba(0,0,0,0.5);";

    const modal = document.createElement("div");
    modal.id = "profileModal";
    modal.style.cssText = MODAL_OVERLAY_STYLE + "z-index:1350;";
    modal.innerHTML = `
      <div id="profileModalCard" style="${MODAL_CARD_STYLE}max-height:80vh;overflow-y:auto;">
        <div class="profile-modal-header">
          <div>
            <div style="font-weight:700;font-size:18px;">My Profile</div>
            <div id="profilePubkeyLabel" class="profile-modal-subtle"></div>
          </div>
          <button id="profileModalClose" class="nostr-btn" type="button" style="width:auto;padding:8px 12px;margin:0;">Close</button>
        </div>
        <div id="profilePreview" class="profile-preview">?</div>
        <div class="profile-label">Display name</div>
        <input id="profileNameInput" class="nostr-input" maxlength="64" placeholder="Your name">
        <div class="profile-label">Description</div>
        <textarea id="profileAboutInput" class="nostr-input profile-textarea" maxlength="280" placeholder="A short note about you"></textarea>
        <div class="profile-label">Profile picture</div>
        <input id="profilePictureInput" class="profile-file-input" type="file" accept="image/*">
        <input id="profilePictureUrl" class="nostr-input" placeholder="No profile picture yet" readonly>
        <div class="profile-modal-subtle">Images upload to Primal Blossom before the kind 0 profile is published.</div>
        <div class="profile-actions">
          <button id="profileClearImageBtn" class="nostr-btn" type="button">Clear picture</button>
          <button id="profileSaveBtn" class="nostr-btn" type="button">Save profile</button>
        </div>
        <div id="profileSaveStatus"></div>
        <div style="border-top:1px solid #3a3a3c;margin-top:14px;padding-top:12px;">
          <div class="profile-label">Stats</div>
          <div class="profile-modal-subtle">Rebuild WORD5 stats from signed posts since ${WORD5_REPAIR_SINCE_LABEL}.</div>
          <div class="profile-actions" style="margin-top:10px;">
            <button id="profileRepairBtn" class="nostr-btn" type="button">Repair streak from Nostr</button>
          </div>
          <div class="profile-modal-subtle" style="margin-top:12px;">Lower local stats and publish a signed correction for leaderboard readers.</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">
            <label>
              <span class="profile-modal-subtle">Current</span>
              <input id="profileCurrentStreakInput" class="nostr-input" type="number" min="0" step="1" inputmode="numeric">
            </label>
            <label>
              <span class="profile-modal-subtle">Best</span>
              <input id="profileBestStreakInput" class="nostr-input" type="number" min="0" step="1" inputmode="numeric">
            </label>
          </div>
          <div class="profile-actions" style="margin-top:10px;">
            <button id="profileApplyStatsBtn" class="nostr-btn" type="button">Apply stats correction</button>
          </div>
          <div id="profileRepairStatus"></div>
        </div>
        <div style="border-top:1px solid #3a3a3c;margin-top:14px;padding-top:12px;">
          <div class="profile-label">Keys</div>
          <button id="profileCopyNpub" class="nostr-btn" type="button">Copy npub (public key)</button>
          <button id="profileCopyNsec" class="nostr-btn session-only" type="button">Copy nsec (secret key)</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const bunkerModal = document.createElement("div");
    bunkerModal.id = "bunkerModal";
    bunkerModal.style.cssText = MODAL_OVERLAY_STYLE + "z-index:1360;";
    bunkerModal.innerHTML = `
      <div id="bunkerModalCard" style="${MODAL_CARD_STYLE}">
        <div class="profile-modal-header">
          <div>
            <div style="font-weight:700;font-size:18px;">Bunker login</div>
            <div class="profile-modal-subtle">Paste a <code>bunker://</code> URI or a bunker NIP-05 handle.</div>
          </div>
          <button id="bunkerModalClose" class="nostr-btn" type="button" style="width:auto;padding:8px 12px;margin:0;">Close</button>
        </div>
        <textarea id="bunkerUriInput" class="nostr-input profile-textarea" placeholder="bunker://... or signer@example.com"></textarea>
        <div class="profile-modal-subtle">This connects a remote signer using NIP-46. It becomes the active signer for posts, profile updates, and duel shares.</div>
        <div class="profile-actions">
          <button id="bunkerConnectBtn" class="nostr-btn" type="button">Connect bunker</button>
        </div>
        <div id="bunkerStatus"></div>
      </div>
    `;
    document.body.appendChild(bunkerModal);

    const nsecLoginModal = document.createElement("div");
    nsecLoginModal.id = "nsecLoginModal";
    nsecLoginModal.style.cssText = MODAL_OVERLAY_STYLE + "z-index:1360;";
    nsecLoginModal.innerHTML = `
      <div id="nsecLoginModalCard" style="${MODAL_CARD_STYLE}">
        <div class="profile-modal-header">
          <div>
            <div style="font-weight:700;font-size:18px;">Password Login</div>
            <div class="profile-modal-subtle">Paste your nsec private key to log in.</div>
          </div>
          <button id="nsecLoginModalClose" class="nostr-btn" type="button" style="width:auto;padding:8px 12px;margin:0;">Close</button>
        </div>
        <input id="nsecLoginInput" class="nostr-input" type="password" placeholder="nsec1..." style="margin-top:8px;">
        <div class="profile-actions">
          <button id="nsecLoginImportBtn" class="nostr-btn" type="button">Login</button>
        </div>
        <div id="nsecLoginStatus"></div>
      </div>
    `;
    document.body.appendChild(nsecLoginModal);

    // Login chooser modal
    const loginChooser = document.createElement("div");
    loginChooser.id = "loginChooserModal";
    loginChooser.style.cssText = MODAL_OVERLAY_STYLE + "z-index:1340;";
    loginChooser.innerHTML = `
      <div style="${MODAL_CARD_STYLE}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <div style="font-weight:700;font-size:18px;">Login Nostr</div>
          <button id="loginChooserClose" class="nostr-btn" type="button" style="width:auto;padding:8px 12px;margin:0;">Close</button>
        </div>
        <div style="font-size:13px;color:#818384;margin-bottom:14px;">Choose how to connect your Nostr identity</div>
        <button id="loginOptExtension" class="nostr-btn" type="button" style="text-align:left;padding:14px 12px;">
          <div style="font-weight:600;font-size:14px;color:#fff;">Login - Browser Extension</div>
          <div style="font-size:11px;color:#818384;margin-top:2px;">Use NIP-07 signer (Alby, nos2x, etc.)</div>
        </button>
        <button id="loginOptBunker" class="nostr-btn" type="button" style="text-align:left;padding:14px 12px;">
          <div style="font-weight:600;font-size:14px;color:#fff;">Login - NSec Bunker</div>
          <div style="font-size:11px;color:#818384;margin-top:2px;">Connect a remote signer via NIP-46</div>
        </button>
        <button id="loginOptNsec" class="nostr-btn" type="button" style="text-align:left;padding:14px 12px;">
          <div style="font-weight:600;font-size:14px;color:#fff;">Login - BYO Nsec</div>
          <div style="font-size:11px;color:#818384;margin-top:2px;">Import your own private key</div>
        </button>
        <button id="loginOptAnon" class="nostr-btn" type="button" style="text-align:left;padding:14px 12px;">
          <div style="font-weight:600;font-size:14px;color:#fff;">Log in Anon</div>
          <div style="font-size:11px;color:#818384;margin-top:2px;">Generate a new ephemeral key</div>
        </button>
      </div>
    `;
    document.body.appendChild(loginChooser);

    // Bind modal button listeners here — they can't be bound in init()
    // because these elements don't exist until ensureProfileManagerUi() runs.
    $("profileModalClose")?.addEventListener("click", () => closeProfileModal());
    modal.addEventListener("click", (e) => { if (e.target === modal) closeProfileModal(); });
    $("bunkerModalClose")?.addEventListener("click", () => closeBunkerModal());
    bunkerModal.addEventListener("click", (e) => { if (e.target === bunkerModal) closeBunkerModal(); });
    $("bunkerConnectBtn")?.addEventListener("click", () => connectBunkerFromModal());
    $("nsecLoginModalClose")?.addEventListener("click", () => closeNsecLoginModal());
    nsecLoginModal.addEventListener("click", (e) => { if (e.target === nsecLoginModal) closeNsecLoginModal(); });
    $("nsecLoginImportBtn")?.addEventListener("click", () => submitNsecLogin());

    // Profile form bindings
    const profileNameInput = $("profileNameInput");
    if (profileNameInput) {
      profileNameInput.addEventListener("input", () => {
        renderProfilePreview(
          state.profilePreviewUrl || state.profilePictureUrl,
          profileNameInput.value
        );
      });
    }
    const profilePictureInput = $("profilePictureInput");
    if (profilePictureInput) {
      profilePictureInput.addEventListener("change", (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        clearProfilePreviewUrl();
        state.profilePictureFile = file;
        state.profilePreviewUrl = URL.createObjectURL(file);
        updateProfilePictureUi();
      });
    }
    $("profileClearImageBtn")?.addEventListener("click", () => {
      clearProfilePreviewUrl();
      state.profilePictureFile = null;
      state.profilePictureUrl = "";
      updateProfilePictureUi();
    });
    $("profileSaveBtn")?.addEventListener("click", () => saveProfile());
    $("profileRepairBtn")?.addEventListener("click", () => repairWord5StatsFromProfile());
    $("profileApplyStatsBtn")?.addEventListener("click", () => applyManualStatsCorrection());

    // Copy npub / nsec buttons in profile modal
    $("profileCopyNpub")?.addEventListener("click", async () => {
      try {
        const npub = getActiveNpub();
        if (!npub) throw new Error("No npub available");
        await navigator.clipboard.writeText(npub);
        showToast("Copied npub");
      } catch (e) {
        showToast(`Copy failed: ${e?.message || e}`);
      }
    });
    $("profileCopyNsec")?.addEventListener("click", async () => {
      try {
        const player = window.NostrSession?.getPlayer();
        if (!player?.nsec) throw new Error("No nsec available");
        await navigator.clipboard.writeText(player.nsec);
        showToast("Copied nsec — keep it secret!");
      } catch (e) {
        showToast(`Copy failed: ${e?.message || e}`);
      }
    });

    // Login chooser bindings
    $("loginChooserClose")?.addEventListener("click", () => closeLoginChooser());
    loginChooser.addEventListener("click", (e) => { if (e.target === loginChooser) closeLoginChooser(); });
    $("loginOptExtension")?.addEventListener("click", async () => {
      closeLoginChooser();
      await loginWithNostr();
    });
    $("loginOptBunker")?.addEventListener("click", () => {
      closeLoginChooser();
      openBunkerModal();
    });
    $("loginOptNsec")?.addEventListener("click", () => {
      closeLoginChooser();
      openNsecLoginModal();
    });
    $("loginOptAnon")?.addEventListener("click", async () => {
      closeLoginChooser();
      await window.NostrSession.resetPlayer();
      state.revealed = false;
      showToast("New anonymous session created");
      renderKeys(window.NostrSession.getPlayer());
      renderAvatar(window.NostrSession.getPlayer());
    });
  }

  async function loadProfile(pubkey, options = {}) {
    if (!pubkey) return null;
    if (!options.force && profileCache.has(pubkey)) {
      return profileCache.get(pubkey);
    }

    try {
      const { SimplePool } = await import("https://esm.sh/nostr-tools@2?bundle");
      const pool = new SimplePool();
      const events = await pool.querySync(getRelayList(), {
        kinds: [0],
        authors: [pubkey],
        limit: 1,
      });
      try { pool.close(getRelayList()); } catch (_) {}

      const event = events?.sort((a, b) => b.created_at - a.created_at)?.[0];
      if (!event) {
        profileCache.set(pubkey, null);
        return null;
      }

      const data = JSON.parse(event.content);
      const profile = {
        name: data.display_name || data.name || "",
        about: data.about || "",
        picture: data.picture || "",
        data,
      };
      profileCache.set(pubkey, profile);
      return profile;
    } catch (_) {
      profileCache.set(pubkey, null);
      return null;
    }
  }

  function renderTimerIdentityLabel(text) {
    const el = $("timerIdentityLabel");
    if (!el) return;
    if (text) {
      el.textContent = text;
      el.hidden = false;
    } else {
      el.textContent = "";
      el.hidden = true;
    }
  }

  async function syncTimerIdentity(player) {
    const pubkey = getIdentityPubkey(player);
    if (!pubkey) {
      renderTimerIdentityLabel("");
      return;
    }

    const profile = await loadProfile(pubkey);
    renderTimerIdentityLabel(profile?.name || "");
  }


  async function loginWithNostr() {
    try {
      await window.NostrSession.loginWithNip07();
      showToast("Linked NIP-07 signer");
      const player = window.NostrSession.getPlayer();
      renderKeys(player);
      renderAvatar(player);
      syncTimerIdentity(player);
    } catch (e) {
      showToast(`Login failed: ${e?.message || e}`);
    }
  }

  function openNsecLoginModal() {
    ensureProfileManagerUi();
    const modal = $("nsecLoginModal");
    const input = $("nsecLoginInput");
    const status = $("nsecLoginStatus");
    if (!modal || !input || !status) return;
    input.value = "";
    status.textContent = "";
    modal.style.display = "flex";
  }

  function closeNsecLoginModal() {
    const modal = $("nsecLoginModal");
    if (!modal) return;
    modal.style.display = "none";
  }

  async function submitNsecLogin() {
    const input = $("nsecLoginInput");
    const status = $("nsecLoginStatus");
    if (!input || !status) return;
    const value = input.value.trim();
    if (!value) {
      status.textContent = "Enter your nsec key.";
      return;
    }
    try {
      await window.NostrSession.importNsec(value);
      input.value = "";
      state.revealed = false;
      showToast("Imported session key");
      renderKeys(window.NostrSession.getPlayer());
      renderAvatar(window.NostrSession.getPlayer());
      closeNsecLoginModal();
    } catch (e) {
      status.textContent = `Import failed: ${e?.message || e}`;
    }
  }

  async function openProfileModal() {
    ensureProfileManagerUi();
    const modal = $("profileModal");
    const status = $("profileSaveStatus");
    const repairStatus = $("profileRepairStatus");
    const pubkeyLabel = $("profilePubkeyLabel");
    const nameInput = $("profileNameInput");
    const aboutInput = $("profileAboutInput");
    if (!modal || !status || !repairStatus || !pubkeyLabel || !nameInput || !aboutInput) return;

    try {
      if (window.NostrSigners?.ready) {
        await window.NostrSigners.ready();
      }
      if (!window.NostrSigners) {
        throw new Error("Nostr signer not available");
      }

      const signer = await window.NostrSigners.getActiveSigner();
      const pubkey = await signer.getPublicKey();
      state.profilePubkey = pubkey;
      clearProfilePreviewUrl();
      state.profilePictureFile = null;

      const profile = await loadProfile(pubkey, { force: true });
      nameInput.value = profile?.name || "";
      aboutInput.value = profile?.about || "";
      state.profilePictureUrl = profile?.picture || "";
      updateProfilePictureUi();
      const fullNpub = window.NostrSigners.getDisplayNpub() || pubkey;
      pubkeyLabel.textContent = fullNpub.length > 16 ? `${fullNpub.slice(0, 10)}…${fullNpub.slice(-6)}` : fullNpub;
      status.textContent = "Publishes a kind 0 profile for the active signer.";
      repairStatus.textContent = `Scans signed WORD5 posts since ${WORD5_REPAIR_SINCE_LABEL}.`;
      refreshStatsCorrectionInputs();

      // Refresh session-only visibility for copy nsec button
      const player = window.NostrSession?.getPlayer();
      modal.querySelectorAll(".session-only").forEach((el) => {
        el.style.display = player?.auth_mode === "session" ? "" : "none";
      });

      modal.style.display = "flex";
    } catch (e) {
      showToast(`Profile unavailable: ${e?.message || e}`);
    }
  }

  function openLoginChooser() {
    ensureProfileManagerUi();
    const modal = $("loginChooserModal");
    if (!modal) return;
    modal.style.display = "flex";
  }

  function closeLoginChooser() {
    const modal = $("loginChooserModal");
    if (modal) modal.style.display = "none";
  }

  function openBunkerModal() {
    ensureProfileManagerUi();
    const modal = $("bunkerModal");
    const input = $("bunkerUriInput");
    const status = $("bunkerStatus");
    if (!modal || !input || !status) return;
    input.value = window.NostrSession?.getPlayer()?.bunker_uri || "";
    status.textContent = "Connect a remote signer for bunker-based signing.";
    modal.style.display = "flex";
  }

  function closeBunkerModal() {
    const modal = $("bunkerModal");
    if (!modal) return;
    modal.style.display = "none";
  }

  async function connectBunkerFromModal() {
    const input = $("bunkerUriInput");
    const status = $("bunkerStatus");
    const connectBtn = $("bunkerConnectBtn");
    if (!input || !status || !connectBtn) return;

    const bunkerUri = input.value.trim();
    if (!bunkerUri) {
      status.textContent = "Enter a bunker URI or signer handle.";
      return;
    }

    connectBtn.disabled = true;
    connectBtn.textContent = "Connecting...";
    status.textContent = "Connecting to bunker…";

    try {
      if (!window.NostrSigners?.connectBunker) {
        throw new Error("Bunker signer support unavailable");
      }

      const identity = await window.NostrSigners.connectBunker(bunkerUri);
      window.NostrSession.loginWithBunker({
        bunkerUri,
        pubkey: identity.pubkey,
        npub: identity.npub,
      });
      const player = window.NostrSession.getPlayer();
      renderKeys(player);
      renderAvatar(player);
      syncTimerIdentity(player);
      status.textContent = "Connected.";
      showToast("Connected bunker signer");
      setTimeout(() => closeBunkerModal(), 300);
    } catch (e) {
      status.textContent = e?.message || String(e);
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = "Connect bunker";
    }
  }

  function closeProfileModal() {
    const modal = $("profileModal");
    if (!modal) return;
    modal.style.display = "none";
    clearProfilePreviewUrl();
    state.profilePictureFile = null;
  }

  async function saveProfile() {
    const status = $("profileSaveStatus");
    const saveBtn = $("profileSaveBtn");
    const nameInput = $("profileNameInput");
    const aboutInput = $("profileAboutInput");
    if (!status || !saveBtn || !nameInput || !aboutInput) return;

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    status.textContent = "Preparing profile…";

    try {
      if (!window.NostrSigners) throw new Error("Nostr signer not available");
      const signer = await window.NostrSigners.getActiveSigner();
      const pubkey = state.profilePubkey || (await signer.getPublicKey());
      const current = (await loadProfile(pubkey, { force: true })) || { data: {} };

      let picture = state.profilePictureUrl || "";
      if (state.profilePictureFile) {
        status.textContent = "Uploading profile image to Primal Blossom…";
        const descriptor = await uploadBlobToBlossom({
          blob: state.profilePictureFile,
          signer,
          serverUrl: BLOSSOM_UPLOAD_SERVER,
          sha256: await sha256Hex(state.profilePictureFile),
        });
        picture = descriptor.url;
        state.profilePictureUrl = picture;
        state.profilePictureFile = null;
        updateProfilePictureUi();
      }

      const nextData = { ...(current.data || {}) };
      nextData.name = nameInput.value.trim();
      nextData.display_name = nameInput.value.trim();
      nextData.about = aboutInput.value.trim();
      nextData.picture = picture;

      status.textContent = "Publishing kind 0 profile…";
      const unsigned = {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify(nextData),
      };
      const signed = await signer.signEvent(unsigned);

      const { SimplePool } = await import("https://esm.sh/nostr-tools@2?bundle");
      const pool = new SimplePool();
      const publishPromises = pool.publish(getRelayList(), signed);
      const results = await Promise.allSettled(publishPromises);
      try {
        pool.close(getRelayList());
      } catch (_) {}
      if (!results.some((result) => result.status === "fulfilled")) {
        throw new Error("No relay confirmed the profile update");
      }

      const nextProfile = {
        name: nextData.display_name || nextData.name || "",
        about: nextData.about || "",
        picture: nextData.picture || "",
        data: nextData,
      };
      profileCache.set(pubkey, nextProfile);
      renderTimerIdentityLabel(nextProfile.name || "");
      status.textContent = "Profile updated.";
      showToast("Published profile");
      setTimeout(() => closeProfileModal(), 400);
    } catch (e) {
      status.textContent = e?.message || String(e);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save profile";
    }
  }

  async function repairWord5StatsFromProfile() {
    const repairBtn = $("profileRepairBtn");
    const repairStatus = $("profileRepairStatus");
    if (!repairBtn || !repairStatus) return;

    repairBtn.disabled = true;
    repairBtn.textContent = "Repairing...";
    repairStatus.textContent = `Scanning signed WORD5 posts since ${WORD5_REPAIR_SINCE_LABEL}…`;

    try {
      if (window.NostrSigners?.ready) {
        await window.NostrSigners.ready();
      }
      if (!window.NostrSigners) {
        throw new Error("Nostr signer not available");
      }

      const signer = await window.NostrSigners.getActiveSigner();
      const pubkey = state.profilePubkey || (await signer.getPublicKey());
      const report = await reconstructWord5Stats(pubkey);
      if (!report.stats) {
        repairStatus.textContent = `No signed WORD5 posts found since ${WORD5_REPAIR_SINCE_LABEL}.`;
        return;
      }

      persistWord5Stats(report.stats);
      refreshStatsCorrectionInputs(report.stats);
      const expiryNote = report.meta.streakExpired && report.meta.trailingWinRun > 0
        ? ` Current streak expired after ${Math.round(report.meta.hoursSinceLastPost)}h without a post.`
        : "";
      repairStatus.textContent =
        `Scanned ${report.meta.totalEvents} signed events and rebuilt ${report.meta.uniqueGames} games. ` +
        `Streak ${report.stats.streak}, best ${report.stats.maxStreak}.${expiryNote}`;
      showToast("WORD5 stats repaired");
    } catch (e) {
      repairStatus.textContent = e?.message || String(e);
    } finally {
      repairBtn.disabled = false;
      repairBtn.textContent = "Repair streak from Nostr";
    }
  }

  function refreshStatsCorrectionInputs(stats = readPersistedWord5Stats()) {
    const currentInput = $("profileCurrentStreakInput");
    const bestInput = $("profileBestStreakInput");
    if (currentInput) currentInput.value = String(Number(stats.streak) || 0);
    if (bestInput) bestInput.value = String(Number(stats.maxStreak) || 0);
  }

  async function applyManualStatsCorrection() {
    const applyBtn = $("profileApplyStatsBtn");
    const repairStatus = $("profileRepairStatus");
    const currentInput = $("profileCurrentStreakInput");
    const bestInput = $("profileBestStreakInput");
    if (!applyBtn || !repairStatus || !currentInput || !bestInput) return;

    const current = Math.max(0, Number.parseInt(currentInput.value, 10) || 0);
    const best = Math.max(current, Number.parseInt(bestInput.value, 10) || 0);
    const existing = readPersistedWord5Stats();
    const nextStats = {
      played: existing.played,
      won: existing.won,
      streak: current,
      maxStreak: best,
    };

    applyBtn.disabled = true;
    applyBtn.textContent = "Publishing...";
    repairStatus.textContent = "Applying local stats and publishing correction...";

    try {
      persistWord5Stats(nextStats);
      refreshStatsCorrectionInputs(nextStats);
      await publishWord5StatsCorrection(nextStats);
      repairStatus.textContent = `Stats corrected. Streak ${nextStats.streak}, best ${nextStats.maxStreak}.`;
      showToast("Stats correction published");
    } catch (e) {
      repairStatus.textContent = e?.message || String(e);
    } finally {
      applyBtn.disabled = false;
      applyBtn.textContent = "Apply stats correction";
    }
  }



  function renderKeys(player) {
    const npubEl = $("keysModalNpub");
    const nsecEl = $("keysModalNsec");
    const toggle = $("keysModalToggle");
    const note = $("keysModalNote");
    if (!npubEl || !nsecEl || !toggle || !note) return;
    const linked = player?.linked_npub ? `\nlinked npub: ${player.linked_npub}` : "";
    npubEl.textContent = `session npub: ${player?.npub || "—"}${linked}`;
    const hasNsec = player?.auth_mode === "session" && player?.nsec;
    if (hasNsec) {
      nsecEl.textContent = state.revealed
        ? `nsec: ${player.nsec}`
        : `nsec: ${"•".repeat(Math.max(16, String(player.nsec).length))}`;
      toggle.style.display = "";
      toggle.textContent = state.revealed ? "🙈" : "👁";
    } else {
      nsecEl.textContent =
        player?.auth_mode === "nip07"
          ? "Using NIP-07 signer; session nsec hidden."
          : player?.auth_mode === "bunker"
            ? "Using bunker signer; session nsec hidden."
          : "No session key available.";
      toggle.style.display = "none";
    }
    note.textContent =
      player?.auth_mode === "nip07"
        ? "Extension signs events. Session key is fallback only."
        : player?.auth_mode === "bunker"
          ? "Remote bunker signs events. Session key is fallback only."
        : "Stored in this browser. Export/import to move devices.";
  }

  function renderAvatar(player) {
    const bubble = $("nostrAvatarBubble");
    const label = $("nostrAvatarLabel");
    const mode =
      player?.auth_mode === "nip07"
        ? "NIP-07"
        : player?.auth_mode === "bunker"
          ? "Bunker"
          : "Session";
    if (bubble) {
      bubble.textContent = "☰";
    }
    if (label) label.textContent = `${mode}: ${shortNpub(
      player?.linked_npub || player?.npub
    )}`;
    document.querySelectorAll(".session-only").forEach((el) => {
      el.style.display = player?.auth_mode === "session" ? "" : "none";
    });
  }

  function bindEvents() {
    const toggle = $("keysModalToggle");
    if (toggle) {
      toggle.onclick = () => {
        state.revealed = !state.revealed;
        renderKeys(window.NostrSession?.getPlayer());
      };
    }

    const copyBtn = $("keysCopyBtn");
    if (copyBtn) {
      copyBtn.onclick = async () => {
        try {
          const nsec = window.NostrSession?.exportNsec();
          if (!nsec) throw new Error("No session nsec to copy");
          await navigator.clipboard.writeText(nsec);
          showToast("Copied session nsec");
        } catch (e) {
          showToast(`Copy failed: ${e?.message || e}`);
        }
      };
    }

    const npubCopyBtn = $("npubCopyBtn");
    if (npubCopyBtn) {
      npubCopyBtn.onclick = async () => {
        try {
          const npub = getActiveNpub();
          if (!npub) throw new Error("No npub available");
          await navigator.clipboard.writeText(npub);
          showToast("Copied npub");
        } catch (e) {
          showToast(`Copy failed: ${e?.message || e}`);
        }
      };
    }

    const newPlayerBtn = $("keysNewPlayerBtn");
    if (newPlayerBtn) {
      newPlayerBtn.onclick = async () => {
        await window.NostrSession.resetPlayer();
        state.revealed = false;
        showToast("New session created");
        renderKeys(window.NostrSession.getPlayer());
        renderAvatar(window.NostrSession.getPlayer());
      };
    }

    // Single "Login Nostr" button opens the login chooser modal
    const loginNostrBtn = $("loginNostrBtn");
    if (loginNostrBtn) {
      loginNostrBtn.onclick = () => {
        $("nostrAvatarDropdown")?.classList.remove("open");
        openLoginChooser();
      };
    }

    const profileOpenBtn = $("profileOpenBtn");
    if (profileOpenBtn) {
      profileOpenBtn.onclick = async () => {
        $("nostrAvatarDropdown")?.classList.remove("open");
        await openProfileModal();
      };
    }

    const dropdownToggle = $("nostrAvatarBubble");
    const dropdown = $("nostrAvatarDropdown");
    if (dropdownToggle && dropdown) {
      dropdownToggle.addEventListener("click", () => {
        dropdown.classList.toggle("open");
      });
      document.addEventListener("click", (e) => {
        if (!dropdown.contains(e.target) && e.target !== dropdownToggle) {
          dropdown.classList.remove("open");
        }
      });
    }

    const donateBtn = $("donateBtn");
    if (donateBtn) {
      donateBtn.addEventListener("click", () => openDonateModal());
    }
    const menuDonateBtn = $("menuDonateBtn");
    if (menuDonateBtn) {
      menuDonateBtn.addEventListener("click", () => {
        $("nostrAvatarDropdown")?.classList.remove("open");
        openDonateModal();
      });
    }

    const viewKeysBtn = $("keysOpenBtn");
    if (viewKeysBtn) {
      viewKeysBtn.onclick = () => showKeysModal(true);
    }

    const modal = $("keysModal");
    const close = $("keysModalClose");
    if (modal && close) {
      close.onclick = () => showKeysModal(false);
      modal.addEventListener("click", (e) => {
        if (e.target === modal) showKeysModal(false);
      });
    }

    // Streak modal bindings
    const checkStreakBtn = $("checkStreakBtn");
    if (checkStreakBtn) {
      checkStreakBtn.onclick = () => {
        $("nostrAvatarDropdown")?.classList.remove("open");
        showStreakModal(true);
      };
    }

    const streakModal = $("streakModal");
    const streakClose = $("streakModalClose");
    if (streakModal && streakClose) {
      streakClose.onclick = () => showStreakModal(false);
      streakModal.addEventListener("click", (e) => {
        if (e.target === streakModal) showStreakModal(false);
      });
    }
  }

  function showKeysModal(show) {
    const modal = $("keysModal");
    if (!modal) return;
    modal.style.display = show ? "flex" : "none";
    if (show) {
      state.revealed = false;
      renderKeys(window.NostrSession?.getPlayer());
    }
  }

  function showStreakModal(show) {
    const modal = $("streakModal");
    if (!modal) return;
    modal.style.display = show ? "flex" : "none";
    if (show) {
      fetchAndDisplayStats();
    }
  }

  async function fetchAndDisplayStats() {
    const content = $("streakModalContent");
    if (!content) return;

    content.innerHTML = '<div style="color:#818384;padding:24px;">Loading from Nostr...</div>';

    try {
      // Wait for NostrSigners
      if (window.NostrSigners?.ready) {
        await window.NostrSigners.ready();
      }

      if (!window.NostrSigners) {
        content.innerHTML = '<div style="color:#818384;padding:24px;">Nostr not available</div>';
        return;
      }

      const signer = await window.NostrSigners.getActiveSigner();
      const pubkey = await signer.getPublicKey();
      const report = await reconstructWord5Stats(pubkey);

      if (!report.stats) {
        content.innerHTML = `
          <div style="padding:24px;">
            <div style="font-size:48px;margin-bottom:16px;">🎮</div>
            <div style="color:#818384;">No games found on Nostr yet.</div>
            <div style="color:#818384;font-size:12px;margin-top:8px;">No signed WORD5 posts were found since ${WORD5_REPAIR_SINCE_LABEL}.</div>
          </div>
        `;
        return;
      }
      const totalPlayed = report.stats.played;
      const totalWon = report.stats.won;
      const maxStreak = report.stats.maxStreak;
      const displayStreak = report.stats.streak;
      const winPct = totalPlayed > 0 ? Math.round((totalWon / totalPlayed) * 100) : 0;

      content.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
          <div style="background:#2a2a2b;border-radius:8px;padding:16px;">
            <div style="font-size:32px;font-weight:700;color:#9333ea;">${displayStreak}</div>
            <div style="font-size:11px;color:#818384;text-transform:uppercase;">Current Streak</div>
          </div>
          <div style="background:#2a2a2b;border-radius:8px;padding:16px;">
            <div style="font-size:32px;font-weight:700;color:#f97316;">${maxStreak}</div>
            <div style="font-size:11px;color:#818384;text-transform:uppercase;">Best Streak</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px;">
          <div style="background:#2a2a2b;border-radius:8px;padding:12px;">
            <div style="font-size:24px;font-weight:700;">${totalPlayed}</div>
            <div style="font-size:10px;color:#818384;">Played</div>
          </div>
          <div style="background:#2a2a2b;border-radius:8px;padding:12px;">
            <div style="font-size:24px;font-weight:700;">${totalWon}</div>
            <div style="font-size:10px;color:#818384;">Won</div>
          </div>
          <div style="background:#2a2a2b;border-radius:8px;padding:12px;">
            <div style="font-size:24px;font-weight:700;">${winPct}%</div>
            <div style="font-size:10px;color:#818384;">Win Rate</div>
          </div>
        </div>
        <div style="font-size:11px;color:#818384;border-top:1px solid #3a3a3c;padding-top:12px;">
          ${report.meta.totalEvents} signed events scanned since ${WORD5_REPAIR_SINCE_LABEL}
          ${report.meta.totalEvents !== report.meta.uniqueGames ? ` · ${report.meta.uniqueGames} unique games` : ""}
          ${report.meta.streakExpired && report.meta.trailingWinRun > 0 ? " · Streak expired" : ""}
        </div>
      `;
    } catch (e) {
      console.error("[Streak] Error:", e);
      content.innerHTML = `
        <div style="padding:24px;">
          <div style="color:#f97316;">Error loading stats</div>
          <div style="color:#818384;font-size:12px;margin-top:8px;">${e?.message || e}</div>
        </div>
      `;
    }
  }

  function init() {
    ensureProfileManagerUi();
    bindEvents();
    const player = window.NostrSession?.getPlayer();
    renderKeys(player);
    renderAvatar(player);
    syncTimerIdentity(player);
    if (window.NostrSession && window.NostrSession.whenReady) {
      window.NostrSession.whenReady.then((p) => {
        renderKeys(p);
        renderAvatar(p);
        syncTimerIdentity(p);
      });
    }
    window.addEventListener("player-ready", (e) => {
      renderKeys(e.detail.player);
      renderAvatar(e.detail.player);
      syncTimerIdentity(e.detail.player);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // --- Donate modal ---
  const LIGHTNING_ADDRESS = "thegoodstuff@getalby.com";
  const LIGHTNING_URI = `lightning:${LIGHTNING_ADDRESS}`;

  function ensureDonateModal() {
    if ($("donateModal")) return;

    const modal = document.createElement("div");
    modal.id = "donateModal";
    modal.style.cssText = "display:none;position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(0,0,0,0.72);align-items:center;justify-content:center;z-index:1350;padding:12px;";
    modal.innerHTML = `
      <div style="width:min(92vw,360px);background:#1a1a1b;border:1px solid #3a3a3c;color:#ffffff;border-radius:12px;padding:24px;box-shadow:0 16px 34px rgba(0,0,0,0.5);text-align:center;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <div style="font-weight:700;font-size:18px;">Support WORD5 ⚡</div>
          <button id="donateModalClose" class="nostr-btn" style="width:auto;padding:8px 12px;margin:0;">Close</button>
        </div>
        <div style="font-size:13px;color:#818384;margin-bottom:16px;">Send a tip via Lightning to keep WORD5 running</div>
        <a id="donateQrLink" href="${LIGHTNING_URI}" style="display:block;margin:0 auto 16px;cursor:pointer;">
          <div id="donateQrContainer" style="display:flex;justify-content:center;background:#ffffff;border-radius:8px;padding:12px;"></div>
        </a>
        <div style="font-size:12px;color:#818384;margin-bottom:6px;">Lightning Address</div>
        <button id="donateCopyBtn" style="background:#2a2a2b;border:1px solid #3a3a3c;color:#f97316;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer;width:100%;word-break:break-all;">${LIGHTNING_ADDRESS}</button>
        <div style="font-size:11px;color:#818384;margin-top:8px;">Tap address to copy · Tap QR to open wallet</div>
      </div>
    `;
    document.body.appendChild(modal);

    $("donateModalClose").addEventListener("click", () => closeDonateModal());
    modal.addEventListener("click", (e) => { if (e.target === modal) closeDonateModal(); });
    $("donateCopyBtn").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(LIGHTNING_ADDRESS);
        showToast("Lightning address copied");
      } catch (_) {
        showToast("Copy failed");
      }
    });
  }

  async function openDonateModal() {
    ensureDonateModal();
    const modal = $("donateModal");
    if (!modal) return;
    modal.style.display = "flex";

    // Render QR code
    const container = $("donateQrContainer");
    if (container && !container.querySelector("canvas")) {
      try {
        const { default: QRCode } = await import("https://esm.sh/qrcode@1.5.3?bundle");
        const canvas = document.createElement("canvas");
        await QRCode.toCanvas(canvas, LIGHTNING_URI.toUpperCase(), {
          margin: 1,
          width: 220,
          color: { dark: "#121213", light: "#ffffff" },
        });
        container.innerHTML = "";
        container.appendChild(canvas);
      } catch (e) {
        container.innerHTML = '<div style="color:#818384;padding:20px;font-size:12px;">QR failed to load</div>';
      }
    }
  }

  function closeDonateModal() {
    const modal = $("donateModal");
    if (modal) modal.style.display = "none";
  }

  window.NostrUI = {
    renderKeys,
    renderAvatar,
    showKeysModal,
    showStreakModal,
    showToast,
    loginWithNostr,
    openLoginChooser,
    openProfileModal,
    openBunkerModal,
    reconstructWord5Stats,
    repairWord5StatsFromProfile,
    uploadBlobToBlossom,
    sha256Hex,
    openDonateModal,
  };
})();
