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
    fun active(account: String, now: Long) = !discarded && owner == account && period in (Rules.period(now)-1)..Rules.period(now) && now < expiresAt
    fun discard() { discarded=true;key.fill(0) }
}
data class ChatMessage(val id: String, val pubkey: String, val createdAt: Long, val text: String)
data class ChatMember(val name: String = "", val picture: String = "", val result: String = "", val bio:String = "", val profileState:String = "ready")
fun chatMember(profile: JSONObject?, history: JSONObject?, pubkey: String, period: Long): ChatMember {
    fun text(data: JSONObject?, key: String) = (data?.opt(key) as? String).orEmpty()
    val name = (text(profile,"display_name").trim().ifEmpty { text(profile,"name").trim() }).take(64)
    val photo = safeProfilePicture(text(profile,"picture"))
    val result = text(history,"currentResult").takeIf { history?.optBoolean("ok") == true && text(history,"pubkey") == pubkey && history.optLong("periodId",-1) == period && history.optBoolean("completed") && it.matches(Regex("[1-6X]")) }.orEmpty()
    return ChatMember(name,photo,result,text(profile,"about").take(2000))
}
fun chatRoomMember(profile:JSONObject?,fallback:ChatMember?,result:String):ChatMember =
    (if(profile!=null)chatMember(profile,null,"",0)else fallback?:ChatMember()).copy(result=result.takeIf{it.matches(Regex("[1-6X]"))}.orEmpty())
fun interface ChatApi { suspend fun post(path: String, event: Event): JSONObject }
/** Verified outcomes come from the selected room, never today's public history. */
fun chatRoomResults(value:JSONObject?,period:Long):Map<String,String> = buildMap {
    value?.keys()?.asSequence()?.take(200)?.forEach { pubkey -> runCatching {
        require(pubkey.matches(Regex("[0-9a-f]{64}")))
        val result=value.getJSONObject(pubkey);require(result.longValue("period")==period)
        val won=result.bool("won");val attempts=result.longValue("attempts");require(attempts in 1..6 && (won || attempts==6L))
        put(pubkey,if(won)attempts.toString()else"X")
    } }
}
/** Production signed/ciphertext contract; independent memory cache per eligible room. */
class DailyChatClient(private val signer: NativeSigner, private val api: ChatApi = ChatApi { path,event -> PublicNostr.api(path,event) }, private val clock: () -> Long = System::currentTimeMillis) {
    private val random=SecureRandom()
    private var requestEpoch=0
    private data class PendingSend(val textHash:String,val event:Event)
    private class RoomCache(val owner:String,val period:Long,var expiresAt:Long) {
        var cursor:String?=null
        var pending:PendingSend?=null
        val messages=linkedMapOf<String,ChatMessage>()
        var results:Map<String,String> = emptyMap()
    }
    private val caches=linkedMapOf<String,RoomCache>()
    private fun scope(owner:String,room:ChatRoom)="$owner:${room.period}:${sha256(Base64.getEncoder().encodeToString(room.key))}"
    fun cancelRequests() { requestEpoch++ }
    fun reset() { cancelRequests();caches.clear() }
    fun prune(owner:String) { caches.entries.removeAll { (_,cache)->cache.owner!=owner || cache.period !in (Rules.period(clock())-1)..Rules.period(clock()) || clock()>=cache.expiresAt } }
    fun forget(room:ChatRoom) { caches.remove(scope(room.owner,room)) }
    private fun cache(owner:String,room:ChatRoom):RoomCache {
        requireActive(owner,room);prune(owner)
        val key=scope(owner,room)
        caches.entries.removeAll { (id,entry)->entry.owner==owner && entry.period==room.period && id!=key }
        return caches.getOrPut(key){RoomCache(owner,room.period,room.expiresAt)}.also{it.expiresAt=room.expiresAt}
    }
    fun cachedMessages(owner:String,room:ChatRoom)=cache(owner,room).messages.values.toList()
    fun results(owner:String,room:ChatRoom)=cache(owner,room).results.toMap()
    private fun nonce()=ByteArray(16).also(random::nextBytes).joinToString(""){"%02x".format(it)}
    private fun draft(owner:String,body:JSONObject)=Event(owner,clock()/1000,30078,listOf(listOf("schema",CHAT_SCHEMA)),body.toString())
    private suspend fun signed(event:Event):Event {
        val signed=signer.sign(event)
        require(signed.samePayload(event)&&signed.verified()){ "Amber returned a different chat request" }
        check(kotlin.math.abs(clock()-signed.created*1000)<=60000){"Chat approval expired. Retry to approve a fresh request."}
        currentCoroutineContext().ensureActive();return signed
    }
    private suspend fun post(path:String,event:Event):JSONObject {
        val epoch=requestEpoch;val approved=signed(event);check(epoch==requestEpoch){"Chat selection or account changed"}
        return api.post(path,approved).also { check(epoch==requestEpoch){"Chat selection or account changed"};check(it.optBoolean("ok")){it.optString("error","Chat unavailable; retry")} }
    }
    private suspend fun request(owner:String,action:String,fields:JSONObject=JSONObject()):JSONObject {
        val body=JSONObject().put("action",action).put("nonce",nonce());fields.keys().forEach{body.put(it,fields.get(it))}
        return post("api/chat/$action",draft(owner,body))
    }
    suspend fun rooms(owner:String):List<ChatRoom> {
        require(owner.matches(Regex("[0-9a-f]{64}")));prune(owner)
        val response=request(owner,"rooms",JSONObject().put("includePrevious",true))
        val rows=response.getJSONArray("rooms");require(rows.length()<=2){"Unexpected chat room list"}
        val parsed=mutableListOf<ChatRoom>()
        try {
            repeat(rows.length()){i->
                val row=rows.getJSONObject(i);val period=row.longValue("period");val expires=row.longValue("expiresAt")
                require(period in (Rules.period(clock())-1)..Rules.period(clock()) && expires==(period+2)*86400000L && clock()<expires && row.getString("date")==LocalDate.ofEpochDay(period).toString()){ "Chat room expired or unavailable" }
                val word=row.getString("word");require(word.matches(Regex("[A-Z]{5}")))
                val key=Base64.getDecoder().decode(row.getString("key"));require(key.size==32){"Invalid chat key"}
                parsed+=ChatRoom(owner,period,row.getString("date"),word,expires,key)
            }
            require(parsed.map{it.period}.distinct().size==parsed.size && parsed.map{it.period}==parsed.map{it.period}.sortedDescending()){ "Unexpected chat room order" }
            return parsed
        } catch(e:Exception) { parsed.forEach{it.discard()};throw e }
    }
    suspend fun open(owner:String):ChatRoom? { val all=rooms(owner);val today=all.firstOrNull{it.period==Rules.period(clock())};all.filter{it!==today}.forEach{it.discard()};return today }
    /** Only today's informed validation may submit original guesses. */
    suspend fun validateCompletion(owner:String,game:Game,rules:Rules,confirmedPeriod:Long=game.period) {
        require(game.period==confirmedPeriod&&confirmedPeriod==Rules.period(clock())&&rules.completed(game)){"Finish today's puzzle first"}
        require(game.guesses.isNotEmpty()){ "This restored result has no guesses. Check an existing server completion; missing guesses cannot be invented." }
        post("api/completion",completionDraft(game,rules,owner,clock()/1000))
        check(game.period==Rules.period(clock())){"The new word has started. Finish it to unlock today's chat."}
    }
    private fun requireActive(owner:String,room:ChatRoom){check(room.active(owner,clock())){"Chat room expired or account changed"}}
    private fun current(owner:String,room:ChatRoom,entry:RoomCache,epoch:Int) {
        requireActive(owner,room);check(epoch==requestEpoch && caches[scope(owner,room)]===entry){"Chat selection or account changed"}
    }
    suspend fun send(owner:String,room:ChatRoom,text:String):String {
        val entry=cache(owner,room);val epoch=requestEpoch;val hash=sha256(text.trim())
        val previous=entry.pending?.takeIf{it.textHash==hash}
        if(previous!=null){
            if(read(owner,room).any{it.id==previous.event.id}){if(entry.pending===previous)entry.pending=null;return previous.event.id}
            check(kotlin.math.abs(clock()-previous.event.created*1000)<=60000){"Previous send could not be confirmed. Refresh this room, then edit the draft before sending again."}
        }
        val event=previous?.event ?:run {
            val messageNonce=nonce();val body=encryptChat(text,room,owner,messageNonce,random).put("action","send").put("period",room.period).put("nonce",messageNonce)
            signed(draft(owner,body))
        }
        current(owner,room,entry,epoch);entry.pending=PendingSend(hash,event)
        val response=try{api.post("api/chat/send",event)}catch(e:ApiRejection){if(e.definitive&&entry.pending?.event?.id==event.id)entry.pending=null;throw e}
        if(!response.optBoolean("ok")){if(entry.pending?.event?.id==event.id)entry.pending=null;error(response.optString("error","Chat unavailable; retry"))}
        current(owner,room,entry,epoch);val id=response.getString("id");require(id==event.id)
        if(entry.pending?.event?.id==event.id)entry.pending=null
        return id
    }
    suspend fun read(owner:String,room:ChatRoom):List<ChatMessage> {
        val entry=cache(owner,room);val epoch=requestEpoch
        val fields=JSONObject().put("period",room.period);entry.cursor?.let{fields.put("after",it)}
        val response=request(owner,"read",fields);current(owner,room,entry,epoch)
        val rows=response.getJSONArray("messages");require(rows.length()<=200)
        val delta=response.has("cursor")&&response.has("reset")
        val nextCursor=if(delta&&!response.isNull("cursor"))response.getString("cursor")else null
        require(nextCursor==null||nextCursor.matches(Regex("[0-9a-f]{64}"))){"Invalid chat cursor"}
        val reset=!delta||response.bool("reset");val known=entry.messages.toMap()
        val decoded=withContext(Dispatchers.Default){(0 until rows.length()).mapNotNull { index->
            try{val row=rows.getJSONObject(index);known[row.optString("id")]?:decryptChat(Event.parse(row),room)}catch(e:CancellationException){throw e}catch(_:Exception){null}
        }.distinctBy{it.id}}
        current(owner,room,entry,epoch)
        if(reset)entry.messages.clear();decoded.forEach{entry.messages[it.id]=it}
        while(entry.messages.size>200)entry.messages.remove(entry.messages.keys.first())
        entry.cursor=if(delta)nextCursor else decoded.lastOrNull()?.id
        entry.results=chatRoomResults(response.optJSONObject("results"),room.period)
        return entry.messages.values.toList()
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
