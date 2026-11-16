package ai.otherstuff.word5

import fr.acinq.secp256k1.Secp256k1
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class CorrectionTest {
    private val rules = Rules(File("src/main/assets/answers.txt").readLines().filter { it.length == 5 }, File("src/main/assets/wla.txt").readLines())
    private val day = Rules.period()
    private val time = System.currentTimeMillis() / 1000 - 5
    private val key = ByteArray(32) { 7 }
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
    private val owner = hex(Secp256k1.pubkeyCreate(key).copyOfRange(1, 33))
    private fun sign(event: Event) = event.copy(id = event.hash(), sig = hex(Secp256k1.signSchnorr(unhex(event.hash()), key, ByteArray(32))))
    private fun state(todayComplete: Boolean = true) = State((day-4..if(todayComplete) day else day-1).associateWith { Game(it, outcome = 2) })
    private fun event(state: State, current: Int = 1, best: Int = 2, created: Long = time): Event {
        val old = statistics(state, rules)
        val stats = JSONObject().put("played", old.played).put("won", old.won).put("streak", current).put("maxStreak", best)
        return sign(Event(owner, created, 5555, listOf(listOf("t", "word5"), listOf("game", "word5"), listOf("schema", "word5.stats.v1"), listOf("type", "stats-correction"), listOf("streak", "$current"), listOf("maxStreak", "$best"), listOf("played", "${old.played}"), listOf("won", "${old.won}"), listOf("version", "1"), listOf("previousStreak", "${old.streak}"), listOf("previousMaxStreak", "${old.best}")), JSONObject().put("game", "word5").put("type", "stats-correction").put("stats", stats).put("version", 1).toString()))
    }
    private fun apply(state: State, current: Int = 1, best: Int = 2) = Corrections.applyCorrection(state, event(state, current, best), owner, rules)
    private fun rejected(block: () -> Unit) { assertThrows(IllegalArgumentException::class.java, block) }

    @Test fun explicitLoweringPreservesAllOutcomesTotalsAndDistribution() {
        val raw = state(); val corrected = apply(raw)
        assertEquals(raw.games, corrected.games)
        val before = statistics(raw, rules); val after = statistics(corrected, rules)
        assertEquals(before.played, after.played); assertEquals(before.won, after.won); assertEquals(before.distribution, after.distribution)
        assertEquals(1, after.streak); assertEquals(2, after.best)
        assertEquals(0, statistics(apply(raw, 0, 0), rules).best)
        assertEquals(3, statistics(apply(raw, 3, 3), rules).streak)
        assertEquals(5, statistics(apply(raw, 1, 5), rules).best)
    }
    @Test fun bestAloneCanBeLoweredWithoutChangingCurrent() {
        val raw=State(((day-20..day-14) + (day-2..day)).associateWith { Game(it,outcome=2) })
        assertEquals(3,statistics(raw,rules).streak); assertEquals(7,statistics(raw,rules).best)
        val corrected=apply(raw,3,4)
        assertEquals(3,statistics(corrected,rules).streak); assertEquals(4,statistics(corrected,rules).best)
        assertEquals(raw.games,corrected.games)
    }
    @Test fun correctionBeforeTodayCompletionCountsItOnceAndAfterDoesNotReplayIt() {
        val unfinished = state(false).with(Game(day, listOf("CRANE")))
        val corrected = apply(unfinished)
        assertFalse(day in corrected.correction!!.covered)
        assertEquals(2, statistics(corrected.with(Game(day, outcome = 3)), rules).streak)
        assertEquals(0, statistics(corrected.with(Game(day, outcome = 7)), rules).streak)
        val after = apply(state())
        assertTrue(day in after.correction!!.covered)
        assertEquals(1, statistics(after, rules).streak)
        assertEquals(5, statistics(after, rules).played)
    }
    @Test fun nextDayWinsLossesAndGapsAdvanceCorrectedCounters() {
        val corrected = apply(state())
        val next = corrected.with(Game(day+1, outcome=1))
        assertEquals(2, statistics(next, rules, day+1).streak)
        val third = next.with(Game(day+2, outcome=3))
        assertEquals(3, statistics(third, rules, day+2).best)
        val loss = third.with(Game(day+3, outcome=7))
        assertEquals(0, statistics(loss, rules, day+3).streak)
        assertEquals(3, statistics(loss, rules, day+3).best)
        assertEquals(0, statistics(corrected, rules, day+2).streak)
        assertEquals(1, statistics(corrected.with(Game(day+2, outcome=2)), rules, day+2).streak)
    }
    @Test fun strictV2PackRestoreAndV1MigrationKeepCorrectionEvidence() {
        val corrected = apply(state())
        val encoded = Codec.encode(corrected, owner)
        assertEquals("word5.native-backup.v2", JSONObject(encoded).getString("schema"))
        val restored = Codec.decode(unpack(pack(encoded)), owner, rules)
        assertEquals(corrected, restored); assertEquals(1, statistics(merge(State(), restored, rules), rules).streak)
        val legacy = JSONObject(Codec.encode(state(), owner)).put("schema", Codec.LEGACY_SCHEMA).also { it.remove("correctionOverlay") }
        assertEquals(state(), Codec.decode(legacy.toString(), owner, rules))
        rejected { Codec.decode(JSONObject(encoded).put("schema", "word5.native-backup.v3").toString(), owner, rules) }
        rejected { Codec.decode(JSONObject(encoded).put("schema", Codec.LEGACY_SCHEMA).toString(), owner, rules) }
        rejected { Codec.decode(encoded, "aa".repeat(32), rules) }
    }
    @Test fun staleDeviceAndCasStyleMergeCannotUndoNewerCorrection() {
        val raw = state(); val first = apply(raw, 2, 3)
        val secondEvent = event(first, 1, 2, time+1)
        val second = Corrections.applyCorrection(first, secondEvent, owner, rules)
        for (merged in listOf(merge(first, second, rules), merge(second, first, rules), merge(raw, second, rules), merge(second, raw, rules))) {
            assertEquals(second.correction, merged.correction)
            assertEquals(1, statistics(merged, rules).streak)
        }
        rejected { Corrections.applyCorrection(second, first.correction!!.event, owner, rules) }
        val a = apply(raw, 1, 3); val b = apply(raw, 2, 3)
        val expected = listOf(a, b).maxBy { it.correction!!.event.id }.correction
        assertEquals(expected, merge(a, b, rules).correction); assertEquals(expected, merge(b, a, rules).correction)
    }
    @Test fun newerWebCorrectionSupersedesOverlayButOldOrUnexplainedBaselinesCannot() {
        val corrected = apply(state(), 2, 3); val signed = corrected.correction!!.event
        val old = Baseline(day, 0, 0, 0, 0, null)
        assertEquals(2, statistics(corrected.copy(baseline=old), rules).streak)
        val stale = Baseline(day, 5, 5, 4, 5, day, covered=(day-4..day).toList(), distribution=listOf(0,5,0,0,0,0), outcomes=(day-4..day).associateWith { 2 }, correction="ff".repeat(32), correctionCreated=time-1)
        assertEquals(2, statistics(corrected.copy(baseline=stale), rules).streak)
        val fresh = stale.copy(streak=1, maxStreak=1, correctionCreated=time+1, correctionAnchor=CorrectionAnchor(1,1,day,setOf(day)))
        assertEquals(1, statistics(corrected.copy(baseline=fresh), rules).streak)
        assertEquals(1, statistics(corrected.copy(baseline=fresh), rules).best)
        val same = stale.copy(streak=2, maxStreak=3, correction=signed.id, correctionCreated=signed.created)
        assertEquals(2, statistics(corrected.copy(baseline=same), rules).streak)
        val lowTie = same.copy(streak=1, maxStreak=1, correction="00".repeat(32))
        assertEquals(2, statistics(corrected.copy(baseline=lowTie), rules).streak)
        val highTie = same.copy(streak=1, maxStreak=1, correction="ff".repeat(32))
        assertEquals(1, statistics(corrected.copy(baseline=highTie), rules).streak)
    }
    @Test fun interleavedWebNativeOutcomesRemainDeduplicatedAcrossCorrection() {
        val web = Baseline(day, 2, 2, 1, 1, day, covered=listOf(day-2, day), distribution=listOf(0,2,0,0,0,0), outcomes=mapOf(day-2 to 2, day to 2))
        val raw = State(mapOf(day-3 to Game(day-3, outcome=3), day-1 to Game(day-1, outcome=4), day to Game(day, outcome=2)), baseline=web)
        val corrected = apply(raw)
        assertEquals(4, statistics(corrected, rules).played)
        assertEquals(listOf(0,2,1,1,0,0), statistics(corrected, rules).distribution)
        val advanced = web.copy(through=day+2, played=3, won=3, streak=1, lastPeriod=day+2, covered=web.covered + (day+2), outcomes=web.outcomes + (day+2 to 2), distribution=listOf(0,3,0,0,0,0))
        val next = corrected.with(Game(day+1, outcome=3)).copy(baseline=advanced)
        assertEquals(6, statistics(next, rules, day+2).played)
        assertEquals(3, statistics(next, rules, day+2).streak)
        assertEquals(3, statistics(next, rules, day+2).best)
    }
    @Test fun publicCorrectionReplaysInterleavedFuturePrivateAndPublicWins() {
        val cutoff = day - 4
        val base = Baseline(day, 2, 2, 1, 1, day,
            covered=listOf(cutoff+2, cutoff+4), distribution=listOf(0,2,0,0,0,0),
            outcomes=mapOf(cutoff+2 to 2, cutoff+4 to 2),
            correction="aa".repeat(32), correctionCreated=cutoff*86400+100,
            correctionAnchor=CorrectionAnchor(0,0,cutoff))
        val raw = State(mapOf(cutoff+1 to Game(cutoff+1,outcome=2), cutoff+3 to Game(cutoff+3,outcome=2)), baseline=base)
        assertEquals(4, statistics(raw,rules).played)
        assertEquals(4, statistics(raw,rules).streak)
        assertEquals(4, statistics(raw,rules).best)
        val restored=Codec.decode(unpack(pack(Codec.encode(raw,owner))),owner,rules)
        assertEquals(4,statistics(merge(State(),restored,rules),rules).streak)
        assertEquals(raw.games,restored.games)
    }
    @Test fun importedAnchorKeepsExactSeedAndDoesNotReconstructPreCorrectionTruth() {
        val cutoff=day-4
        val old=(cutoff-9..cutoff).associateWith { Game(it,outcome=2) }
        val base=Baseline(day,12,12,1,3,day,covered=(cutoff-9..cutoff).toList()+listOf(cutoff+2,day),
            outcomes=(cutoff-9..cutoff).associateWith { 2 }+mapOf(cutoff+2 to 2,day to 2),
            correction="ab".repeat(32),correctionCreated=cutoff*86400+100,
            correctionAnchor=CorrectionAnchor(2,3,cutoff,setOf(cutoff)))
        val raw=State(old+mapOf(cutoff+1 to Game(cutoff+1,outcome=2),cutoff+3 to Game(cutoff+3,outcome=2)),baseline=base)
        assertEquals(6,statistics(raw,rules).streak); assertEquals(6,statistics(raw,rules).best)
        assertEquals(0,statistics(raw.with(Game(day+1,outcome=7)),rules,day+1).streak)
        assertEquals(6,statistics(raw.with(Game(day+1,outcome=7)),rules,day+1).best)
        assertEquals(1,statistics(raw.with(Game(day+2,outcome=2)),rules,day+2).streak)
        assertEquals(raw,Codec.decode(unpack(pack(Codec.encode(raw,owner))),owner,rules))
        val advanced=base.copy(through=day,correctionAnchor=null)
        assertEquals(base.correctionAnchor,refreshBaseline(base,advanced).correctionAnchor)
        val newer=base.copy(correction="ff".repeat(32),correctionCreated=base.correctionCreated!!+1,correctionAnchor=CorrectionAnchor(0,0,cutoff,setOf(cutoff)))
        assertEquals(4,statistics(raw.copy(baseline=refreshBaseline(base,newer)),rules).streak)
    }
    @Test fun importedAnchorUsesExplicitBoundaryCoverageRatherThanLastPeriodInference() {
        val base=Baseline(day,5,5,1,2,day,covered=listOf(day),outcomes=mapOf(day to 2),
            correction="ab".repeat(32),correctionCreated=day*86400+100,
            correctionAnchor=CorrectionAnchor(1,2,day-1))
        assertEquals(2,statistics(State(baseline=base),rules).streak)
        assertEquals(1,statistics(State(baseline=base.copy(correctionAnchor=CorrectionAnchor(1,2,day,setOf(day)))),rules).streak)
        // Server may seed an empty archive at the correction day; that is not a covered completion.
        val synthetic=base.copy(correctionAnchor=CorrectionAnchor(0,0,day))
        assertEquals(1,statistics(State(baseline=synthetic),rules).streak)
        assertEquals(0,statistics(State(baseline=synthetic.copy(outcomes=mapOf(day to 7))),rules).streak)
    }
    @Test fun anchorCodecMigratesOldBaselinesAndRejectsInvalidSeeds() {
        val base=Baseline(day,5,5,1,2,day,covered=listOf(day),outcomes=mapOf(day to 2),
            correction="ab".repeat(32),correctionCreated=day*86400+100,correctionAnchor=CorrectionAnchor(1,2,day,setOf(day)))
        val encoded=Codec.encode(State(baseline=base),owner)
        fun changed(edit:(JSONObject)->Unit):String {val j=JSONObject(encoded);edit(j.getJSONObject("baseline").getJSONObject("correctionAnchor"));return j.toString()}
        rejected { Codec.decode(changed{it.put("streak",1.5)},owner,rules) }
        rejected { Codec.decode(changed{it.put("maxStreak",6)},owner,rules) }
        rejected { Codec.decode(changed{it.put("covered",JSONArray(listOf(day,day)))},owner,rules) }
        rejected { Codec.decode(changed{it.put("covered",JSONArray(listOf(day-1)))},owner,rules) }
        rejected { Codec.decode(changed{it.put("lastPeriod",day-1)},owner,rules) }
        rejected { Codec.decode(changed{it.put("unexpected",0)},owner,rules) }
        rejected { Codec.decode(JSONObject(encoded).also{it.getJSONObject("baseline").put("correction",JSONObject.NULL).put("correctionCreated",JSONObject.NULL)}.toString(),owner,rules) }
        val old=JSONObject(encoded).also{it.getJSONObject("baseline").remove("correctionAnchor")}
        assertNull(Codec.decode(old.toString(),owner,rules).baseline!!.correctionAnchor)
        old.put("schema",Codec.LEGACY_SCHEMA).remove("correctionOverlay")
        assertNull(Codec.decode(old.toString(),owner,rules).baseline!!.correctionAnchor)
        // Unavailable seeds preserve authenticated legacy counters without inferring correction0/0.
        val legacy=State(baseline=base.copy(correctionAnchor=null))
        assertEquals(1,statistics(legacy,rules).streak); assertEquals(2,statistics(legacy,rules).best)
        rejected { Codec.decode(JSONObject(encoded).put("schema",Codec.LEGACY_SCHEMA).also{it.remove("correctionOverlay")}.toString(),owner,rules) }
    }
    @Test fun validDuplicateSignaturesAndBoundaryCoverageConverge() {
        val raw = state()
        val first = apply(raw)
        val e = first.correction!!.event
        val alternate = e.copy(sig=hex(Secp256k1.signSchnorr(unhex(e.id),key,ByteArray(32) { 1 })))
        assertNotEquals(e.sig, alternate.sig); assertTrue(alternate.verified()); assertEquals(e.id, alternate.id)
        val resigned = first.copy(correction=first.correction.copy(event=alternate))
        assertEquals(merge(first,resigned,rules).correction,merge(resigned,first,rules).correction)
        val boundaryOnly = first.copy(correction=first.correction.copy(covered=emptySet(),lastPeriod=day-1))
        assertEquals(first.correction,merge(first,boundaryOnly,rules).correction)
        val other = first.copy(correction=first.correction.copy(event=alternate, covered=emptySet(),lastPeriod=day-1))
        val left=merge(first,other,rules); val right=merge(other,first,rules)
        assertEquals(left.correction,right.correction)
        assertEquals(setOf(day),left.correction!!.covered)
        assertEquals(day,left.correction.lastPeriod)
        assertEquals(1,statistics(left,rules).streak)
        assertEquals(2,statistics(left.with(Game(day+1,outcome=2)),rules,day+1).streak)
        assertEquals(left.correction,merge(left,other,rules).correction)
        assertEquals(left,Codec.decode(unpack(pack(Codec.encode(left,owner))),owner,rules))
        rejected { merge(first,other.copy(correction=other.correction!!.copy(event=alternate.copy(sig="00".repeat(64)))),rules) }
        rejected { merge(first,other.copy(correction=other.correction!!.copy(covered=setOf(day-1))),rules) }
    }
    @Test fun signedButInvalidContractsAndChangedAmberSnapshotsAreRejected() {
        val raw = state(); val valid = event(raw)
        assertTrue(valid.verified())
        rejected { Corrections.applyCorrection(raw, valid, "ff".repeat(32), rules) }
        rejected { Corrections.applyCorrection(raw, valid.copy(content=valid.content+" "), owner, rules) }
        rejected { Corrections.applyCorrection(raw, sign(valid.copy(kind=1)), owner, rules) }
        rejected { Corrections.applyCorrection(raw, sign(valid.copy(tags=valid.tags + listOf(listOf("streak", "1")))), owner, rules) }
        rejected { Corrections.applyCorrection(raw, sign(valid.copy(tags=valid.tags.map { if(it[0]=="streak") listOf("streak","2") else it })), owner, rules) }
        rejected { Corrections.applyCorrection(raw, event(raw, 6, 6), owner, rules) }
        rejected { Corrections.applyCorrection(raw, event(raw, 3, 2), owner, rules) }
        rejected { Corrections.applyCorrection(raw, event(raw, 5, 5), owner, rules) }
        rejected { Corrections.applyCorrection(raw, event(raw, 1, 2, time+1000), owner, rules) }
        rejected { Corrections.applyCorrection(raw, event(raw, 1, 2, (day-1)*86400), owner, rules) }
        rejected { Corrections.applyCorrection(raw.with(Game(day-5, outcome=1)), valid, owner, rules) }
        val competing = apply(raw, 3, 4)
        rejected { Corrections.applyCorrection(competing, event(raw, 1, 2, time+1), owner, rules) }
        rejected { Corrections.validateLowering(statistics(raw,rules), -1, 2) }
    }
    @Test fun tamperedOverlayMetadataAndTypeBoundsCannotRestore() {
        val corrected = apply(state()); val encoded = Codec.encode(corrected, owner)
        fun changed(edit: (JSONObject)->Unit): String { val j=JSONObject(encoded); edit(j.getJSONObject("correctionOverlay")); return j.toString() }
        rejected { Codec.decode(changed { it.put("version", 2) }, owner, rules) }
        rejected { Codec.decode(changed { it.put("previousBest", 100001) }, owner, rules) }
        rejected { Codec.decode(changed { it.put("covered", JSONArray(listOf(day+1))) }, owner, rules) }
        rejected { Codec.decode(changed { it.put("covered", JSONArray(listOf(day,day))) }, owner, rules) }
        rejected { Codec.decode(changed { it.put("lastPeriod", day-1) }, owner, rules) }
        rejected { Codec.decode(changed { it.put("unexpected", 1) }, owner, rules) }
        rejected { Codec.decode(changed { it.getJSONObject("event").put("sig", "00".repeat(64)) }, owner, rules) }
        rejected { merge(corrected, corrected.copy(correction=corrected.correction!!.copy(previousBest=100001)), rules) }
        rejected { Event.parse(event(state()).json().put("kind", 4294972851L)) }
        rejected { unpack(pack("x".repeat(2000001))) }
        val tooMany=JSONObject(Codec.encode(State(),owner)).put("games",JSONArray((0..10000).map { JSONArray(listOf(it,false,2)) }))
        rejected { Codec.decode(tooMany.toString(),owner,rules) }
    }
    @Test fun tenThousandCorrectedOutcomesFitTransportAndKeepEveryResult() {
        val random = kotlin.random.Random(42)
        val raw = State((day-9999..day).associateWith { Game(it, hard=random.nextBoolean(), outcome=if(it >= day-3) 2 else random.nextInt(1,8)) })
        val corrected=apply(raw, 1, 2)
        val packed=pack(Codec.encode(corrected,owner))
        assertTrue(packed.toByteArray().size <= 60000)
        val restored=Codec.decode(unpack(packed),owner,rules)
        assertEquals(raw.games,restored.games); assertEquals(10000,statistics(restored,rules).played)
        assertEquals(1,statistics(restored,rules).streak)
    }
}
