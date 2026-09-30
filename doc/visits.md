# Word5 visit counts

Opening the game page records a visit. The browser sends its existing Nostr session public key to Word5's server; the server stores only an HMAC of that key and the current puzzle period. The HMAC key is a private file beside the SQLite database (`*.visitor-key`). Keep that file with the database across app restarts. No IP address, user agent, raw public key, or browser cookie is stored by this tracker.

`game_visitors` has one row per session and puzzle. `game_visit_events` records game-page loads with a Perth calendar date and hour, so repeat visits and busy hours can be counted. Both tables use the puzzle-specific hash. A browser with a fresh session counts as a new visitor, so the number is an estimate of people. Social-page views do not count as play visits.

The puzzle rolls over at 00:00 UTC (08:00 Australia/Perth). The Social headline reads the unique visitor count for the previous completed puzzle. The Perth date/hour fields let calendar-day reports follow Perth time even though the puzzle date follows the game rotation.

Example SQLite reports:

```sql
-- Unique sessions for each completed puzzle.
SELECT puzzle_date, COUNT(*) AS people
FROM game_visitors
GROUP BY period_id, puzzle_date
ORDER BY period_id DESC;

-- Perth calendar days and hours with the most game-page loads.
SELECT perth_date, perth_hour, COUNT(*) AS visits,
       COUNT(DISTINCT visitor_hash) AS unique_sessions
FROM game_visit_events
GROUP BY perth_date, perth_hour
ORDER BY visits DESC;
```
