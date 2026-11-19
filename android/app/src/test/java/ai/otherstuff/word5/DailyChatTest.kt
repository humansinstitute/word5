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
        val previousCompleted=mutableSetOf<String>()
        val outcomes=mutableMapOf<Pair<String,Long>,String>()
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
                completed+=event.pubkey;outcomes[event.pubkey to period]=body.getString("result");return JSONObject().put("ok",true)
            }
            assertEquals(listOf(listOf("schema",CHAT_SCHEMA)),event.tags)
            val body=JSONObject(event.content);val action=path.substringAfterLast('/');assertEquals(action,body.getString("action"));assertTrue(body.getString("nonce").matches(Regex("[0-9a-f]{32}")))
            if(!requests.add(event.id))throw ApiRejection("Replayed chat request",400)
            if(action=="rooms") {
                val extended=body.optBoolean("includePrevious")
                val days=if(extended)listOf(period,period-1)else listOf(period)
                val eligible=days.filter{if(it==period)event.pubkey in completed else event.pubkey in previousCompleted}
                eligible.forEach{day->outcomes.putIfAbsent(event.pubkey to day,if(day==period)"2"else"X")}
                return JSONObject().put("ok",true).put("rooms",array(eligible.map{day->JSONObject().put("period",day).put("date",java.time.LocalDate.ofEpochDay(day).toString()).put("word",if(day==period)"JOKER"else"CRANE").put("expiresAt",(day+if(extended)2 else 1)*86400000).put("key",Base64.getEncoder().encodeToString(ByteArray(32){day.toByte()}))}))
            }
            val requested=body.getLong("period")
            check(requested in (period-1)..period && if(requested==period)event.pubkey in completed else event.pubkey in previousCompleted){"Finish this puzzle or room expired"}
            if(action=="read") {
                beforeRead?.invoke()
                val retained=messages.filter{JSONObject(it.content).getLong("period")==requested}
                val after=body.optString("after");val anchor=retained.indexOfFirst{it.id==after};val reset=after.isEmpty() || anchor<0
                val selected=if(!delta || reset)retained.takeLast(200)else retained.drop(anchor+1)
                readRows=selected.size
                val results=JSONObject();retained.map{it.pubkey}.distinct().forEach{pubkey->val result=outcomes[pubkey to requested]?:if(requested==period)"2"else"X";results.put(pubkey,JSONObject().put("period",requested).put("won",result!="X").put("attempts",if(result=="X")6 else result.toInt()))}
                return JSONObject().put("ok",true).put("messages",array(selected.map{it.json()})).put("results",results).also{if(delta)it.put("reset",reset).put("cursor",retained.lastOrNull()?.id ?: JSONObject.NULL)}
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
            assertTrue(room.active(signer.owner,server.now));server.now=room.expiresAt
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
    @Test fun yesterdayOpensWithoutTodayCompletionAndCannotNewlyValidateHistoricalGuesses()=runBlocking {
        val signer=Signer();val server=Server();server.previousCompleted+=signer.owner
        val client=DailyChatClient(signer,server){server.now};val rooms=client.rooms(signer.owner)
        assertEquals(listOf(server.period-1),rooms.map{it.period});assertTrue(JSONObject(server.calls.last().second.content).getBoolean("includePrevious"))
        assertEquals((server.period+1)*86400000,rooms.single().expiresAt)
        assertThrows(IllegalArgumentException::class.java){runBlocking{client.validateCompletion(signer.owner,Game(server.period-1,listOf("JOKER")),rules)}}
        assertTrue(server.calls.none{it.first=="api/completion"});assertTrue(client.read(signer.owner,rooms.single()).isEmpty())
        server.completed+=signer.owner;assertEquals(listOf(server.period,server.period-1),client.rooms(signer.owner).map{it.period})
    }
    @Test fun eachRoomKeepsOwnCursorMessagesResultsAndUncertainSendAcrossBothSwitchDirections()=runBlocking {
        val signer=Signer();val server=Server();server.completed+=signer.owner;server.previousCompleted+=signer.owner;server.delta=true
        val client=DailyChatClient(signer,server){server.now};val rooms=client.rooms(signer.owner);val today=rooms[0];val yesterday=rooms[1]
        server.loseAck=true;try{client.send(signer.owner,today,"today lost ack");fail()}catch(_:IOException){}
        client.cancelRequests();client.send(signer.owner,yesterday,"yesterday only")
        val old=client.read(signer.owner,yesterday).single();assertEquals("yesterday only",old.text);assertEquals("X",client.results(signer.owner,yesterday)[signer.owner])
        client.cancelRequests();client.send(signer.owner,today,"today lost ack")
        assertEquals(2,server.messages.size);assertEquals(2,server.calls.count{it.first=="api/chat/send"})
        assertEquals("today lost ack",client.read(signer.owner,today).single().text);assertEquals("2",client.results(signer.owner,today)[signer.owner])
        client.cancelRequests();assertSame(old,client.read(signer.owner,yesterday).single());assertEquals(0,server.readRows)
        assertEquals(old.id,JSONObject(server.calls.last().second.content).getString("after"));assertEquals(listOf("today lost ack"),client.cachedMessages(signer.owner,today).map{it.text})
    }
    @Test fun nonselectedExpiryDoesNotCancelValidRoomInflightAndExactAccessBoundaryWipes():Unit=runBlocking {
        val signer=Signer();val server=Server();server.completed+=signer.owner;server.previousCompleted+=signer.owner
        val client=DailyChatClient(signer,server){server.now};val rooms=client.rooms(signer.owner);val today=rooms[0];val yesterday=rooms[1]
        client.read(signer.owner,yesterday);client.send(signer.owner,today,"still valid after rollover")
        supervisorScope {
            val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>();server.beforeRead={entered.complete(Unit);release.await()}
            val read=async{client.read(signer.owner,today)};entered.await();server.now=(server.period+1)*86400000
            assertFalse(yesterday.active(signer.owner,server.now));client.forget(yesterday);yesterday.discard();release.complete(Unit)
            assertEquals("still valid after rollover",read.await().single().text)
        }
        server.beforeRead=null;server.now=today.expiresAt-1;assertTrue(today.active(signer.owner,server.now))
        server.now=today.expiresAt;assertFalse(today.active(signer.owner,server.now));client.forget(today);today.discard();assertTrue(today.key.all{it==0.toByte()})
        assertThrows(IllegalStateException::class.java){runBlocking{client.read(signer.owner,today)}}
    }
    @Test fun resultMetadataMustMatchSelectedDayAndCachedProfileOverridesOldFallback() {
        val pubkey="a".repeat(64);val today=20768L;val yesterday=today-1
        fun result(period:Long,won:Any,attempts:Any)=JSONObject().put(pubkey,JSONObject().put("period",period).put("won",won).put("attempts",attempts))
        assertEquals(mapOf(pubkey to "5"),chatRoomResults(result(yesterday,true,5),yesterday))
        assertTrue(chatRoomResults(result(today,true,2),yesterday).isEmpty())
        assertTrue(chatRoomResults(result(yesterday,"false",6),yesterday).isEmpty())
        assertTrue(chatRoomResults(result(yesterday,false,5),yesterday).isEmpty())
        assertTrue(chatRoomResults(result(yesterday,true,2.5),yesterday).isEmpty())
        assertEquals(mapOf(pubkey to "X"),chatRoomResults(result(yesterday,false,6),yesterday))
        val fallback=ChatMember(result="2");val profile=JSONObject().put("display_name","Maya").put("picture","https://example.com/maya.png")
        val returned=chatRoomMember(profile,fallback,"5");assertEquals("Maya",returned.name);assertEquals("5",returned.result);assertTrue(returned.picture.endsWith("maya.png"))
        assertEquals("",chatRoomMember(profile,returned,"").result)
    }
    @Test fun midnightRequiresFreshTodayConsentAndCannotSubstituteNewGameForConfirmedOldPeriod()=runBlocking {
        val signer=Signer();val server=Server();val client=DailyChatClient(signer,server){server.now}
        val confirmed=Game(server.period,listOf("JOKER"));val oldPeriod=confirmed.period
        client.rooms(signer.owner);server.now=(oldPeriod+1)*86400000
        val newGame=Game(server.period,listOf("JOKER"))
        assertThrows(IllegalArgumentException::class.java){runBlocking{client.validateCompletion(signer.owner,confirmed,rules,oldPeriod)}}
        assertThrows(IllegalArgumentException::class.java){runBlocking{client.validateCompletion(signer.owner,newGame,rules,oldPeriod)}}
        assertTrue(server.calls.none{it.first=="api/completion"})
    }
    @Test fun namesPhotosAndResultsAreBoundedSafeAndCurrentDayOnly() {
        val pubkey="a".repeat(64);val profile=JSONObject().put("display_name","Maya <img src=x>").put("picture","javascript:alert(1)")
        val history=JSONObject().put("ok",true).put("pubkey",pubkey).put("periodId",123).put("completed",true).put("currentResult","X")
        assertEquals(ChatMember("Maya <img src=x>","","X"),chatMember(profile,history,pubkey,123))
        assertEquals("",chatMember(profile,history,pubkey,124).result);assertEquals("",chatMember(profile,history,"b".repeat(64),123).result)
        profile.put("picture","https://example.com/avatar.png");assertEquals("https://example.com/avatar.png",chatMember(profile,history,pubkey,123).picture)
        history.put("currentResult","0");assertEquals("",chatMember(profile,history,pubkey,123).result)
    }

    @Test fun browserV2VectorsAndStrictControls() {
        val fixture=JSONObject(javaClass.classLoader!!.getResourceAsStream("chat-actions-browser-vectors.json")!!.bufferedReader().readText())
        val period=fixture.getLong("period");val rows=fixture.getJSONArray("vectors")
        repeat(rows.length()) { index->
            val vector=rows.getJSONObject(index);val event=Event.parse(vector.getJSONObject("event"));val action=vector.getJSONObject("action")
            val room=ChatRoom(event.pubkey,period,"","JOKER",(period+2)*86400000,Base64.getDecoder().decode(fixture.getString("key")))
            val decoded=decryptChat(event,room);assertEquals(action.getString("type"),decoded.type);assertEquals(action.getString("target"),decoded.target)
            if(decoded.type=="reply")assertEquals(action.getString("text"),decoded.text)else {assertEquals(action.getBoolean("active"),decoded.active);assertEquals(action.getLong("revision"),decoded.revision)}
            assertThrows(Exception::class.java){decryptChat(event.copy(pubkey="f".repeat(64)),room)}
        }
        val reply=JSONObject().put("v",2).put("type","reply").put("target","a".repeat(64)).put("text","ok")
        for(extra in listOf("author","quote","unknown"))assertThrows(Exception::class.java){chatActionPayload(JSONObject(reply.toString()).put(extra,"forged"))}
        assertThrows(Exception::class.java){chatActionPayload(JSONObject(reply.toString()).put("v",3))}
        assertThrows(Exception::class.java){chatActionPayload(JSONObject(reply.toString()).put("text","🔥".repeat(501)))}
    }
    @Test fun reactionOrderingDeduplicationAndQuotesUseOnlyVerifiedOriginals() {
        val target="a".repeat(64);val actor="b".repeat(64);val other="c".repeat(64)
        val original=ChatMessage(target,other,1,"Original text")
        val unlike=ChatMessage("e".repeat(64),actor,1,"","like",target,false,2)
        val like=ChatMessage("f".repeat(64),actor,1,"","like",target,true,1)
        val second=ChatMessage("d".repeat(64),other,1,"","like",target,true,1)
        val reply=ChatMessage("9".repeat(64),actor,1,"Reply text","reply",target)
        val rows=listOf(original,unlike,like,like,second,reply)
        val view=chatConversation(rows,actor);assertEquals(2,view.size);assertEquals(1,view.first().likes);assertFalse(view.first().liked)
        assertEquals(other,view.last().quoteAuthor);assertEquals(original.text,view.last().quoteText)
        val missing=chatConversation(listOf(reply,like,unlike),actor).single();assertEquals("",missing.quoteAuthor);assertEquals("",missing.quoteText);assertEquals(0,missing.likes)
        val nested=reply.copy(id="8".repeat(64),target=reply.id);assertEquals("Reply text",chatConversation(rows+nested,actor).last().quoteText)
        assertEquals(0,chatConversation(listOf(original,like.copy(target="0".repeat(64))),actor).single().likes)
    }
    @Test fun twoActorsToggleReplyAndRecoverUncertainReactionWithoutDuplicate()=runBlocking {
        val a=Signer();val b=Signer(2);val server=Server();server.completed+=listOf(a.owner,b.owner);server.delta=true
        val ca=DailyChatClient(a,server){server.now};val cb=DailyChatClient(b,server){server.now}
        val ra=ca.open(a.owner)!!;val rb=cb.open(b.owner)!!
        val target=ca.send(a.owner,ra,"Original 🧡");cb.read(b.owner,rb)
        cb.like(b.owner,rb,target);var rows=ca.read(a.owner,ra);assertEquals(1,rows.single().likes);assertFalse(rows.single().liked)
        ca.like(a.owner,ra,target);rows=ca.read(a.owner,ra);assertEquals(2,rows.single().likes);assertTrue(rows.single().liked)
        cb.like(b.owner,rb,target);rows=ca.read(a.owner,ra);assertEquals(1,rows.single().likes)
        server.loseAck=true;try{ca.like(a.owner,ra,target);fail()}catch(_:IOException){}
        val count=server.messages.size;ca.like(a.owner,ra,target);assertEquals(count,server.messages.size);assertEquals(0,ca.read(a.owner,ra).single().likes)
        cb.send(b.owner,rb,"Reply",target);val reply=ca.read(a.owner,ra).last();assertEquals("reply",reply.type);assertEquals(a.owner,reply.quoteAuthor);assertEquals("Original 🧡",reply.quoteText)
        val stored=server.messages.last();assertFalse(stored.content.contains("Reply"));assertFalse(stored.content.contains(target))
        assertThrows(Exception::class.java){runBlocking{ca.like(a.owner,ra,stored.id+"bad")}}
        // Emit public fixture bytes for the browser to verify native -> browser.
        java.io.File("build/chat-actions-native-vector.json").writeText(JSONObject().put("period",ra.period).put("key",Base64.getEncoder().encodeToString(ra.key)).put("event",stored.json()).toString())
    }

    @Test fun repeatedUncertainReactionPreservesOperationAndSignerCancelAllowsEdit():Unit=runBlocking {
        val signer=Signer();val server=Server();server.completed+=signer.owner;var failWrites=0
        val api=ChatApi{path,event->if(path=="api/chat/send"&&failWrites>0){failWrites--;throw IOException("request delivery unknown")};server.post(path,event)}
        val client=DailyChatClient(signer,api){server.now};val room=client.open(signer.owner)!!;val target=client.send(signer.owner,room,"Original")
        failWrites=2
        repeat(2){try{client.like(signer.owner,room,target);fail()}catch(_:IOException){}}
        client.like(signer.owner,room,target);assertEquals(2,server.messages.size);assertTrue(client.read(signer.owner,room).single().liked)
        signer.cancelled=true;try{client.send(signer.owner,room,"cancelled draft");fail()}catch(_:CancellationException){}
        signer.cancelled=false;client.send(signer.owner,room,"edited draft");assertEquals(3,server.messages.size)
        val action=JSONObject().put("v",2).put("type","reply").put("target","a".repeat(64)).put("text",42)
        assertThrows(Exception::class.java){chatActionPayload(action)}
        assertThrows(Exception::class.java){chatActionPayload(action.put("text","ok").put("target",42))}
    }

    @Test fun confirmedLocalSendThenDeltaRestoresServerReceiptOrder()=runBlocking {
        val a=Signer();val b=Signer(2);val server=Server();server.completed+=listOf(a.owner,b.owner);server.delta=true
        val ca=DailyChatClient(a,server){server.now};val cb=DailyChatClient(b,server){server.now};val ra=ca.open(a.owner)!!;val rb=cb.open(b.owner)!!
        ca.send(a.owner,ra,"first");ca.read(a.owner,ra)
        cb.send(b.owner,rb,"other before own");ca.send(a.owner,ra,"own confirmation")
        assertEquals(listOf("first","other before own","own confirmation"),ca.read(a.owner,ra).map{it.text})
    }
}
