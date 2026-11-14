package ai.otherstuff.word5

import fr.acinq.secp256k1.Secp256k1
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.supervisorScope
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.Base64

class DailyChatTest {
    private class Signer(byte:Int=1):NativeSigner {
        val key=ByteArray(32){byte.toByte()}
        val owner=Secp256k1.pubkeyCreate(key).copyOfRange(1,33).joinToString(""){"%02x".format(it)}
        var cancelled=false
        override suspend fun sign(event:Event):Event { if(cancelled)throw CancellationException("Amber cancelled");return event.copy(id=event.hash(),sig=Secp256k1.signSchnorr(unhex(event.hash()),key,ByteArray(32)).joinToString(""){"%02x".format(it)}) }
        override suspend fun encrypt(owner:String,text:String):String=error("Chat must not encrypt backup data")
        override suspend fun decrypt(owner:String,text:String):String=error("Chat must not decrypt backup data")
    }
    private class Server:ChatApi {
        var now=20768L*86400000+100000
        val period get()=Rules.period(now)
        val completed=mutableSetOf<String>()
        val messages=mutableListOf<Event>()
        val requests=mutableSetOf<String>()
        val calls=mutableListOf<Pair<String,Event>>()
        var loseAck=false
        var rejectSend=false
        var delta=false
        var readRows=0
        var beforeRead:(suspend()->Unit)?=null
        override suspend fun post(path:String,event:Event):JSONObject {
            assertTrue(event.verified());calls+=path to event
            assertFalse(isPublicRelayPayload(event))
            if(path=="api/completion") {
                val body=JSONObject(event.content);assertEquals("word5.completion.v1",event.tag("schema"));assertTrue(body.getJSONArray("guesses").length() in 1..6)
                completed+=event.pubkey;return JSONObject().put("ok",true)
            }
            assertEquals(listOf(listOf("schema",CHAT_SCHEMA)),event.tags)
            val body=JSONObject(event.content);val action=path.substringAfterLast('/');assertEquals(action,body.getString("action"));assertTrue(body.getString("nonce").matches(Regex("[0-9a-f]{32}")))
            if(!requests.add(event.id))throw ApiRejection("Replayed chat request",400)
            if(action=="rooms")return JSONObject().put("ok",true).put("rooms",array(if(event.pubkey in completed)listOf(JSONObject().put("period",period).put("date",java.time.LocalDate.ofEpochDay(period).toString()).put("word","JOKER").put("expiresAt",(period+1)*86400000).put("key",Base64.getEncoder().encodeToString(ByteArray(32){period.toByte()})))else emptyList<Any>()))
            check(event.pubkey in completed && body.getLong("period")==period){"Finish this puzzle or room expired"}
            if(action=="read") {
                beforeRead?.invoke()
                val after=body.optString("after");val anchor=messages.indexOfFirst{it.id==after};val reset=after.isEmpty() || anchor<0
                val selected=if(!delta || reset)messages.takeLast(200)else messages.drop(anchor+1)
                readRows=selected.size
                return JSONObject().put("ok",true).put("messages",array(selected.map{it.json()})).also{if(delta)it.put("reset",reset).put("cursor",messages.lastOrNull()?.id ?: JSONObject.NULL)}
            }
            if(rejectSend){rejectSend=false;throw ApiRejection("Sending too quickly; wait a moment",400)}
            assertEquals(setOf("action","nonce","period","iv","ciphertext"),body.keys().asSequence().toSet())
            messages+=event
            if(loseAck){loseAck=false;throw IOException("HTTP acknowledgement lost")}
            return JSONObject().put("ok",true).put("id",event.id)
        }
    }
    private val rules=Rules(listOf("joker"),listOf("crane","other"))
    @Test fun browserCiphertextDecryptsWithNativeAadAndUnicodeIntact() {
        val vector=JSONObject(javaClass.classLoader!!.getResourceAsStream("chat-browser-vector.json")!!.bufferedReader().readText())
        val period=vector.getLong("period");val event=Event.parse(vector.getJSONObject("event"))
        val room=ChatRoom(event.pubkey,period,java.time.LocalDate.ofEpochDay(period).toString(),"JOKER",(period+1)*86400000,Base64.getDecoder().decode(vector.getString("key")))
        assertEquals(vector.getString("text"),decryptChat(event,room).text)
        val wrong=ChatRoom(event.pubkey,period,room.date,"JOKER",room.expiresAt,ByteArray(32))
        assertThrows(Exception::class.java){decryptChat(event,wrong)}
        assertThrows(Exception::class.java){decryptChat(event.copy(content=event.content.replace("send","read")),room)}
        room.discard();assertTrue(room.key.all{it==0.toByte()})
    }
    @Test fun roomOpenNeverSendsGuessesAndExplicitWinLossValidationUnlocksOnlyCurrentRoom()=runBlocking {
        for(loss in listOf(false,true)){
            val signer=Signer(if(loss)2 else 1);val server=Server();val client=DailyChatClient(signer,server){server.now}
            assertNull(client.open(signer.owner));assertEquals(listOf("api/chat/rooms"),server.calls.map{it.first});assertFalse(server.calls[0].second.content.contains("guesses"))
            val game=Game(server.period,if(loss)List(6){"OTHER"}else listOf("CRANE","JOKER"))
            client.validateCompletion(signer.owner,game,rules)
            val room=client.open(signer.owner)!!;assertEquals(server.period,room.period);assertEquals("JOKER",room.word)
            assertEquals(if(loss)"X" else "2",JSONObject(server.calls.first{it.first=="api/completion"}.second.content).getString("result"))
            assertTrue(server.calls.none{it.first.contains("publication")});assertFalse(room.active(Signer(3).owner,server.now))
            server.now=(server.period+1)*86400000
            assertFalse(room.active(signer.owner,server.now));assertThrows(IllegalStateException::class.java){runBlocking{client.read(signer.owner,room)}}
        }
    }
    @Test fun encryptedSendReadNeverCarriesPlaintextAndOtherIdentityCannotUseRoom():Unit=runBlocking {
        val signer=Signer();val server=Server();server.completed+=signer.owner;val client=DailyChatClient(signer,server){server.now};val room=client.open(signer.owner)!!
        val text="Native 🧡 <script> stays text"
        client.send(signer.owner,room,text);val rows=client.read(signer.owner,room)
        assertEquals(text,rows.single().text);assertFalse(server.messages.single().json().toString().contains(text))
        assertFalse(server.calls.any{it.second.content.contains("guesses")})
        assertThrows(IllegalStateException::class.java){runBlocking{client.send(Signer(2).owner,room,"wrong account")}}
        assertThrows(IllegalArgumentException::class.java){runBlocking{client.send(signer.owner,room,"🧡".repeat(501))}}
    }
    @Test fun lostSendAcknowledgementReconcilesWithoutDuplicateAndDefinitiveThrottleAllowsFreshRetry()=runBlocking {
        val signer=Signer();val server=Server();server.completed+=signer.owner;val client=DailyChatClient(signer,server){server.now};val room=client.open(signer.owner)!!
        server.loseAck=true;try{client.send(signer.owner,room,"lost ack");fail()}catch(_:IOException){}
        val id=client.send(signer.owner,room,"lost ack");assertEquals(server.messages.single().id,id);assertEquals(1,server.calls.count{it.first=="api/chat/send"})
        server.rejectSend=true;try{client.send(signer.owner,room,"retry same draft");fail()}catch(_:ApiRejection){}
        val rejected=server.calls.last().second.id;server.now+=2100
        client.send(signer.owner,room,"retry same draft");assertEquals(2,server.messages.size);assertNotEquals(rejected,server.messages.last().id)
    }
    @Test fun restoredOutcomeCannotInventGuessesAndCancellationOrOfflineDoesNotPublish()=runBlocking {
        val signer=Signer();val server=Server();val client=DailyChatClient(signer,server){server.now}
        assertThrows(IllegalArgumentException::class.java){runBlocking{client.validateCompletion(signer.owner,Game(server.period,outcome=2),rules)}}
        assertTrue(server.calls.isEmpty())
        signer.cancelled=true;try{client.open(signer.owner);fail()}catch(_:CancellationException){}
        assertTrue(server.calls.isEmpty());signer.cancelled=false
        val offline=DailyChatClient(signer,ChatApi{_,_->throw IOException("offline")}){server.now}
        try{offline.open(signer.owner);fail()}catch(_:IOException){}
        assertTrue(server.calls.isEmpty())
    }
    @Test fun malformedOrPastRoomAndChangedSignerAreRejected():Unit=runBlocking {
        val signer=Signer();val server=Server();server.completed+=signer.owner
        val bad=ChatApi{path,event->server.post(path,event).also{it.getJSONArray("rooms").getJSONObject(0).put("period",server.period-1)}}
        assertThrows(IllegalArgumentException::class.java){runBlocking{DailyChatClient(signer,bad){server.now}.open(signer.owner)}}
        val swapped=object:NativeSigner{override suspend fun sign(event:Event)=Signer(2).sign(event.copy(pubkey=Signer(2).owner));override suspend fun encrypt(owner:String,text:String)="";override suspend fun decrypt(owner:String,text:String)=""}
        assertThrows(IllegalArgumentException::class.java){runBlocking{DailyChatClient(swapped,server){server.now}.open(signer.owner)}}
    }
    @Test fun deltaCacheMergesOnlyNewMessagesUsesReceiptOrderAndRecoversLegacyAndMissingAnchor()=runBlocking {
        val signer=Signer();val server=Server();server.completed+=signer.owner;server.delta=true
        val client=DailyChatClient(signer,server){server.now};val room=client.open(signer.owner)!!
        client.send(signer.owner,room,"first");val first=client.read(signer.owner,room).single()
        assertEquals(1,server.readRows);assertFalse(JSONObject(server.calls.last().second.content).has("after"))
        val unchanged=client.read(signer.owner,room).single();assertSame(first,unchanged);assertEquals(0,server.readRows)
        assertEquals(first.id,JSONObject(server.calls.last().second.content).getString("after"))
        server.now+=2100;client.send(signer.owner,room,"second")
        val merged=client.read(signer.owner,room);assertEquals(listOf("first","second"),merged.map{it.text});assertEquals(1,server.readRows);assertSame(first,merged.first())
        server.messages.removeAt(0);server.messages.removeAt(0)
        server.now+=2100;client.send(signer.owner,room,"retained after cursor pruned")
        assertEquals(listOf("retained after cursor pruned"),client.read(signer.owner,room).map{it.text})
        server.delta=false;val legacy=client.read(signer.owner,room);assertEquals(1,legacy.size);assertSame(legacy.first(),client.read(signer.owner,room).first())
        client.reset();client.read(signer.owner,room);assertFalse(JSONObject(server.calls.last().second.content).has("after"))
    }
    @Test fun resetOrDiscardDuringInflightReadCannotHydrateOldAccountCache():Unit=runBlocking {
        val signer=Signer();val server=Server();server.completed+=signer.owner;val client=DailyChatClient(signer,server){server.now};val room=client.open(signer.owner)!!
        client.send(signer.owner,room,"old account message")
        supervisorScope {
            val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>()
            server.beforeRead={entered.complete(Unit);release.await()}
            val read=async{client.read(signer.owner,room)};entered.await();client.reset();release.complete(Unit)
            try{read.await();fail("Reset cache rehydrated")}catch(_:IllegalStateException){}
        }
        server.beforeRead=null;server.messages.clear();assertTrue(client.read(signer.owner,room).isEmpty());assertFalse(JSONObject(server.calls.last().second.content).has("after"))
        room.discard();assertFalse(room.active(signer.owner,server.now));assertThrows(IllegalStateException::class.java){runBlocking{client.read(signer.owner,room)}}
    }
    @Test fun malformedLastCiphertextStillAdvancesServerCursor()=runBlocking {
        val signer=Signer();val server=Server();server.completed+=signer.owner;server.delta=true
        val client=DailyChatClient(signer,server){server.now};val room=client.open(signer.owner)!!
        client.send(signer.owner,room,"valid");client.read(signer.owner,room)
        val invalid=server.messages.first().copy(id="f".repeat(64),sig="0".repeat(128));server.messages+=invalid
        assertEquals(listOf("valid"),client.read(signer.owner,room).map{it.text})
        client.read(signer.owner,room);assertEquals(invalid.id,JSONObject(server.calls.last().second.content).getString("after"));assertEquals(0,server.readRows)
    }
    @Test fun lateRejectedSendCannotEraseNewerUncertainSend():Unit=runBlocking {
        val signer=Signer();val server=Server();server.completed+=signer.owner
        val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>();var first=true
        val api=ChatApi { path,event -> if(path=="api/chat/send"&&first){first=false;entered.complete(Unit);release.await();throw ApiRejection("Old rate rejection",400)}else server.post(path,event) }
        val client=DailyChatClient(signer,api){server.now};val room=client.open(signer.owner)!!
        supervisorScope {
            val old=async{client.send(signer.owner,room,"old draft")};entered.await();client.reset()
            server.loseAck=true;try{client.send(signer.owner,room,"new draft");fail()}catch(_:IOException){}
            release.complete(Unit);try{old.await();fail()}catch(_:ApiRejection){}
            client.send(signer.owner,room,"new draft")
            assertEquals(1,server.messages.size);assertEquals(1,server.calls.count{it.first=="api/chat/send"})
        }
    }
    @Test fun namesPhotosAndResultsAreBoundedSafeAndCurrentDayOnly() {
        val pubkey="a".repeat(64);val profile=JSONObject().put("display_name","Maya <img src=x>").put("picture","javascript:alert(1)")
        val history=JSONObject().put("ok",true).put("pubkey",pubkey).put("periodId",123).put("completed",true).put("currentResult","X")
        assertEquals(ChatMember("Maya <img src=x>","","X"),chatMember(profile,history,pubkey,123))
        assertEquals("",chatMember(profile,history,pubkey,124).result);assertEquals("",chatMember(profile,history,"b".repeat(64),123).result)
        profile.put("picture","https://example.com/avatar.png");assertEquals("https://example.com/avatar.png",chatMember(profile,history,pubkey,123).picture)
        history.put("currentResult","0");assertEquals("",chatMember(profile,history,pubkey,123).result)
    }
}
