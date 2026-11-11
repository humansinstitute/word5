package ai.otherstuff.word5

import org.junit.Test
import org.junit.Assert.*
import java.io.File

class GameTest {
    private val answers = File("src/main/assets/answers.txt").readLines().map { it.trim() }.filter { it.length == 5 }
    private val rules = Rules(answers, File("src/main/assets/wla.txt").readLines())
    @Test fun dailyMatchesBrowserAcrossRollover() {
        mapOf(19000L to "DRAKE",19999L to "BLOKE",20000L to "SURLY",20746L to "SNUCK",20768L to "JOKER",20999L to "TRUTH",21000L to "MOLAR",22000L to "MIRTH").forEach { (period,word) -> assertEquals(word,rules.answer(period)) }
    }
    @Test fun duplicateLetterAndHardMode() {
        assertEquals(listOf(0,0,0,1,2), Rules.evaluate("ALLEY", "BERRY"))
        assertNotNull(rules.hardError(listOf("JOKER"),"CRANE","JOKER"))
        assertNull(rules.hardError(listOf("CRANE"),"JOKER","JOKER"))
    }
    @Test fun completedServerOutcomeCannotImprove() {
        val p=20768L
        val loss=Game(p,List(6){"CRANE"})
        val win=Game(p,listOf("JOKER"))
        val merged=merge(State(mapOf(p to win)),State(mapOf(p to loss)),rules)
        assertEquals(loss,merged.games[p]); assertEquals(0,statistics(merged,rules,p).won)
    }
    @Test fun unfinishedMergeIsDeterministicAndPreservesOtherPeriods() {
        val a=State(mapOf(20768L to Game(20768,listOf("CRANE"))))
        val b=State(mapOf(20768L to Game(20768,listOf("SLATE","CRANE")),20746L to Game(20746,listOf("SNUCK"))))
        assertEquals(merge(a,b,rules),merge(b,a,rules))
        assertEquals(2,merge(a,b,rules).games.size)
        assertEquals(2,merge(a,b,rules).games[20768L]!!.guesses.size)
    }
    @Test fun baselineDoesNotDoubleCountAndStreakExpires() {
        val base=Baseline(20768,100,90,10,30,20768,"1",listOf(20768))
        val saved=State(mapOf(20768L to Game(20768,listOf("JOKER"))),baseline=base)
        assertEquals(100,statistics(saved,rules,20768).played)
        assertEquals(10,statistics(saved,rules,20769).streak)
        assertEquals(0,statistics(saved,rules,20770).streak)
    }
    @Test fun strictSchemaAccountAndGuessValidation() {
        val state=State(mapOf(20768L to Game(20768,listOf("CRANE"))))
        val text=Codec.encode(state,"a".repeat(64))
        assertEquals(state,Codec.decode(text,"a".repeat(64),rules))
        assertThrows(IllegalArgumentException::class.java) { Codec.decode(text,"b".repeat(64),rules) }
        assertThrows(IllegalArgumentException::class.java) { Codec.decode(text.replace("CRANE","ZZZZZ"),"a".repeat(64),rules) }
        assertThrows(IllegalArgumentException::class.java) { Codec.decode(text.dropLast(1)+",\"unexpected\":true}","a".repeat(64),rules) }
    }
    @Test fun tenThousandGamesRetainAllStatsWithinNip44Limit() {
        val random = kotlin.random.Random(42)
        val state=State((10000L until 20000L).associateWith { Game(it, outcome=random.nextInt(1,8), hard=random.nextBoolean()) })
        val archived=compact(state,rules)
        val encoded=Codec.encode(archived,"a".repeat(64)); val compressed=pack(encoded)
        assertTrue(compressed.toByteArray().size < 60000)
        val restored=Codec.decode(unpack(compressed),"a".repeat(64),rules)
        assertEquals(archived,restored); assertEquals(10000,statistics(restored,rules,20000).played)
        assertEquals(state.games.values.count { rules.won(it) },statistics(restored,rules,20000).won)
    }

    @Test fun archivedCompletionRemainsImmutableAgainstFullForm() {
        val archived=Game(20746,hard=true,outcome=7)
        val local=Game(20746,listOf("SNUCK"),hard=true)
        assertEquals(archived,merge(State(mapOf(20746L to local)),State(mapOf(20746L to archived)),rules).games[20746L])
    }
    @Test fun baselineCountsOfflineGamesMissingFromServerWithoutDuplicatingCoveredOnes() {
        val baseline=Baseline(20768,100,90,10,30,20768,"1",listOf(20768),listOf(10,20,30,20,5,5))
        val state=State(mapOf(20768L to Game(20768,listOf("JOKER")),20746L to Game(20746,listOf("SNUCK"))),baseline=baseline)
        val stats=statistics(state,rules,20768)
        assertEquals(101,stats.played); assertEquals(91,stats.won)
        assertEquals(91,stats.distribution.sum()); assertEquals(10,stats.streak)
    }
    @Test fun npubOnlyAndHexAmberAccountsAreAccepted() {
        assertEquals("01".repeat(32),amberPublicKey("npub1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs8j9gdm"))
        assertEquals("ab".repeat(32),amberPublicKey("AB".repeat(32)))
        assertThrows(IllegalArgumentException::class.java) { amberPublicKey("npub1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs8j9gdq") }
        assertThrows(IllegalArgumentException::class.java) { amberPublicKey("nsec1invalid") }
    }

    @Test fun liveWebBaselineAdvancesWithoutLosingNativeOnlyHistory() {
        val old=Baseline(20768,10,9,2,5,20767,null,listOf(20767),listOf(1,2,2,2,1,1),mapOf(20767L to 1))
        val fresh=old.copy(played=11,won=10,streak=3,lastPeriod=20768,todayResult="2",covered=listOf(20767,20768),distribution=listOf(1,3,2,2,1,1),outcomes=mapOf(20767L to 1,20768L to 2))
        val native=State(mapOf(20746L to Game(20746,outcome=3)),baseline=old)
        val updated=native.copy(baseline=refreshBaseline(native.baseline,fresh))
        assertEquals(12,statistics(updated,rules,20768).played)
        assertEquals(11,statistics(updated,rules,20768).won)
        assertEquals(3,statistics(updated,rules,20768).streak)
        assertEquals(old,refreshBaseline(old,Baseline(20768,0,0,0,0,null)))
        val correction=fresh.copy(played=8,won=7,streak=1,maxStreak=4,correction="ab".repeat(32),correctionCreated=1000)
        assertEquals(correction,refreshBaseline(old,correction))
    }

    @Test fun olderCorrectionCannotRollbackNewerEncryptedBaseline() {
        val saved=Baseline(Rules.period(),100,90,10,30,Rules.period(),"2",correction="bb".repeat(32),correctionCreated=2000)
        val stale=saved.copy(played=10,won=9,streak=1,correction="aa".repeat(32),correctionCreated=1000)
        assertEquals(saved,refreshBaseline(saved,stale))
        val newer=stale.copy(correction="cc".repeat(32),correctionCreated=3000)
        assertEquals(newer,refreshBaseline(saved,newer))
    }
    @Test fun alternatingNativeAndWebWinsFormOneFourDayStreak() {
        val today=Rules.period()
        val baseline=Baseline(today,2,2,1,1,today,"2",listOf(today-2,today),listOf(0,2,0,0,0,0),mapOf(today-2 to 2,today to 2))
        val state=State(mapOf(today-3 to Game(today-3,outcome=3),today-1 to Game(today-1,outcome=4)),baseline=baseline)
        val stats=statistics(state,rules,today)
        assertEquals(4,stats.played); assertEquals(4,stats.won); assertEquals(4,stats.streak); assertEquals(4,stats.best)
        assertEquals(listOf(0,2,1,1,0,0),stats.distribution)
    }
}
