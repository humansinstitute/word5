package ai.otherstuff.word5

import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Public operations are separate from the encrypted-save transport. No implicit publication. */
object PublicNostr {
    val relays=listOf("wss://relay.damus.io","wss://nos.lol","wss://relay.snort.social")
    private val client=OkHttpClient.Builder().connectTimeout(12,TimeUnit.SECONDS).readTimeout(20,TimeUnit.SECONDS).build()
    suspend fun get(path: String): JSONObject = withContext(Dispatchers.IO) {
        client.newCall(Request.Builder().url(BuildConfig.API_BASE+path).build()).execute().use { r ->
            check(r.isSuccessful) { "Word5 unavailable (${r.code}); retry" }; JSONObject(String(r.body.byteStream().use { it.readBounded(4000000) },Charsets.UTF_8))
        }
    }
    suspend fun api(path: String, event: Event): JSONObject = withContext(Dispatchers.IO) {
        client.newCall(Request.Builder().url(BuildConfig.API_BASE+path).post(JSONObject().put("event",event.json()).toString().toRequestBody("application/json".toMediaType())).build()).execute().use { r ->
            val data=JSONObject(String(r.body.byteStream().use { it.readBounded(4000000) },Charsets.UTF_8)); check(r.isSuccessful && data.optBoolean("ok")) { data.optString("error","Word5 request failed") };data
        }
    }
    private suspend fun queryRelay(url: String, filter: JSONObject): List<Event> {
        val result=CompletableDeferred<List<Event>>();val events=mutableListOf<Event>();val sub=UUID.randomUUID().toString()
        val socket=client.newWebSocket(Request.Builder().url(url).build(),object:WebSocketListener() {
            override fun onOpen(webSocket:WebSocket,response:Response) { webSocket.send(array(listOf("REQ",sub,filter)).toString()) }
            override fun onMessage(webSocket:WebSocket,text:String) {
                if(text.length>150000)return
                runCatching {
                    val msg=JSONArray(text)
                    if(msg.optString(1)!=sub)return
                    when(msg.optString(0)) {
                        "EVENT" -> { val e=Event.parse(msg.getJSONObject(2));if(e.verified() && matches(e,filter)) synchronized(events) { if(events.size<2000)events.add(e) } }
                        "EOSE" -> result.complete(synchronized(events){events.toList()})
                        "CLOSED" -> result.completeExceptionally(IllegalStateException(msg.optString(2,"Relay query refused")))
                    }
                }
            }
            override fun onFailure(webSocket:WebSocket,t:Throwable,response:Response?) { result.completeExceptionally(t) }
        })
        return try { withTimeout(14000) { result.await() } } finally { socket.cancel() }
    }
    private fun matches(e:Event,f:JSONObject):Boolean {
        fun values(key:String)=f.optJSONArray(key)?.let { a->(0 until a.length()).map { a.get(it).toString() } }
        if(values("authors")?.none { e.pubkey.startsWith(it) }==true)return false
        if(values("kinds")?.contains(e.kind.toString())==false)return false
        if(e.created<f.optLong("since",0) || e.created>f.optLong("until",Long.MAX_VALUE))return false
        return f.keys().asSequence().filter { it.startsWith("#") }.all { key -> e.tags.any { it.size>1 && it[0]==key.drop(1) && it[1] in values(key).orEmpty() } }
    }
    suspend fun query(filter:JSONObject):List<Event> = supervisorScope {
        val responses=relays.map { async { runCatching { queryRelay(it,filter) } } }.awaitAll()
        check(responses.any { it.isSuccess }) { "Relays unavailable; retry" }
        responses.flatMap { it.getOrDefault(emptyList()) }.distinctBy { it.id }.sortedByDescending { it.created }
    }
    suspend fun publish(event:Event) = supervisorScope {
        currentCoroutineContext().ensureActive(); require(isPublicRelayPayload(event)) { "Private event cannot be sent to a relay" }; require(event.verified())
        val outcomes=relays.map { url -> async {
            val result=CompletableDeferred<Boolean>()
            val socket=client.newWebSocket(Request.Builder().url(url).build(),object:WebSocketListener() {
                override fun onOpen(webSocket:WebSocket,response:Response) { webSocket.send(array(listOf("EVENT",event.json())).toString()) }
                override fun onMessage(webSocket:WebSocket,text:String) { runCatching { val m=JSONArray(text);if(m.optString(0)=="OK" && m.optString(1)==event.id)result.complete(m.optBoolean(2)) } }
                override fun onFailure(webSocket:WebSocket,t:Throwable,response:Response?) { result.complete(false) }
            })
            try { withTimeoutOrNull(15000) { result.await() } ?: false } finally { socket.cancel() }
        } }.awaitAll()
        check(outcomes.any { it }) { "No relay confirmed publication; retry" }
    }
    suspend fun profile(owner:String):JSONObject = query(JSONObject().put("kinds",array(listOf(0))).put("authors",array(listOf(owner))).put("limit",1)).firstOrNull()?.let { runCatching { JSONObject(it.content) }.getOrNull() } ?: JSONObject()
    suspend fun contacts(owner:String):Event? = query(JSONObject().put("kinds",array(listOf(3))).put("authors",array(listOf(owner))).put("limit",1)).firstOrNull()
    suspend fun upload(bytes:ByteArray,mime:String,owner:String,signer:NativeSigner,message:String="Upload WORD5 profile image"):String {
        require(bytes.size<=10000000) { "Choose an image smaller than 10 MB" }
        val hash=java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)}
        val event=signer.sign(Event(owner,System.currentTimeMillis()/1000,24242,listOf(listOf("t","upload"),listOf("x",hash),listOf("server","https://blossom.primal.net/"),listOf("expiration",(System.currentTimeMillis()/1000+3600).toString())),message))
        return withContext(Dispatchers.IO) {
            val auth=android.util.Base64.encodeToString(event.json().toString().toByteArray(),android.util.Base64.NO_WRAP)
            client.newCall(Request.Builder().url("https://blossom.primal.net/upload").header("Authorization","Nostr $auth").header("X-SHA-256",hash).put(bytes.toRequestBody(mime.toMediaType())).build()).execute().use { r-> check(r.isSuccessful){"Image upload failed (${r.code})"};JSONObject(String(r.body.byteStream().use { it.readBounded(100000) },Charsets.UTF_8)).let { descriptor -> require(!descriptor.has("sha256") || descriptor.getString("sha256")==hash) { "Upload hash mismatch" };descriptor.getString("url").also { require(it.startsWith("https://")) { "Upload returned insecure URL" } } } }
        }
    }
}
fun Event.tag(name:String)=tags.firstOrNull { it.size>1 && it[0]==name }?.get(1).orEmpty()
fun JSONArray.objects()=(0 until length()).map { getJSONObject(it) }

/** Bound each history window and reject silent truncation, as on the web. */
suspend fun PublicNostr.history(authors:List<String>,since:Long,until:Long):List<JSONObject> {
    if(authors.isEmpty())return emptyList()
    require(authors.all{it.matches(Regex("[0-9a-f]{64}"))})
    val rows=mutableListOf<JSONObject>()
    for(chunk in authors.distinct().chunked(20)) {
        var start=since
        while(start<=until) {
            val end=minOf(until,start+90*86400)
            val batch=get("api/social-history?authors=${chunk.joinToString(",")}&since=$start&until=$end&limit=2000").optJSONArray("rows")?.objects().orEmpty()
            check(batch.size<2000){"History reached safety limit; narrow the period"};rows+=batch;start=end+1
        }
    }
    return scoreHistory(rows)
}
