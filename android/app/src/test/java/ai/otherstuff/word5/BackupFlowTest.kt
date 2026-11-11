package ai.otherstuff.word5

import org.junit.Test
import org.junit.Assert.*
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import fr.acinq.secp256k1.Secp256k1
import java.io.File
import java.util.Base64

/** Disposable signer double exercises consuming backup; it is not physical Amber evidence. */
class BackupFlowTest {
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
    private class Signer(val byte: Int): NativeSigner {
        val key = ByteArray(32) { byte.toByte() }
        val owner = Secp256k1.pubkeyCreate(key).copyOfRange(1,33).joinToString("") { "%02x".format(it) }
        override suspend fun sign(event: Event): Event = event.copy(id=event.hash(),sig=Secp256k1.signSchnorr(unhex(event.hash()),key,ByteArray(32)).joinToString("") { "%02x".format(it) })
        override suspend fun encrypt(owner: String,text: String) = Base64.getEncoder().encodeToString((owner + text).toByteArray())
        override suspend fun decrypt(owner: String,text: String): String { val raw=String(Base64.getDecoder().decode(text)); require(raw.startsWith(owner)); return raw.removePrefix(owner) }
    }
    private val rules = Rules(File("src/main/assets/answers.txt").readLines().filter { it.length==5 },File("src/main/assets/wla.txt").readLines())
    @Test fun newInstallRestoresHistoryAndProgressAndCasMergesWithoutBlankOverwrite() = runBlocking {
        val player=Signer(1); val server=Signer(2); val store=mutableMapOf<String,Event>(); var webAdded=false
        val transport: suspend(String,JSONObject)->JSONObject = { url,wire ->
            val auth=Event.parse(wire.getJSONObject("auth")); assertTrue(auth.verified())
            val body=wire.getJSONObject("body")
            assertEquals(listOf("u",url),auth.tags[0]); assertEquals(listOf("payload",sha256(body.toString().replace("\\/", "/"))),auth.tags[2]); assertEquals("nonce",auth.tags[3][0])
            val old=store[auth.pubkey]
            val response=if(url.endsWith("write")) {
                val previous=if(body.isNull("previous")) null else body.getString("previous")
                if(previous != old?.id) JSONObject().put("conflict",true).put("event",old?.json() ?: JSONObject.NULL)
                else { val e=Event.parse(body.getJSONObject("event")); Codec.validateBackup(e,auth.pubkey); store[auth.pubkey]=e; JSONObject().put("event",e.json()) }
            } else JSONObject().put("event",old?.json() ?: JSONObject.NULL).put("history",JSONObject().put("ok",true).put("pubkey",auth.pubkey).put("periodId",Rules.period()).put("lastPeriodId",JSONObject.NULL).put("currentResult",JSONObject.NULL).put("outcomes",org.json.JSONArray()).put("coveredPeriods",org.json.JSONArray()).put("distribution",org.json.JSONArray(listOf(0,0,0,0,0,0))).put("stats",JSONObject().put("played",0).put("won",0).put("streak",0).put("maxStreak",0)))
            if(webAdded && url.endsWith("read")) {
                response.getJSONObject("history").put("lastPeriodId",Rules.period()).put("currentResult","2")
                    .put("coveredPeriods",org.json.JSONArray(listOf(Rules.period())))
                    .put("outcomes",org.json.JSONArray().put(org.json.JSONArray(listOf(Rules.period(),2))))
                    .put("distribution",org.json.JSONArray(listOf(0,1,0,0,0,0)))
                    .put("stats",JSONObject().put("played",1).put("won",1).put("streak",1).put("maxStreak",1))
            }
            val envelope=server.sign(Event(server.owner,System.currentTimeMillis()/1000,27235,listOf(listOf("request",auth.id),listOf("p",auth.pubkey),listOf("schema","word5.backup-response.v1")),response.toString()))
            JSONObject().put("event",envelope.json())
        }
        val client=Backup(player,rules,server.owner,transport)
        val first=client.fetch(player.owner); assertNull(first.event)
        val completed=Game(20746,listOf("SNUCK")); val unfinished=Game(20768,listOf("CRANE"))
        val full=State(mapOf(20746L to completed,20768L to unfinished),hard=true,hardUpdated=100,baseline=first.state.baseline)
        assertTrue(client.upload(player.owner,null,full))
        val newInstall=client.fetch(player.owner)
        assertEquals(compact(full,rules),newInstall.state)
        assertEquals(compact(full,rules),merge(State(),newInstall.state,rules))
        assertFalse(client.upload(player.owner,null,State()))
        assertEquals(compact(full,rules),client.fetch(player.owner).state)
        val stale=newInstall
        val progressed=full.with(unfinished.copy(guesses=listOf("CRANE","SLATE")))
        assertTrue(client.upload(player.owner,newInstall.event,progressed))
        assertFalse(client.upload(player.owner,stale.event,full))
        assertEquals(compact(progressed,rules),client.fetch(player.owner).state)
        webAdded=true
        val webRestored=client.fetch(player.owner)
        assertEquals(2,statistics(webRestored.state,rules).played)
        assertEquals("2",webRestored.state.baseline?.todayResult)
        assertEquals(1,webRestored.state.baseline?.played)
        assertTrue(client.upload(player.owner,webRestored.event,webRestored.state))
        assertEquals(2,statistics(client.fetch(player.owner).state,rules).played)
        val other=Signer(3); val isolated=Backup(other,rules,server.owner,transport).fetch(other.owner)
        assertNull(isolated.event); assertTrue(isolated.state.games.isEmpty())
    }
    @Test fun invalidServerSignatureCannotResetLocalOrApplyBaseline() = runBlocking {
        val player=Signer(1); val server=Signer(2)
        val client=Backup(player,rules,server.owner) { _,_ -> JSONObject().put("event",Event(server.owner,System.currentTimeMillis()/1000,27235,emptyList(),"{}").json()) }
        try { client.fetch(player.owner); fail("Unsigned response accepted") } catch(_: IllegalArgumentException) { }
    }
    @Test fun offlineReadNeverAllowsWrite() = runBlocking {
        val player=Signer(1); var writes=0
        val client=Backup(player,rules,Signer(2).owner) { url,_ -> if(url.endsWith("write")) writes++; error("offline") }
        try { client.fetch(player.owner); fail("offline fetch accepted") } catch(_: IllegalStateException) { }
        assertEquals(0,writes)
    }
}
