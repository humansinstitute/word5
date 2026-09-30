(function () {
  const button = document.getElementById('currentVisitCount');
  const dialog = document.getElementById('visitsDialog');
  const closeButton = document.getElementById('visitsDialogClose');
  const status = document.getElementById('visitsStatus');
  const table = document.getElementById('visitsTable');
  const body = document.getElementById('visitsTableBody');
  let requestNumber = 0;

  function validGame(game) {
    return game && Number.isSafeInteger(game.gameNumber) && Number.isSafeInteger(game.periodId)
      && /^\d{4}-\d{2}-\d{2}$/.test(game.puzzleDate)
      && Number.isSafeInteger(game.people) && game.people >= 0
      && Number.isSafeInteger(game.visits) && game.visits >= 0;
  }

  async function getJson(path) {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error('Visit counts are unavailable. Please try again.');
    return response.json();
  }

  function showHeadline(game) {
    button.textContent = `Current game ${game.gameNumber} has ${game.people.toLocaleString()} ${game.people === 1 ? 'player' : 'players'} · View last 7 games`;
  }

  async function loadHeadline() {
    try {
      const game = await getJson('api/visits/current-game');
      if (!validGame(game)) throw new Error('Invalid visit count');
      showHeadline(game);
    } catch (_) {
      button.textContent = 'Current game count unavailable · View last 7 games';
    }
  }

  async function openVisits() {
    const request = ++requestNumber;
    body.replaceChildren();
    table.hidden = true;
    status.hidden = false;
    status.textContent = 'Loading visits…';
    dialog.showModal();
    try {
      const data = await getJson('api/visits/recent-games');
      if (!Array.isArray(data.games) || data.games.length !== 7 || !data.games.every(validGame)) {
        throw new Error('Invalid visit counts');
      }
      if (request !== requestNumber || !dialog.open) return;
      showHeadline(data.games[0]);
      for (const game of data.games) {
        const row = document.createElement('tr');
        for (const value of [`${game.gameNumber} · ${game.puzzleDate}`, game.people.toLocaleString(), game.visits.toLocaleString()]) {
          const cell = document.createElement('td');
          cell.textContent = value;
          row.appendChild(cell);
        }
        body.appendChild(row);
      }
      status.hidden = true;
      table.hidden = false;
    } catch (_) {
      if (request === requestNumber && dialog.open) status.textContent = 'Visit counts are unavailable. Close and reopen to try again.';
    }
  }

  button.addEventListener('click', openVisits);
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => { requestNumber++; });
  void loadHeadline();
})();
