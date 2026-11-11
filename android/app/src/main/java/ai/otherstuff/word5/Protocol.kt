package ai.otherstuff.word5

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import fr.acinq.secp256k1.Secp256k1

fun sha256(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
fun unhex(s: String): ByteArray { require(s.length % 2 == 0 && s.matches(Regex("[0-9a-f]+"))); return s.chunked(2).map { it.toInt(16).toByte() }.toByteArray() }
fun array(values: List<*>) = JSONArray(values)
fun JSONObject.exact(vararg fields: String) { require(keys().asSequence().toSet() == fields.toSet()) { "Unsupported backup fields" } }
fun JSONObject.longValue(name: String): Long { val v = get(name); require(v is Number && v.toDouble() == v.toLong().toDouble()); return v.toLong() }
fun JSONObject.bool(name: String): Boolean { require(get(name) is Boolean); return getBoolean(name) }
data class Event(val pubkey: String, val created: Long, val kind: Int, val tags: List<List<String>>, val content: String, val id: String = "", val sig: String = "") {
    fun hash() = sha256(array(listOf(0, pubkey, created, kind, tags.map { array(it) }, content)).toString().replace("\\/", "/"))
    fun json(): JSONObject = JSONObject().put("pubkey", pubkey).put("created_at", created).put("kind", kind).put("tags", array(tags.map { array(it) })).put("content", content).put("id", id.ifEmpty { hash() }).put("sig", sig)
    fun verified(): Boolean = runCatching { pubkey.length == 64 && id == hash() && sig.length == 128 && Secp256k1.verifySchnorr(unhex(sig), unhex(id), unhex(pubkey)) }.getOrDefault(false)
    fun samePayload(other: Event) = pubkey == other.pubkey && created == other.created && kind == other.kind && tags == other.tags && content == other.content
    companion object {
        fun parse(j: JSONObject): Event {
            j.exact("pubkey", "created_at", "kind", "tags", "content", "id", "sig")
            val tags = j.getJSONArray("tags")
            return Event(j.getString("pubkey"), j.longValue("created_at"), j.longValue("kind").toInt(), (0 until tags.length()).map { i -> val a = tags.getJSONArray(i); (0 until a.length()).map { a.getString(it) } }, j.getString("content"), j.getString("id"), j.getString("sig"))
        }
    }
}
object Codec {
    const val SCHEMA = "word5.native-backup.v1"
    const val OUTER = "word5.encrypted-backup.v1"
    val tags = listOf(listOf("d", "word5:backup:v1"), listOf("schema", OUTER))
    fun encode(state: State, owner: String): String {
        val baseline = state.baseline?.let { JSONObject().put("through", it.through).put("played", it.played).put("won", it.won).put("streak", it.streak).put("maxStreak", it.maxStreak).put("lastPeriod", it.lastPeriod ?: JSONObject.NULL).put("todayResult", it.todayResult ?: JSONObject.NULL).put("covered", array(it.covered)).put("distribution", array(it.distribution)).put("outcomes", array(it.outcomes.toSortedMap().map { (p,r) -> array(listOf(p,r)) })).put("correction", it.correction ?: JSONObject.NULL).put("correctionCreated", it.correctionCreated ?: JSONObject.NULL) }
        return JSONObject().put("schema", SCHEMA).put("owner", owner).put("hardMode", state.hard).put("hardUpdated", state.hardUpdated).put("baseline", baseline ?: JSONObject.NULL).put("games", array(state.games.toSortedMap().values.map { array(listOf(it.period, it.hard, it.outcome ?: array(it.guesses))) })).toString()
    }
    fun decode(text: String, owner: String, rules: Rules): State {
        require(text.toByteArray().size <= 2000000)
        val j = JSONObject(text); j.exact("schema", "owner", "hardMode", "hardUpdated", "baseline", "games")
        require(j.getString("schema") == SCHEMA && j.getString("owner") == owner)
        val list = j.getJSONArray("games"); require(list.length() <= 10000)
        val games = mutableMapOf<Long, Game>()
        repeat(list.length()) { i ->
            val g = list.getJSONArray(i); require(g.length() == 3 && g.get(0) is Number && g.get(1) is Boolean)
            val period = (g.get(0) as Number).toLong(); require((g.get(0) as Number).toDouble() == period.toDouble())
            val value = g.get(2)
            val game = if(value is Number) {
                require(value.toDouble() == value.toInt().toDouble())
                Game(period, hard = g.getBoolean(1), outcome = value.toInt())
            } else {
                val guesses = g.getJSONArray(2); require(guesses.length() <= 6)
                Game(period, (0 until guesses.length()).map { guesses.getString(it) }, g.getBoolean(1))
            }
            require(game.period <= Rules.period() && !games.containsKey(game.period)); rules.validate(game); games[game.period] = game
        }
        val baseline = if (j.isNull("baseline")) null else {
            val b = j.getJSONObject("baseline"); b.exact("through", "played", "won", "streak", "maxStreak", "lastPeriod", "todayResult", "covered", "distribution", "outcomes", "correction", "correctionCreated")
            val through = b.longValue("through"); val p = b.longValue("played"); val w = b.longValue("won"); val s = b.longValue("streak"); val m = b.longValue("maxStreak")
            val last = if (b.isNull("lastPeriod")) null else b.longValue("lastPeriod")
            val result = if (b.isNull("todayResult")) null else b.getString("todayResult")
            require(through in 0..Rules.period() && p in 0..100000 && w in 0..p && s in 0..w && m in s..w && (last == null || last in 0..through) && (result == null || result in listOf("1","2","3","4","5","6","X")))
            val periods = b.getJSONArray("covered"); require(periods.length() <= 10000)
            val covered = (0 until periods.length()).map { i -> val n = periods.get(i); require(n is Number && n.toDouble() == n.toLong().toDouble() && n.toLong() in 0..through); n.toLong() }
            require(covered.size == covered.toSet().size)
            val counts = b.getJSONArray("distribution"); require(counts.length() == 6)
            val distribution = (0..5).map { i -> val n = counts.get(i); require(n is Number && n.toDouble() == n.toLong().toDouble() && n.toLong() in 0..100000); n.toInt() }
            val records = b.getJSONArray("outcomes"); require(records.length() <= 10000)
            val outcomes = mutableMapOf<Long, Int>()
            repeat(records.length()) { i -> val a = records.getJSONArray(i); require(a.length() == 2 && a.get(0) is Number && a.get(1) is Number)
                val day = (a.get(0) as Number).toLong(); val result = (a.get(1) as Number).toInt()
                require((a.get(0) as Number).toDouble() == day.toDouble() && (a.get(1) as Number).toDouble() == result.toDouble() && day in covered && result in 1..7 && !outcomes.containsKey(day)); outcomes[day] = result }
            val correction = if(b.isNull("correction")) null else b.getString("correction").also { require(it.matches(Regex("[0-9a-f]{64}"))) }
            val correctionCreated = if(b.isNull("correctionCreated")) null else b.longValue("correctionCreated")
            require((correction == null) == (correctionCreated == null) && (correctionCreated == null || correctionCreated in 0..System.currentTimeMillis() / 1000 + 30))
            Baseline(through, p.toInt(), w.toInt(), s.toInt(), m.toInt(), last, result, covered, distribution, outcomes, correction, correctionCreated)
        }
        val updated = j.longValue("hardUpdated"); require(updated in 0..System.currentTimeMillis() + 30000)
        return State(games, j.bool("hardMode"), baseline, updated)
    }
    fun validateBackup(event: Event, owner: String) {
        require(event.verified() && event.pubkey == owner && event.kind == 30078 && event.tags == tags && event.created <= System.currentTimeMillis() / 1000 + 30 && event.content.length in 100..90000) { "Backup signature or envelope invalid" }
    }
}
