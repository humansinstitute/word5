package ai.otherstuff.word5

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** No relay/client/signer is constructed: every public transport is a recording fixture. */
class SocialPublicationTest {
    private val left=SocialIdentity("a".repeat(64),"Alice","alice@example.com","")
    private val right=SocialIdentity("b".repeat(64),"Bob","bob@example.com","")
    @Test fun explicitChallengeRendersUploadsSignsAndPublishesExactlyOnce()=runBlocking {
        val calls=mutableListOf<String>();val bytes=byteArrayOf(1,2,3);var signed:Event?=null
        val result=publishDuelChallenge(left.pubkey,123,left,right,15,10,
            {calls+="render";bytes},
            {actual->calls+="upload";assertArrayEquals(bytes,actual);"https://blossom.example/card.png"},
            {event->calls+="sign";assertEquals("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",event.tags.first{it[0]=="imeta"}[2].removePrefix("x "));signed=event;event},
            {event->calls+="publish";assertSame(signed,event)})
        assertSame(signed,result);assertEquals(listOf("render","upload","sign","publish"),calls)
    }
    @Test fun failedUploadDoesNotSignOrPublish()=runBlocking {
        val calls=mutableListOf<String>()
        try{publishDuelChallenge(left.pubkey,123,left,right,1,2,{byteArrayOf(1)},{calls+="upload";error("Upload failed")},{calls+="sign";it},{calls+="publish"});fail("Expected upload failure")}catch(e:IllegalStateException){assertEquals("Upload failed",e.message)}
        assertEquals(listOf("upload"),calls)
    }
    @Test fun amberCancellationDoesNotPublishOrRetry()=runBlocking {
        val calls=mutableListOf<String>()
        try{publishDuelChallenge(left.pubkey,123,left,right,1,2,{byteArrayOf(1)},{"https://example.com/image.png"},{calls+="sign";throw CancellationException("Amber declined")},{calls+="publish"});fail("Expected cancellation")}catch(e:CancellationException){assertEquals("Amber declined",e.message)}
        assertEquals(listOf("sign"),calls)
    }
    @Test fun unrelatedAccountCannotRenderOrUpload()=runBlocking {
        val calls=mutableListOf<String>()
        try{publishDuelChallenge("c".repeat(64),123,left,right,1,2,{calls+="render";byteArrayOf(1)},{calls+="upload";"https://example.com/image.png"},{it},{});fail("Expected account rejection")}catch(_:IllegalArgumentException){}
        assertTrue(calls.isEmpty())
    }
}
