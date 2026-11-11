package ai.otherstuff.word5

import fr.acinq.secp256k1.Secp256k1
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.Base64

/** Consuming signed backup/CAS fixture; disposable signer is not real Amber or NIP-44 proof. */
class CorrectionBackupTest {
    private class Signer(byte: Byte): NativeSigner {
        val key=ByteArray(32) { byte }
        val owner=Secp256k1.pubkeyCreate(key).copyOfRange(1,33).joinToString("") { "%02x".format(it) }
        override suspend fun sign(event: Event) = event.copy(id=event.hash(),sig=Secp256k1.signSchnorr(unhex(event.hash()),key,ByteArray(32)).joinToString("") { "%02x".format(it) })
        override suspend fun encrypt(owner: String,text: String) = Base64.getEncoder().encodeToString((owner+text).toByteArray())
        override suspend fun decrypt(owner: String,text: String): String { val raw=String(Base64.getDecoder().decode(text)); require(raw.startsWith(owner)); return raw.removePrefix(owner) }
    }
    private val rules=Rules(File("src/main/assets/answers.txt").readLines().filter { it.length==5 },File("src/main/assets/wla.txt").readLines())
    @Test fun signedNativeSummaryAnchorReplaysRestoredPrivateGames() = runBlocking {
        val player=Signer(13); val server=Signer(14); val day=Rules.period(); val cutoff=day-4
        val privateState=State(mapOf(cutoff+1 to Game(cutoff+1,outcome=2),cutoff+3 to Game(cutoff+3,outcome=2)))
        val stored=player.sign(Event(player.owner,System.currentTimeMillis()/1000,30078,Codec.tags,
            player.encrypt(player.owner,pack(Codec.encode(privateState,player.owner)))))
        val history=JSONObject().put("ok",true).put("pubkey",player.owner).put("periodId",day).put("lastPeriodId",day).put("currentResult","2")
            .put("outcomes",JSONArray(listOf(JSONArray(listOf(cutoff+2,2)),JSONArray(listOf(day,2)))))
            .put("coveredPeriods",JSONArray(listOf(cutoff+2,day))).put("distribution",JSONArray(listOf(0,2,0,0,0,0)))
            .put("stats",JSONObject().put("played",2).put("won",2).put("streak",1).put("maxStreak",1))
            .put("correctionEventId","ab".repeat(32)).put("correctionCreatedAt",cutoff*86400+100)
            .put("correctionAnchor",JSONObject().put("streak",0).put("maxStreak",0).put("lastPeriod",cutoff).put("covered",JSONArray()))
        val transport:suspend(String,JSONObject)->JSONObject={_,wire->
            val auth=Event.parse(wire.getJSONObject("auth"));assertTrue(auth.verified());assertEquals(player.owner,auth.pubkey)
            val response=JSONObject().put("event",stored.json()).put("history",history)
            JSONObject().put("event",server.sign(Event(server.owner,System.currentTimeMillis()/1000,27235,
                listOf(listOf("request",auth.id),listOf("p",auth.pubkey),listOf("schema","word5.backup-response.v1")),response.toString())).json())
        }
        val restored=Backup(player,rules,server.owner,transport).fetch(player.owner).state
        assertEquals(privateState.games,restored.games)
        assertEquals(CorrectionAnchor(0,0,cutoff),restored.baseline!!.correctionAnchor)
        assertEquals(4,statistics(restored,rules).streak);assertEquals(4,statistics(restored,rules).best)
        assertEquals(4,statistics(restored,rules).played)
        val saved=Codec.decode(unpack(pack(Codec.encode(restored,player.owner))),player.owner,rules)
        assertEquals(4,statistics(saved,rules).streak)
    }
    @Test fun freshServerRestoreAndStaleUploadConflictPreservePrivateCorrection() = runBlocking {
        val player=Signer(11); val server=Signer(12); var stored: Event?=null
        val transport: suspend(String,JSONObject)->JSONObject = { _, wire ->
            val auth=Event.parse(wire.getJSONObject("auth")); assertTrue(auth.verified()); assertEquals(player.owner,auth.pubkey)
            val body=wire.getJSONObject("body")
            val response=if(body.has("event")) {
                val previous=if(body.isNull("previous")) null else body.getString("previous")
                if(previous!=stored?.id) JSONObject().put("conflict",true).put("event",stored?.json())
                else { stored=Event.parse(body.getJSONObject("event")).also { Codec.validateBackup(it,player.owner) }; JSONObject().put("event",stored!!.json()) }
            } else JSONObject().put("event",stored?.json() ?: JSONObject.NULL).put("history",JSONObject()
                .put("ok",true).put("pubkey",player.owner).put("periodId",Rules.period()).put("lastPeriodId",JSONObject.NULL).put("currentResult",JSONObject.NULL)
                .put("outcomes",JSONArray()).put("coveredPeriods",JSONArray()).put("distribution",JSONArray(List(6){0}))
                .put("stats",JSONObject().put("played",0).put("won",0).put("streak",0).put("maxStreak",0)))
            JSONObject().put("event",server.sign(Event(server.owner,System.currentTimeMillis()/1000,27235,listOf(listOf("request",auth.id),listOf("p",auth.pubkey),listOf("schema","word5.backup-response.v1")),response.toString())).json())
        }
        val client=Backup(player,rules,server.owner,transport)
        val day=Rules.period()
        val initial=State((day-3..day).associateWith { Game(it,outcome=2) })
        assertTrue(client.upload(player.owner,null,initial))
        val stale=client.fetch(player.owner)
        val counters=JSONObject().put("played",4).put("won",4).put("streak",1).put("maxStreak",2)
        val event=player.sign(Event(player.owner,System.currentTimeMillis()/1000,5555,
            listOf(listOf("t","word5"),listOf("game","word5"),listOf("schema","word5.stats.v1"),listOf("type","stats-correction"),listOf("streak","1"),listOf("maxStreak","2"),listOf("played","4"),listOf("won","4"),listOf("version","1"),listOf("previousStreak","4"),listOf("previousMaxStreak","4")),
            JSONObject().put("game","word5").put("type","stats-correction").put("stats",counters).put("version",1).toString()))
        val corrected=Corrections.applyCorrection(stale.state,event,player.owner,rules)
        assertTrue(client.upload(player.owner,stale.event,corrected))
        assertFalse(client.upload(player.owner,stale.event,initial))
        val fresh=Backup(player,rules,server.owner,transport).fetch(player.owner)
        assertEquals(corrected.correction,fresh.state.correction)
        assertEquals(initial.games,fresh.state.games)
        assertEquals(4,statistics(fresh.state,rules).played); assertEquals(4,statistics(fresh.state,rules).won)
        assertEquals(1,statistics(fresh.state,rules).streak); assertEquals(2,statistics(fresh.state,rules).best)
        val reconciled=merge(initial,fresh.state,rules)
        assertEquals(corrected.correction,reconciled.correction)
        assertTrue(client.upload(player.owner,fresh.event,reconciled))
        assertEquals(1,statistics(client.fetch(player.owner).state,rules).streak)
    }
}
