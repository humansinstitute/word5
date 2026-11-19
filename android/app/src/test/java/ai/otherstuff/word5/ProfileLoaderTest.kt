package ai.otherstuff.word5

import fr.acinq.secp256k1.Secp256k1
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import okhttp3.*
import okhttp3.mockwebserver.*
import org.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

class ProfileLoaderTest {
    private fun event(n:Int=1,created:Long=100,content:String="{\"name\":\"Disposable ἐλεύθερος 😀\"}"):Event {
        val key=ByteArray(32){n.toByte()};val owner=Secp256k1.pubkeyCreate(key).copyOfRange(1,33).joinToString(""){"%02x".format(it)}
        val e=Event(owner,created,0,emptyList(),content)
        return e.copy(id=e.hash(),sig=Secp256k1.signSchnorr(unhex(e.hash()),key,ByteArray(32)).joinToString(""){"%02x".format(it)})
    }
    private class Relay(val handle:(WebSocket,JSONArray)->Unit):AutoCloseable {
        val connections=AtomicInteger();val requests=AtomicInteger();val closes=AtomicInteger()
        val server=MockWebServer().apply { dispatcher=object:okhttp3.mockwebserver.Dispatcher(){override fun dispatch(request:RecordedRequest)=MockResponse().withWebSocketUpgrade(object:WebSocketListener(){
            override fun onOpen(webSocket:WebSocket,response:Response){connections.incrementAndGet()}
            override fun onMessage(webSocket:WebSocket,text:String){val m=JSONArray(text);if(m.getString(0)=="REQ"){requests.incrementAndGet();handle(webSocket,m)}else if(m.getString(0)=="CLOSE")closes.incrementAndGet()}
        })};start() }
        val url get()=server.url("/").toString().replace("http:","ws:")
        override fun close(){server.close()}
    }
    private fun send(ws:WebSocket,m:JSONArray,e:Event){ws.send(array(listOf("EVENT",m.getString(1),e.json())).toString())}
    private fun end(ws:WebSocket,m:JSONArray){ws.send(array(listOf("EOSE",m.getString(1))).toString())}
    @Test fun independentJavascriptSignedUnicodeFixture(){
        val e=Event.parse(JSONObject(javaClass.getResource("/public-profile-disposable.json")!!.readText()))
        assertTrue("canonical hash ${e.hash()} expected ${e.id}",e.verified())
    }
    @Test fun fastVerifiedEventStreamsBeforeHungPeerAndSurvivesNoEose()=runBlocking {
        val e=event();Relay{ws,m->send(ws,m,e)}.use{fast->Relay{_,_->}.use{hung->
            val loader=ProfileLoader(primary=listOf(fast.url,hung.url),lookup=emptyList(),stageMs=650,bufferMs=10)
            try {val start=System.nanoTime();var first=0L;val updates=loader.observe(e.pubkey).onEach{if(it.event!=null&&first==0L)first=(System.nanoTime()-start)/1000000}.toList()
                assertTrue("first=$first",first<600);assertEquals(e.id,updates.last().event!!.id);assertFalse(updates.last().allRelaysCompleted)
            }finally{loader.close()}
        }}}
    @Test fun emptyPrimaryFallsBackAndIncompleteEmptyIsNotMissing()=runBlocking {
        val e=event();Relay{ws,m->end(ws,m)}.use{empty->Relay{ws,m->send(ws,m,e);end(ws,m)}.use{lookup->
            val loader=ProfileLoader(primary=listOf(empty.url),lookup=listOf(lookup.url),bufferMs=1)
            try{val result=loader.observe(e.pubkey).toList().last();assertEquals(e.id,result.event!!.id);assertTrue(result.allRelaysCompleted);assertEquals(1,lookup.requests.get())}finally{loader.close()}
        }}
        Relay{ws,m->end(ws,m)}.use{empty->Relay{_,_->}.use{hung->
            val loader=ProfileLoader(primary=listOf(empty.url,hung.url),lookup=emptyList(),stageMs=100,bufferMs=1)
            try{val result=loader.observe(e.pubkey).toList().last();assertNull(result.event);assertFalse(result.allRelaysCompleted)}finally{loader.close()}
        }}
    }
    @Test fun malformedForgedExtensionsAndNewestTieIsolation()=runBlocking {
        val old=event();val latest=event(created=101);val tie=event(created=101,content="{\"name\":\"Tie\"}");val expected=if(latest.id<tie.id)latest else tie
        Relay{ws,m->
            ws.send("[\"EVENT\",\"${m.getString(1)}\",{}]")
            send(ws,m,old.copy(content="forged"));send(ws,m,old)
            ws.send(array(listOf("EVENT",m.getString(1),latest.json().put("relay_extension",true))).toString())
            send(ws,m,tie);send(ws,m,old);end(ws,m)
        }.use{relay->val loader=ProfileLoader(primary=listOf(relay.url),lookup=emptyList(),bufferMs=1)
            try{val updates=loader.observe(old.pubkey).toList();assertEquals(expected.id,updates.last().event!!.id);assertTrue(updates.all{it.event?.verified()!=false})}finally{loader.close()}
        }
        assertTrue(Event.parseRelay(old.json().put("extension",1)).verified())
        assertTrue(runCatching{Event.parse(old.json().put("extension",1))}.isFailure)
    }
    @Test fun batchedPartialRetryJoinedRequestsAndLatestUpdate()=runBlocking {
        val a=event();val b=event(2);val newer=event(created=102)
        Relay{ws,m->val authors=m.getJSONObject(2).getJSONArray("authors");val first=authors.getString(0)
            if(first==a.pubkey){send(ws,m,a);send(ws,m,newer)}else send(ws,m,b)
            end(ws,m)
        }.use{relay->val loader=ProfileLoader(primary=listOf(relay.url),lookup=emptyList(),bufferMs=30)
            try {val results=awaitAll(async{loader.observe(a.pubkey).toList()},async{loader.observe(a.pubkey).toList()},async{loader.observe(b.pubkey).toList()})
                assertEquals(newer.id,results[0].last().event!!.id);assertEquals(newer.id,results[1].last().event!!.id);assertEquals(b.id,results[2].last().event!!.id)
                assertEquals(1,relay.connections.get());assertEquals(2,relay.requests.get())
            }finally{loader.close()}
        }
    }
    @Test fun verifiedBoundedDiskCacheColdWarmCorruptionAndPrivateRejection()=runBlocking {
        val file=File.createTempFile("public-profiles",".json");file.delete()
        try{val a=event();val b=event(2);val cache=ProfileEventCache(file,1)
            assertTrue(cache.accept(a));assertFalse(cache.accept(a.copy(content="forged")));assertFalse(cache.accept(a.copy(kind=30078)))
            assertTrue(ProfileEventCache(file).get(a.pubkey)!!.verified());assertTrue(cache.accept(b));assertNull(cache.get(a.pubkey));assertNull(ProfileEventCache(file).get(a.pubkey))
            val loader=ProfileLoader(ProfileEventCache(file),primary=emptyList(),lookup=emptyList(),bufferMs=5)
            try{assertEquals(b.id,loader.observe(b.pubkey).first().event!!.id)}finally{loader.close()}
            file.writeText(array(listOf(a.json().put("sig","0".repeat(128)),b.json())).toString())
            assertNull(ProfileEventCache(file).get(a.pubkey));assertEquals(b.id,ProfileEventCache(file).get(b.pubkey)!!.id)
        }finally{file.delete()}
    }
    @Test fun lastSubscriberCancellationClosesSharedBatchAndAllowsFreshRoom()=runBlocking {
        val a=event();Relay{_,_->}.use{relay->val loader=ProfileLoader(primary=listOf(relay.url),lookup=emptyList(),stageMs=2000,bufferMs=1)
            try{val one=launch{loader.observe(a.pubkey).collect()};val two=launch{loader.observe(a.pubkey).collect()}
                withTimeout(1500){while(relay.requests.get()<1)delay(10)};one.cancelAndJoin();assertEquals(1,relay.requests.get());two.cancelAndJoin();delay(350)
                val fresh=launch{loader.observe(a.pubkey).collect()};withTimeout(1500){while(relay.requests.get()<2)delay(10)};fresh.cancelAndJoin()
                assertTrue(relay.connections.get()>=2)
            }finally{loader.close()}
        }
    }
}
