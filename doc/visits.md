# Word5 visit counts

Opening the game page records a visit. The browser sends its existing Nostr session public key to Word5's server; the server stores only an HMAC of that key and the current puzzle period. The HMAC key is a private file beside the SQLite database (`*.visitor-key`). Keep that file with the database across app restarts. No IP address, user agent, raw public key, or browser cookie is stored by this tracker.

`game_visitors` has one row per session and puzzle. `game_day_visitors` has one row per session and Perth calendar day. `game_visit_events` records game-page loads with a Perth calendar date and hour, so repeat visits and busy hours can be counted. The hashes are scoped to their puzzle or Perth day. A browser with a fresh session counts as a new visitor, so the number is an estimate of people. Social-page views do not count as play visits.

The puzzle rolls over at 00:00 UTC (08:00 Australia/Perth). Counts shown on Social and posted to Nostr refer to the previous completed **game number**, not a Perth calendar day. The response also includes the full `periodId` and UTC `puzzleDate` to disambiguate game numbers that repeat after 1,000 periods. Perth date/hour fields are retained for separate calendar-day reports.

`GET /api/visits/last-completed-game` supplies the Social headline. The older `/api/visits/yesterday` route remains an alias for existing clients.

If the existing Word5 account signer (`WORD5_NSEC`) and relays are configured, the server posts the previous completed puzzle's count as a Nostr note after rollover. It also posts when the current puzzle first reaches 100, 256, 512, 1,000, or later configured player thresholds. Signed events and publish results are stored in `game_visit_announcements` and `game_visit_milestones`; failed delivery is retried every five minutes with the same event ID. Empty puzzles are not announced. These posts contain only aggregate counts; no visitor identifier leaves the server.

Example SQLite reports:

```sql
-- Unique sessions for each completed puzzle.
SELECT period_id, period_id % 1000 AS game_number,
       puzzle_date AS game_date_utc, COUNT(*) AS people
FROM game_visitors
GROUP BY period_id, puzzle_date
ORDER BY period_id DESC;

-- Perth calendar days and hours with the most game-page loads.
SELECT perth_date, perth_hour, COUNT(*) AS visits,
       COUNT(DISTINCT visitor_hash) AS unique_sessions
FROM game_visit_events
GROUP BY perth_date, perth_hour
ORDER BY visits DESC;

-- Unique sessions per Perth calendar day.
SELECT perth_date, COUNT(*) AS people
FROM game_day_visitors
GROUP BY perth_date
ORDER BY perth_date DESC;
```
