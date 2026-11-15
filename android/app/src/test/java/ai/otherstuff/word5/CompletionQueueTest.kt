package ai.otherstuff.word5
import org.junit.Test
import org.junit.Assert.*
import kotlinx.coroutines.runBlocking
import fr.acinq.secp256k1.Secp256k1
class CompletionQueueTest {
    private val key=ByteArray(32){1}
    private val owner=Secp256k1.pubkeyCreate(key).let{Secp256k1.pubKeyCompress(it).copyOfRange(1,33)}.joinToString(""){"%02x".format(it)}
    private fun signed(e:Event)=e.copy(id=e.hash(),sig=Secp256k1.signSchnorr(unhex(e.hash()),key,ByteArray(32)).joinToString(""){"%02x".format(it)})
    @Test fun offlineRelaunchAccountIsolationAndAckBeforeDequeue()=runBlocking {
        val disk=mutableMapOf<String,String>()
        fun queue()=CompletionQueue({disk[it]},{k,v->disk[k]=v},{disk.remove(it);Unit},{disk.keys})
        val draft=Event(owner,20770*86400L+20,30078,listOf(listOf("schema","word5.completion.v1")),"private guesses")
        queue().enqueue(draft,20770);queue().enqueue(draft.copy(content="other attempt"),20770)
        assertEquals(1,disk.size)
        queue().drain("b".repeat(64),{error("wrong account")},{error("must not send")});assertEquals(1,disk.size)
        var signatures=0
        try{queue().drain(owner,{signatures++;signed(it)},{throw IllegalStateException("offline")});fail()}catch(_:IllegalStateException){}
        assertEquals(1,disk.size);assertEquals(1,signatures)
        val stored=disk.values.single();var sent:Event?=null
        queue().drain(owner,{error("must reuse signature")},{sent=it;assertEquals(1,disk.size)})
        assertTrue(disk.isEmpty());assertEquals(stored,sent!!.json().toString());assertEquals(draft.content,sent!!.content);assertFalse(isPublicRelayPayload(sent!!))
    }
}
