(async function () {
  const element = document.getElementById('yesterdayCount');
  try {
    const response = await fetch('api/visits/last-completed-game', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    if (!Number.isSafeInteger(data.people) || data.people < 0 || !Number.isSafeInteger(data.gameNumber)) return;
    element.textContent = `Game ${data.gameNumber} had ${data.people.toLocaleString()} ${data.people === 1 ? 'player' : 'players'}!`;
    element.hidden = false;
  } catch (_) {
    // The social feed is still usable if statistics are unavailable.
  }
})();
