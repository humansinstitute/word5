package ai.otherstuff.word5

import java.time.LocalDate
import java.util.Locale

/** Exact UTC daily selection and duplicate-letter rules shared with the browser. */
class Rules(val answers: List<String>, words: List<String>) {
    val valid = (answers + words).map { it.uppercase(Locale.ROOT) }.toSet()
    fun answer(period: Long): String {
        var hash = 0
        (LocalDate.ofEpochDay(period).toString() + "_word5_daily").forEach { hash = hash * 31 + it.code }
        var t = (kotlin.math.abs(hash.toLong()) + 0x6d2b79f5L).toInt()
        t = (t xor (t ushr 15)) * (t or 1)
        t = t xor (t + (t xor (t ushr 7)) * (t or 61))
        val random = ((t xor (t ushr 14)).toLong() and 0xffffffffL).toDouble() / 4294967296.0
        return answers[(random * answers.size).toInt()].uppercase(Locale.ROOT)
    }
    fun validate(game: Game) {
        require(game.period in 0..100000 && game.guesses.size <= 6)
        if(game.outcome != null) {
            require(game.outcome in 1..7 && game.guesses.isEmpty())
            return
        }
        require(game.guesses.all { it.matches(Regex("[A-Z]{5}")) && it in valid })
        val target = answer(game.period)
        require(!game.guesses.dropLast(1).contains(target))
        if (game.hard) game.guesses.indices.forEach { i -> require(hardError(game.guesses.take(i), game.guesses[i], target) == null) }
    }
    fun completed(game: Game) = game.outcome != null || game.guesses.lastOrNull() == answer(game.period) || game.guesses.size == 6
    fun won(game: Game) = game.outcome?.let { it in 1..6 } ?: (game.guesses.lastOrNull() == answer(game.period))
    fun hardError(previous: List<String>, guess: String, target: String): String? {
        for (old in previous) {
            val marks = evaluate(old, target)
            old.indices.forEach { if (marks[it] == 2 && guess[it] != old[it]) return "${it + 1}${if(it==0)"st" else if(it==1)"nd" else if(it==2)"rd" else "th"} letter must be ${old[it]}" }
            old.toSet().forEach { letter ->
                val count = old.indices.count { old[it] == letter && marks[it] > 0 }
                if (guess.count { it == letter } < count) return "Guess must contain $letter"
            }
        }
        return null
    }
    companion object {
        fun period(now: Long = System.currentTimeMillis()) = now / 86400000L
        fun evaluate(guess: String, target: String): List<Int> {
            val left = target.toCharArray(); val marks = MutableList(5) { 0 }
            guess.indices.forEach { i -> if (guess[i] == left[i]) { marks[i] = 2; left[i] = '\u0000' } }
            guess.indices.forEach { i -> if (marks[i] == 0) { val at = left.indexOf(guess[i]); if (at >= 0) { marks[i] = 1; left[at] = '\u0000' } } }
            return marks
        }
    }
}
data class Game(val period: Long, val guesses: List<String> = emptyList(), val hard: Boolean = false, val outcome: Int? = null)
/** Exact pre-replay public correction seed, authenticated by native history/backup envelopes. */
data class CorrectionAnchor(val streak: Int, val maxStreak: Int, val lastPeriod: Long?, val covered: Set<Long> = emptySet())
data class Baseline(val through: Long, val played: Int, val won: Int, val streak: Int, val maxStreak: Int, val lastPeriod: Long?, val todayResult: String? = null, val covered: List<Long> = emptyList(), val distribution: List<Int> = List(6) { 0 }, val outcomes: Map<Long, Int> = emptyMap(), val correction: String? = null, val correctionCreated: Long? = null, val correctionAnchor: CorrectionAnchor? = null)
data class State(val games: Map<Long, Game> = emptyMap(), val hard: Boolean = false, val baseline: Baseline? = null, val hardUpdated: Long = 0, val correction: CorrectionOverlay? = null) {
    fun current() = games[Rules.period()] ?: Game(Rules.period(), hard = hard)
    fun with(game: Game) = copy(games = games + (game.period to game))
}
data class Stats(val played: Int, val won: Int, val streak: Int, val best: Int, val distribution: List<Int>)
fun statistics(state: State, rules: Rules, today: Long = Rules.period()): Stats {
    val base = state.baseline
    var played = base?.played ?: 0; var won = base?.won ?: 0
    var streak = base?.streak ?: 0; var best = base?.maxStreak ?: 0; var last = base?.lastPeriod
    val distribution = (base?.distribution ?: List(6) { 0 }).toMutableList()
    state.games.toSortedMap().values.filter { rules.completed(it) }.forEach { game ->
        if (base == null || game.period !in base.covered) {
            if (rules.won(game)) distribution[(game.outcome ?: game.guesses.size) - 1]++
            played++
            if (rules.won(game)) won++
            if(last == null || game.period > last) {
                streak = if(rules.won(game)) if(last == game.period - 1) streak + 1 else 1 else 0
                best = maxOf(best, streak); last = game.period
            }
        }
    }
    val timeline = state.games.values.filter { rules.completed(it) && (base == null || it.period !in base.covered) }.associate { it.period to (it.outcome ?: if(rules.won(it)) it.guesses.size else 7) } + (base?.outcomes ?: emptyMap())
    var run = 0; var previous: Long? = null
    timeline.toSortedMap().forEach { (period, result) ->
        run = if(result == 7) 0 else if(previous == period - 1) run + 1 else 1
        best = maxOf(best, run); if(period == last) streak = maxOf(streak, run)
        previous = period
    }
    if (last == null || last < today - 1) streak = 0
    val corrected = correctedStreaks(state, rules, today)
    return Stats(played, won, corrected?.first ?: streak, corrected?.second ?: best, distribution)
}
/** Server's completed record is immutable. Concurrent unfinished branches use longest then lexical order. */
fun merge(local: State, remote: State, rules: Rules): State {
    val games = remote.games.toMutableMap()
    local.games.forEach { (period, candidate) ->
        val old = games[period]
        games[period] = when {
            old == null -> candidate
            rules.completed(old) -> old
            rules.completed(candidate) -> candidate
            candidate.guesses.size > old.guesses.size -> candidate
            candidate.guesses.size < old.guesses.size -> old
            candidate.guesses.joinToString() < old.guesses.joinToString() -> candidate
            else -> old
        }
    }
    val preference = if (local.hardUpdated > remote.hardUpdated) local else remote
    val baseline = remote.baseline?.let { refreshBaseline(local.baseline, it) } ?: local.baseline
    val correction = Corrections.newest(local.correction, remote.correction)
    return State(games, preference.hard, baseline, preference.hardUpdated, correction)
}

/** Older completed games retain every outcome; current/recent and unfinished guesses remain exact. */
fun compact(state: State, rules: Rules, today: Long = Rules.period()): State = state.copy(games = state.games.mapValues { (_, g) ->
    if(g.period < today - 30 && rules.completed(g) && g.outcome == null) g.copy(guesses = emptyList(), outcome = if(rules.won(g)) g.guesses.size else 7) else g
})

/** Live web history can advance a backup baseline; an unexplained empty/older archive cannot reset it. */
fun refreshBaseline(old: Baseline?, fresh: Baseline): Baseline {
    if(old == null) return fresh
    val newerCorrection = fresh.correctionCreated != null && (old.correctionCreated == null || fresh.correctionCreated > old.correctionCreated || (fresh.correctionCreated == old.correctionCreated && fresh.correction.orEmpty() > old.correction.orEmpty()))
    val explicitCorrection = fresh.correction != null && fresh.correction != old.correction && newerCorrection && fresh.through >= old.through
    val advances = fresh.correction == old.correction && fresh.correctionCreated == old.correctionCreated && fresh.through >= old.through && fresh.played >= old.played && fresh.won >= old.won && fresh.covered.containsAll(old.covered)
    return if(explicitCorrection || advances) {
        // Older servers/saves may omit the seed; an advance of the same correction cannot erase it.
        if (advances && fresh.correctionAnchor == null) fresh.copy(correctionAnchor=old.correctionAnchor) else fresh
    } else old
}
