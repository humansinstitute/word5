package ai.otherstuff.word5

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject

class ChatProfilesTest {
    @Test fun delayedExponentialJitterAndRecovery(){
        var now=1000L;val cache=ChatProfiles({now},{0.5});val key="a"
        val first=cache.begin(listOf(key,key),true).single()
        assertTrue(cache.finish(first,null,true));assertEquals("retry",cache.value(key).state)
        assertEquals(3000,cache.value(key).due);assertTrue(cache.begin(listOf(key),true).isEmpty())
        now=3000;val second=cache.begin(listOf(key),true).single();cache.finish(second,null,true)
        assertEquals(7000,cache.value(key).due)
        now=7000;val third=cache.begin(listOf(key),true).single();cache.finish(third,JSONObject().put("name","Alex"),false)
        assertEquals("ready",cache.value(key).state);assertEquals(0,cache.value(key).attempts)
        assertEquals(1500,ChatProfiles.backoff(1,0.0));assertEquals(2500,ChatProfiles.backoff(1,1.0))
        assertEquals(150000,ChatProfiles.backoff(100,1.0))
    }
    @Test fun missingHasShortTtlAndTransportKeepsStaleSuccess(){
        var now=0L;val c=ChatProfiles({now},{0.5})
        c.finish(c.begin(listOf("a"),true).single(),null,false)
        assertEquals("missing",c.value("a").state);assertEquals(60000,c.value("a").due)
        now=59999;assertTrue(c.begin(listOf("a"),true).isEmpty())
        now=60000;c.finish(c.begin(listOf("a"),true).single(),JSONObject().put("name","Maya"),false)
        now+=600000;c.finish(c.begin(listOf("a"),true).single(),null,true)
        assertEquals("Maya",c.value("a").profile!!.getString("name"));assertEquals("retry",c.value("a").state)
        now=c.value("a").due;c.finish(c.begin(listOf("a"),true).single(),null,false)
        assertEquals("Maya",c.value("a").profile!!.getString("name"))
    }
    @Test fun concurrencyDedupOfflineAndCancelledTickets(){
        val c=ChatProfiles({0},{0.5});val keys=(1..200).map{it.toString()}
        val pending=c.begin(keys+keys,true);assertEquals(3,pending.size)
        assertTrue(c.begin(keys,true).isEmpty());c.cancel()
        assertFalse(c.finish(pending[0],JSONObject(),false))
        assertTrue(c.begin(keys,false).isEmpty());assertEquals("offline",c.value("1").state)
        assertEquals(3,c.begin(keys,true).size)
        c.clear();assertFalse(c.finish(pending[1],JSONObject(),false));assertNull(c.value("1").profile)
    }
    @Test fun publishWinsOverPendingReadAndCacheIsBounded(){
        val c=ChatProfiles({0},{0.5});val read=c.begin(listOf("a"),true).single()
        c.put("a",JSONObject().put("name","New"));assertFalse(c.finish(read,JSONObject().put("name","Old"),false))
        assertEquals("New",c.value("a").profile!!.getString("name"))
        repeat(300){c.put("$it",JSONObject())};assertNull(c.value("a").profile);assertNotNull(c.value("299").profile)
    }
    @Test fun untrustedMetadataIsPlainBoundedAndOnlyHttpsPictures(){
        for(url in listOf("javascript:alert(1)","http://x/a","https://u:p@example.com/a","file:///a","https://example.com:81/a","https:///a"))assertEquals("",safeProfilePicture(url))
        assertEquals("https://example.com/a",safeProfilePicture("https://example.com/a"))
        assertNull(parseChatProfile("{}"));assertNull(parseChatProfile("broken"));assertNull(parseChatProfile("{\"name\":42,\"picture\":\"javascript:alert(1)\"}"))
        assertNotNull(parseChatProfile("{\"name\":\"Alex\"}"))
        val m=chatMember(JSONObject().put("name","<script>evil</script>").put("about","x".repeat(3000)).put("picture","javascript:alert(1)"),null,"",0)
        assertEquals("<script>evil</script>",m.name);assertEquals(2000,m.bio.length);assertEquals("",m.picture)
        val npub=encodeNpub("b".repeat(64));assertEquals("b".repeat(64),amberPublicKey(npub))
    }
}
