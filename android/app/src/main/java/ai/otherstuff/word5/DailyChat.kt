package ai.otherstuff.word5

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.SecureRandom
import java.time.LocalDate
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

const val CHAT_SCHEMA = "word5.chat.v1"
/** Ephemeral room material: never put this in preferences, backups, logs or relays. */
class ChatRoom(val owner: String, val period: Long, val date: String, val word: String, val expiresAt: Long, internal val key: ByteArray) {
    private var discarded=false
    fun active(account: String, now: Long) = !discarded && owner == account && period == Rules.period(now) && now < expiresAt
    fun discard() { discarded=true;key.fill(0) }
}
data class ChatMessage(val id: String, val pubkey: String, val createdAt: Long, val text: String)
data class ChatMember(val name: String = "", val picture: String = "", val result: String = "")
fun chatMember(profile: JSONObject?, history: JSONObject?, pubkey: String, period: Long): ChatMember {
    fun text(data: JSONObject?, key: String) = (data?.opt(key) as? String).orEmpty()
    val name = (text(profile,"display_name").trim().ifEmpty { text(profile,"name").trim() }).take(64)
    val photo = text(profile,"picture").takeIf { value -> runCatching { java.net.URI(value).let { it.scheme == "https" && it.host != null && it.userInfo == null } }.getOrDefault(false) }.orEmpty()
    val result = text(history,"currentResult").takeIf { history?.optBoolean("ok") == true && text(history,"pubkey") == pubkey && history.optLong("periodId",-1) == period && history.optBoolean("completed") && it.matches(Regex("[1-6X]")) }.orEmpty()
    return ChatMember(name,photo,result)
}
fun interface ChatApi { suspend fun post(path: String, event: Event): JSONObject }
/** Matches the existing production browser contract, without any publication path. */
class DailyChatClient(private val signer: NativeSigner, private val api: ChatApi = ChatApi { path,event -> PublicNostr.api(path,event) }, private val clock: () -> Long = System::currentTimeMillis) {
    private val random = SecureRandom()
    private fun nonce() = ByteArray(16).also(random::nextBytes).joinToString("") { "%02x".format(it) }
    private fun draft(owner: String, body: JSONObject) = Event(owner,clock()/1000,30078,listOf(listOf("schema",CHAT_SCHEMA)),body.toString())
    private suspend fun signed(event: Event): Event {
        val signed=signer.sign(event)
        require(signed.samePayload(event) && signed.verified()) { "Amber returned a different chat request" }
        check(kotlin.math.abs(clock()-signed.created*1000) <= 60000) { "Chat approval expired. Retry to approve a fresh request." }
        currentCoroutineContext().ensureActive()
        return signed
    }
    private suspend fun post(path: String, event: Event): JSONObject {
        val epoch=cacheEpoch;val approved=signed(event);check(epoch==cacheEpoch){"Chat account changed"}
        return api.post(path,approved).also { check(epoch==cacheEpoch){"Chat account changed"} }.also { check(it.optBoolean("ok")) { it.optString("error","Chat unavailable; retry") } }
    }
    private suspend fun request(owner: String, action: String, fields: JSONObject = JSONObject()): JSONObject {
        val body=JSONObject().put("action",action).put("nonce",nonce())
        fields.keys().forEach { body.put(it,fields.get(it)) }
        return post("api/chat/$action",draft(owner,body))
    }
    suspend fun open(owner: String): ChatRoom? {
        require(owner.matches(Regex("[0-9a-f]{64}")))
        val response=request(owner,"rooms")
        val rooms=response.getJSONArray("rooms"); require(rooms.length()<=1) { "Unexpected chat room list" }
        if(rooms.length()==0)return null
        val room=rooms.getJSONObject(0);val period=room.longValue("period");val expires=room.longValue("expiresAt")
        require(period==Rules.period(clock()) && expires==(period+1)*86400000L && clock()<expires && room.getString("date")==LocalDate.ofEpochDay(period).toString()) { "Daily chat expired. Finish the new puzzle first." }
        val word=room.getString("word");require(word.matches(Regex("[A-Z]{5}")))
        val key=Base64.getDecoder().decode(room.getString("key"));require(key.size==32) { "Invalid chat key" }
        return ChatRoom(owner,period,room.getString("date"),word,expires,key)
    }
    /** Called only after a separate informed confirmation; never from backup or polling. */
    suspend fun validateCompletion(owner: String, game: Game, rules: Rules) {
        require(game.period==Rules.period(clock()) && rules.completed(game)) { "Finish today's puzzle first" }
        // An archived outcome cannot manufacture the missing original ordered guesses.
        require(game.guesses.isNotEmpty()) { "This restored result has no guesses. Use Check existing chat; a new score cannot be invented." }
        post("api/completion",completionDraft(game,rules,owner,clock()/1000))
        check(game.period==Rules.period(clock())) { "The new word has started. Finish it to unlock chat." }
    }
    private fun requireActive(owner: String, room: ChatRoom) { check(room.active(owner,clock())) { "Daily chat expired or account changed" } }
    private data class PendingSend(val owner: String, val period: Long, val textHash: String, val event: Event)
    private var pendingSend: PendingSend? = null
    private var cacheEpoch=0
    private var cacheScope=""
    private var cursor:String?=null
    private val messageCache=linkedMapOf<String,ChatMessage>()
    fun reset() { cacheEpoch++;pendingSend=null;cacheScope="";cursor=null;messageCache.clear() }
    private fun scope(owner:String,room:ChatRoom) {
        val next="$owner:${room.period}:${sha256(Base64.getEncoder().encodeToString(room.key))}"
        if(cacheScope!=next) { cacheEpoch++;pendingSend=null;cacheScope=next;cursor=null;messageCache.clear() }
    }
    suspend fun send(owner: String, room: ChatRoom, text: String): String {
        requireActive(owner,room);scope(owner,room)
        val epoch=cacheEpoch
        val hash=sha256(text.trim())
        val previous=pendingSend?.takeIf { it.owner==owner && it.period==room.period && it.textHash==hash }
        if(previous!=null) {
            // A lost HTTP acknowledgement must not create a second message.
            if(read(owner,room).any { it.id==previous.event.id }) { pendingSend=null; return previous.event.id }
            check(kotlin.math.abs(clock()-previous.event.created*1000)<=60000) { "Previous send could not be confirmed. Refresh the room, then edit the draft before sending again." }
        }
        val event=previous?.event ?: run {
            val messageNonce=nonce();val payload=encryptChat(text,room,owner,messageNonce,random)
            val body=payload.put("action","send").put("period",room.period).put("nonce",messageNonce)
            signed(draft(owner,body))
        }
        requireActive(owner,room)
        check(epoch==cacheEpoch){"Chat account changed"}
        pendingSend=PendingSend(owner,room.period,hash,event)
        val response=try { api.post("api/chat/send",event) }
        catch(e:ApiRejection) { if(e.definitive && pendingSend?.event?.id==event.id)pendingSend=null;throw e }
        if(!response.optBoolean("ok")) { if(pendingSend?.event?.id==event.id)pendingSend=null;error(response.optString("error","Chat unavailable; retry")) }
        requireActive(owner,room)
        check(epoch==cacheEpoch){"Chat account changed"}
        val id=response.getString("id");require(id==event.id)
        if(pendingSend?.event?.id==event.id)pendingSend=null
        return id
    }
    suspend fun read(owner: String, room: ChatRoom): List<ChatMessage> {
        requireActive(owner,room);scope(owner,room)
        val epoch=cacheEpoch
        val fields=JSONObject().put("period",room.period);cursor?.let{fields.put("after",it)}
        val response=request(owner,"read",fields)
        requireActive(owner,room)
        val rows=response.getJSONArray("messages");require(rows.length()<=200)
        val delta=response.has("cursor") && response.has("reset")
        val nextCursor=if(delta && !response.isNull("cursor"))response.getString("cursor")else null
        require(nextCursor==null || nextCursor.matches(Regex("[0-9a-f]{64}"))) { "Invalid chat cursor" }
        val reset=!delta || response.bool("reset")
        val known=messageCache.toMap()
        val decoded=withContext(Dispatchers.Default) { (0 until rows.length()).mapNotNull { index ->
            try {
                val row=rows.getJSONObject(index)
                known[row.optString("id")] ?: decryptChat(Event.parse(row),room)
            }
            catch(e: CancellationException) { throw e }
            catch(_: Exception) { null }
        }.distinctBy { it.id } }
        requireActive(owner,room)
        check(epoch==cacheEpoch){"Chat account changed"}
        if(reset)messageCache.clear()
        decoded.forEach{messageCache[it.id]=it}
        while(messageCache.size>200)messageCache.remove(messageCache.keys.first())
        cursor=if(delta)nextCursor else decoded.lastOrNull()?.id
        return messageCache.values.toList()
    }

}
private fun chatAad(period: Long, owner: String, nonce: String) = "word5.chat.v1:$period:$owner:$nonce".toByteArray(Charsets.UTF_8)
fun encryptChat(text: String, room: ChatRoom, owner: String, nonce: String, random: SecureRandom = SecureRandom()): JSONObject {
    require(nonce.matches(Regex("[0-9a-f]{32}")))
    val bytes=text.trim().toByteArray(Charsets.UTF_8);require(bytes.size in 1..2000) { "Use 1–2000 UTF-8 bytes of text" }
    val iv=ByteArray(12).also(random::nextBytes)
    val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,SecretKeySpec(room.key,"AES"),GCMParameterSpec(128,iv));cipher.updateAAD(chatAad(room.period,owner,nonce))
    return JSONObject().put("iv",Base64.getEncoder().encodeToString(iv)).put("ciphertext",Base64.getEncoder().encodeToString(cipher.doFinal(bytes)))
}
fun decryptChat(event: Event, room: ChatRoom): ChatMessage {
    require(event.verified() && event.kind==30078 && event.tags==listOf(listOf("schema",CHAT_SCHEMA)))
    val body=JSONObject(event.content);body.exact("action","period","nonce","iv","ciphertext")
    require(body.getString("action")=="send" && body.longValue("period")==room.period && body.getString("nonce").matches(Regex("[0-9a-f]{32}")))
    val iv=Base64.getDecoder().decode(body.getString("iv"));val encrypted=Base64.getDecoder().decode(body.getString("ciphertext"));require(iv.size==12 && encrypted.size in 17..3016)
    val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,SecretKeySpec(room.key,"AES"),GCMParameterSpec(128,iv));cipher.updateAAD(chatAad(room.period,event.pubkey,body.getString("nonce")))
    val plain=cipher.doFinal(encrypted);require(plain.size in 1..2000)
    val text=Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(plain)).toString()
    return ChatMessage(event.id,event.pubkey,event.created,text)
}
