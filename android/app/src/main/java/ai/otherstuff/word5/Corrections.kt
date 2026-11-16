package ai.otherstuff.word5

import org.json.JSONObject

/** Private v1 overlay. The public event is evidence; the signed day covers all earlier completions.
 * covered identifies a completion on that boundary day, never an unfinished game. Raw games stay immutable. */
data class CorrectionOverlay(val event: Event, val covered: Set<Long>, val lastPeriod: Long?, val previousStreak: Int, val previousBest: Int, val version: Int = 1)

object Corrections {
    fun validateLowering(stats: Stats, current: Int, best: Int) {
        require(current >= 0 && best >= 0) { "Streaks must be non-negative whole numbers." }
        require(current <= stats.streak) { "Current streak can only be lowered from ${stats.streak}." }
        require(best <= stats.best) { "Best streak can only be lowered from ${stats.best}." }
        require(best >= current) { "Best streak cannot be lower than current streak." }
        require(current != stats.streak || best != stats.best) { "Enter a lower current or best streak before publishing a correction." }
    }

    /** Existing web kind-5555 contract; require unambiguous tags and matching JSON content. */
    fun validateEvent(event: Event, owner: String): Stats {
        require(event.pubkey == owner && owner.matches(Regex("[0-9a-f]{64}")) && event.verified() && event.kind == 5555 && event.created in 0..System.currentTimeMillis() / 1000 + 30) { "Stats correction signature or account invalid." }
        require(event.content.toByteArray().size <= 10000 && event.tags.size in 9..11 && event.tags.all { it.size == 2 }) { "Invalid stats correction tags." }
        val tags = event.tags.associate { it[0] to it[1] }
        val required = setOf("t", "game", "schema", "type", "streak", "maxStreak", "played", "won", "version")
        require(tags.size == event.tags.size && tags.keys.containsAll(required) && (tags.keys - required).all { it in setOf("previousStreak", "previousMaxStreak") }) { "Invalid stats correction tags." }
        require(tags["t"] == "word5" && tags["game"] == "word5" && tags["schema"] == "word5.stats.v1" && tags["type"] == "stats-correction" && tags["version"] == "1") { "Unsupported stats correction." }
        fun number(key: String): Int { val text = tags.getValue(key); require(text.matches(Regex("0|[1-9][0-9]{0,5}"))); return text.toInt().also { require(it in 0..100000) } }
        val p = number("played"); val w = number("won"); val s = number("streak"); val m = number("maxStreak")
        require(w <= p && s <= m && m <= w) { "Invalid correction counters." }
        val payload = JSONObject(event.content); payload.exact("game", "type", "stats", "version")
        require(payload.get("game") == "word5" && payload.get("type") == "stats-correction" && payload.longValue("version") == 1L)
        val stats = payload.getJSONObject("stats"); stats.exact("played", "won", "streak", "maxStreak")
        mapOf("played" to p, "won" to w, "streak" to s, "maxStreak" to m).forEach { (key, value) -> require(stats.longValue(key) == value.toLong()) { "Correction content disagrees with tags." } }
        require(tags.containsKey("previousStreak") == tags.containsKey("previousMaxStreak"))
        if (tags.containsKey("previousStreak")) {
            val previous = Stats(p, w, number("previousStreak"), number("previousMaxStreak"), emptyList())
            require(previous.streak <= previous.best && previous.best <= w)
            validateLowering(previous, s, m)
        }
        return Stats(p, w, s, m, emptyList())
    }

    fun validateOverlay(overlay: CorrectionOverlay, owner: String): Stats {
        val stats = validateEvent(overlay.event, owner)
        val day = overlay.event.created / 86400
        require(overlay.version == 1 && day <= Rules.period() && overlay.covered.size <= 1 && overlay.covered.all { it == day }) { "Invalid correction coverage." }
        require(overlay.lastPeriod == null || overlay.lastPeriod in 0..day)
        require(overlay.covered.all { overlay.lastPeriod != null && it <= overlay.lastPeriod })
        require((day in overlay.covered) == (overlay.lastPeriod == day))
        require(stats.streak == 0 || overlay.lastPeriod != null && overlay.lastPeriod >= day - 1) { "Invalid correction streak anchor." }
        require(overlay.previousStreak in 0..stats.won && overlay.previousBest in overlay.previousStreak..stats.won)
        validateLowering(Stats(stats.played, stats.won, overlay.previousStreak, overlay.previousBest, emptyList()), stats.streak, stats.best)
        val tags = overlay.event.tags.associate { it[0] to it[1] }
        if ("previousStreak" in tags) require(tags["previousStreak"] == overlay.previousStreak.toString() && tags["previousMaxStreak"] == overlay.previousBest.toString())
        return stats
    }

    fun validateAnchor(base: Baseline) {
        val a=base.correctionAnchor ?: return
        require(base.correction?.matches(Regex("[0-9a-f]{64}")) == true && base.correctionCreated != null) { "Correction seed has no correction identity." }
        val day=base.correctionCreated / 86400
        require(day in 0..base.through && a.streak in 0..a.maxStreak && a.maxStreak <= base.won) { "Invalid correction seed counters." }
        require(a.lastPeriod == null || a.lastPeriod in 0..day)
        require(a.streak == 0 || a.lastPeriod != null)
        require(a.covered.size <= 1 && a.covered.all { it == day && a.lastPeriod == day && it in base.covered }) { "Invalid correction seed coverage." }
    }

    fun applyCorrection(state: State, event: Event, owner: String, rules: Rules): State {
        val corrected = validateEvent(event, owner)
        require(event.created / 86400 == Rules.period()) { "Stats changed day; review and sign a new correction." }
        val existing = statistics(state, rules)
        validateLowering(existing, corrected.streak, corrected.best)
        require(corrected.played == existing.played && corrected.won == existing.won) { "Stats changed; review and sign a new correction." }
        val old = state.correction?.event
        require(old == null || newer(event.created, event.id, old.created, old.id)) { "Stats correction is older than the saved correction." }
        val baseline = state.baseline
        require(baseline?.correctionCreated == null || newer(event.created, event.id, baseline.correctionCreated, baseline.correction.orEmpty())) { "Stats correction is older than imported history." }
        val completed = state.games.values.filter { rules.completed(it) }.map { it.period }
        val covered = (completed + (baseline?.covered ?: emptyList()) + listOfNotNull(baseline?.lastPeriod)).toSet()
        val overlay = CorrectionOverlay(event, covered.filter { it == event.created / 86400 }.toSet(), covered.maxOrNull(), existing.streak, existing.best)
        validateOverlay(overlay, owner)
        return state.copy(correction = overlay)
    }

    internal fun newer(time: Long, id: String, otherTime: Long, otherId: String) = time > otherTime || time == otherTime && id > otherId
    internal fun newest(a: CorrectionOverlay?, b: CorrectionOverlay?): CorrectionOverlay? {
        // Codec binds overlays to the backup owner; pure merges also reject mixed accounts.
        a?.let { validateOverlay(it, it.event.pubkey) }; b?.let { validateOverlay(it, it.event.pubkey) }
        require(a == null || b == null || a.event.pubkey == b.event.pubkey) { "Cannot merge corrections from different accounts." }
        if (a == null) return b
        if (b == null) return a
        if (a.event.id == b.event.id) {
            // BIP340 auxiliary randomness permits different valid signatures for one payload/ID.
            // Each input has already passed metadata validation and backup account authentication.
            require(a.event.samePayload(b.event)) { "Conflicting payload for the same correction." }
            val evidence = listOf(a,b).minWith(compareBy<CorrectionOverlay> { it.previousStreak }
                .thenBy { it.previousBest }.thenBy { it.event.sig })
            return evidence.copy(covered = a.covered + b.covered,
                lastPeriod = listOfNotNull(a.lastPeriod,b.lastPeriod).maxOrNull())
                .also { validateOverlay(it,it.event.pubkey) }
        }
        return if (newer(a.event.created, a.event.id, b.event.created, b.event.id)) a else b
    }
}

/** Only streaks are overlaid: totals/distribution always come from immutable outcome accounting. */
internal fun correctedStreaks(state: State, rules: Rules, today: Long): Pair<Int, Int>? {
    val overlay = state.correction
    val base = state.baseline
    val useOverlay = overlay != null && (base?.correctionCreated == null || !Corrections.newer(base.correctionCreated, base.correction.orEmpty(), overlay.event.created, overlay.event.id))
    if (!useOverlay && base?.correction == null) return null
    var current: Int; var best: Int; var last: Long?
    val after: Map<Long, Int>
    if (useOverlay) {
        val o = overlay; val stats = Corrections.validateOverlay(o, o.event.pubkey)
        current = stats.streak; best = stats.best; last = o.lastPeriod
        val timeline = state.games.values.filter { rules.completed(it) }.associate { it.period to (it.outcome ?: if (rules.won(it)) it.guesses.size else 7) } + (base?.outcomes ?: emptyMap())
        after = timeline.filterKeys { it >= o.event.created / 86400 && it !in o.covered }
    } else if (base!!.correctionAnchor != null) {
        Corrections.validateAnchor(base)
        val a=base.correctionAnchor
        current=a.streak; best=a.maxStreak; last=a.lastPeriod
        val timeline=state.games.values.filter { rules.completed(it) }.associate { it.period to (it.outcome ?: if(rules.won(it)) it.guesses.size else 7) } + base.outcomes
        after=timeline.filterKeys { it >= base.correctionCreated!! / 86400 && it !in a.covered }
    } else {
        // Legacy summaries have no original seed. Retain their authenticated aggregate;
        // never reconstruct pre-correction truth or infer a zero seed from current counters.
        current = base.streak; best = base.maxStreak; last = base.lastPeriod
        after = state.games.values.filter { rules.completed(it) && it.period !in base.covered && (last == null || it.period > last) }.associate { it.period to (it.outcome ?: if (rules.won(it)) it.guesses.size else 7) }
    }
    after.toSortedMap().forEach { (period, result) ->
        current = if (result == 7) 0 else if (last == period - 1) current + 1 else 1
        best = maxOf(best, current); last = period
    }
    if (last == null || last < today - 1) current = 0
    return current to best
}
