package ai.otherstuff.word5

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject

class NativeActionsTest {
    private val rules=Rules(listOf("joker"),listOf("crane","joker"))
    private val owner="a".repeat(64)
    private val game=Game(Rules.period(),listOf("CRANE","JOKER"))
    @Test fun publicResultMatchesWebAndDoesNotLeakGuesses() {
        val state=State(games=mapOf(game.period to game))
        val event=resultPostDraft(state,rules,owner,123)
        assertEquals(1,event.kind);assertEquals("2",event.tag("result"));assertEquals(game.period.toString(),event.tag("period"))
        assertEquals("WORD5 #${game.period%1000} 2/6\n\n⬛🟧⬛⬛🟧\n🟪🟪🟪🟪🟪\n\nhttps://otherstuff.ai/word5/",event.content)
        assertFalse(event.content.contains("CRANE"));assertFalse(event.content.contains("JOKER"));assertTrue(isPublicRelayPayload(event))
    }
    @Test fun serverScoreIsNeverRelayEligibleAndStatusUsesExactContract() {
        val event=completionDraft(game,rules,owner,123)
        assertEquals("word5.completion.v1",event.tag("schema"));assertEquals("CRANE",JSONObject(event.content).getJSONArray("guesses").getString(0));assertFalse(isPublicRelayPayload(event))
        val status=completionStatusDraft(owner,game.period,123)
        assertEquals("word5.sync-status.v1",status.tag("schema"));assertEquals(setOf("periodId"),JSONObject(status.content).keys().asSequence().toSet());assertFalse(isPublicRelayPayload(status))
    }
    @Test fun relayGuardRejectsBackupAndAuthentication() {
        assertFalse(isPublicRelayPayload(Event(owner,123,30078,Codec.tags,"encrypted")))
        assertFalse(isPublicRelayPayload(Event(owner,123,27235,emptyList(),"")))
        assertFalse(isPublicRelayPayload(Event(owner,123,30078,listOf(listOf("t","word5league"),listOf("d","word5:backup:v1")),"")))
        assertTrue(isPublicRelayPayload(Event(owner,123,30078,listOf(listOf("t","word5league"),listOf("d","league1")),"")))
    }
    @Test fun incompleteAndArchivedGamesCannotInventPublicGuesses() {
        assertThrows(IllegalArgumentException::class.java){resultPostDraft(State(),rules,owner)}
        assertThrows(IllegalArgumentException::class.java){completionDraft(Game(game.period,outcome=2),rules,owner)}
        val restored=State(games=mapOf(game.period to Game(game.period,outcome=2)))
        assertEquals("2",resultPostDraft(restored,rules,owner).tag("result"));assertFalse(resultShareText(restored,rules).contains("0/6"))
        assertEquals(owner,amberPublicKey(encodeNpub(owner)))
    }
}
