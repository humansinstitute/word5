(async function () {
  const element = document.getElementById('yesterdayCount');
  try {
    const response = await fetch('api/visits/yesterday', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    if (!Number.isSafeInteger(data.people) || data.people < 0) return;
    element.textContent = `${data.people.toLocaleString()} people played Word5 yesterday!`;
    element.hidden = false;
  } catch (_) {
    // The social feed is still usable if statistics are unavailable.
  }
})();
