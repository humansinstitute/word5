package ai.otherstuff.word5

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class Backup(private val amber: NativeSigner, private val rules: Rules, private val serverKey: String = SERVER_KEY, private val transport: (suspend (String, JSONObject) -> JSONObject)? = null) {
    companion object { const val SERVER_KEY = "7ec3e0ce6b726060643b51abe40ab5bf871eb8dcbda4bfd9b4761bb8913b5c3f" }
    private suspend fun call(owner: String, op: String, body: JSONObject): JSONObject {
        val url = BuildConfig.API_BASE + "api/native-backup/$op"
        val request = amber.sign(Event(owner, System.currentTimeMillis() / 1000, 27235, listOf(listOf("u", url), listOf("method", "POST"), listOf("payload", sha256(body.toString().replace("\\/", "/"))), listOf("nonce", java.util.UUID.randomUUID().toString())), ""))
        val wire = JSONObject().put("body", body).put("auth", request.json())
        val response = transport?.invoke(url, wire) ?: withContext(Dispatchers.IO) {
            val connection = URL(url).openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "POST"; connection.connectTimeout = 15000; connection.readTimeout = 15000
                connection.instanceFollowRedirects = false; connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(wire.toString().toByteArray()) }
                check(connection.responseCode == 200) { "Backup server unavailable (${connection.responseCode}). Local game kept." }
                val bytes = connection.inputStream.use { it.readBounded(120000) }; require(bytes.size <= 120000)
                JSONObject(String(bytes, Charsets.UTF_8))
            } finally { connection.disconnect() }
        }
        val envelope = Event.parse(response.getJSONObject("event"))
        require(envelope.verified() && envelope.pubkey == serverKey && envelope.kind == 27235 &&
            kotlin.math.abs(envelope.created - System.currentTimeMillis() / 1000) <= 120 &&
            envelope.tags == listOf(listOf("request", request.id), listOf("p", owner), listOf("schema", "word5.backup-response.v1"))) { "Backup server signature invalid; local game kept" }
        return JSONObject(envelope.content)
    }
    data class Download(val event: Event?, val state: State, val stored: State? = null)
    suspend fun fetch(owner: String): Download {
        val response = call(owner, "read", JSONObject())
        val event = if (response.isNull("event")) null else Event.parse(response.getJSONObject("event"))
        val fresh = baseline(response.getJSONObject("history"), owner)
        val stored = if (event != null) {
            Codec.validateBackup(event, owner)
            Codec.decode(unpack(amber.decrypt(owner, event.content)), owner, rules)
        } else null
        val state = stored?.copy(baseline = refreshBaseline(stored.baseline, fresh)) ?: State(baseline = fresh)
        return Download(event, state, stored)
    }
    private fun baseline(h: JSONObject, owner: String): Baseline {
        require(h.getBoolean("ok") && h.getString("pubkey") == owner && h.longValue("periodId") == Rules.period())
        val stats = h.getJSONObject("stats")
        val b = Baseline(h.longValue("periodId"), stats.longValue("played").toInt(), stats.longValue("won").toInt(), stats.longValue("streak").toInt(), stats.longValue("maxStreak").toInt(), if(h.isNull("lastPeriodId")) null else h.longValue("lastPeriodId"), if(h.isNull("currentResult")) null else h.getString("currentResult"),
            h.getJSONArray("coveredPeriods").let { a -> (0 until a.length()).map { a.getLong(it) } },
            h.getJSONArray("distribution").let { a -> require(a.length() == 6); (0..5).map { a.getInt(it) } },
            h.getJSONArray("outcomes").let { a -> (0 until a.length()).associate { i -> a.getJSONArray(i).let { it.getLong(0) to it.getInt(1) } } }, if(h.isNull("correctionEventId")) null else h.getString("correctionEventId"), if(h.isNull("correctionCreatedAt")) null else h.longValue("correctionCreatedAt"), if(h.isNull("correctionAnchor")) null else Codec.correctionAnchor(h.getJSONObject("correctionAnchor")))
        // Apply the same strict baseline bounds as encrypted restores.
        Codec.decode(Codec.encode(State(baseline = b), owner), owner, rules)
        return b
    }
    suspend fun upload(owner: String, previous: Event?, state: State): Boolean {
        val text = pack(Codec.encode(compact(state, rules), owner)); require(text.toByteArray().size <= 60000) { "Backup is full; local history retained" }
        val ciphertext = amber.encrypt(owner, text)
        require(amber.decrypt(owner, ciphertext) == text) { "Amber encryption roundtrip failed" }
        val event = amber.sign(Event(owner, System.currentTimeMillis() / 1000, 30078, Codec.tags, ciphertext))
        val result = call(owner, "write", JSONObject().put("previous", previous?.id ?: JSONObject.NULL).put("event", event.json()))
        if (result.optBoolean("conflict")) return false
        val returned = Event.parse(result.getJSONObject("event")); Codec.validateBackup(returned, owner)
        require(returned == event) { "Server did not confirm the uploaded backup" }
        return true
    }
}

/** NIP-44 plaintext is bounded; compression preserves complete multi-year history. */
fun pack(text: String): String {
    val bytes = java.io.ByteArrayOutputStream()
    java.util.zip.GZIPOutputStream(bytes).use { it.write(text.toByteArray(Charsets.UTF_8)) }
    return "word5.gzip.v1:" + java.util.Base64.getEncoder().encodeToString(bytes.toByteArray())
}
fun unpack(text: String): String {
    require(text.startsWith("word5.gzip.v1:"))
    val bytes = java.util.Base64.getDecoder().decode(text.removePrefix("word5.gzip.v1:"))
    val result = java.util.zip.GZIPInputStream(bytes.inputStream()).use { it.readBounded(2000000) }
    require(result.size <= 2000000)
    return String(result, Charsets.UTF_8)
}

fun java.io.InputStream.readBounded(limit: Int): ByteArray {
    val out = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
    while (true) {
        val count = read(buffer); if (count < 0) break
        require(out.size() + count <= limit) { "Response exceeds safety limit" }
        out.write(buffer, 0, count)
    }
    return out.toByteArray()
}
