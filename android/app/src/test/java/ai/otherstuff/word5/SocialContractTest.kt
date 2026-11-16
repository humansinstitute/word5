package ai.otherstuff.word5

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SocialContractTest {
    private val a="a".repeat(64);private val b="b".repeat(64);private val c="c".repeat(64)
    private fun row(pk:String=a,period:Long=20768,result:String="3",time:Long=period*86400+10,id:String="id-$pk-$period")=JSONObject().put("pubkey",pk).put("periodId",period).put("puzzle",period%1000).put("result",result).put("points",resultPoints(result)).put("createdAt",time).put("eventId",id).put("source","publication").put("relays",array(listOf("wss://relay.test")))
    @Test fun archiveShapeDoesNotRequireEventTypeOrSignatureAndKeepsProvenance(){
        // Exact production social-history shape; eventType and signedEvent are intentionally absent.
        val input=row();val output=scoreHistory(listOf(input)).single()
        assertEquals(5,output.getInt("points"));assertEquals("publication",output.getString("source"));assertEquals("wss://relay.test",output.getJSONArray("relays").getString(0));assertEquals(input.toString(),output.toString())
    }
    @Test fun latestPerAuthorAbsolutePeriodWinsWithoutCollapsingPuzzleRollover(){
        val old=row(period=19768);val first=row(period=20768,result="1",time=20768*86400L+1);val last=row(period=20768,result="6",time=20768*86400L+2)
        val other=row(b,20768,"2");val result=scoreHistory(listOf(first,last,other,old,last))
        assertEquals(3,result.size);assertEquals(1,result.first{it.getString("pubkey")==a&&historyPeriod(it)==20768L}.getInt("points"));assertTrue(result.any{historyPeriod(it)==19768L})
    }
    @Test fun nullPeriodUsesPuzzleToRecoverPreviousDayAfterMidnightAndHandlesZero(){
        val legacy=row(period=20999,time=21000*86400L+60).put("periodId",JSONObject.NULL)
        assertEquals(20999L,historyPeriod(legacy));assertEquals(21000L,historyPeriod(row(period=21000).put("periodId",JSONObject.NULL)))
        assertEquals(20000L,historyPeriod(row(period=21000).put("periodId",20000)))
    }
    @Test fun missingEventIdsRemainSeparateAndCorrectionsAreNotScores(){
        val r=scoreHistory(listOf(row().removeId(),row(b).removeId(),row(period=20767).removeId(),row(c).put("eventType","correction"),row().put("result","7")))
        assertEquals(3,r.size)
    }
    private fun JSONObject.removeId():JSONObject{remove("eventId");return this}
    @Test fun rankingUsesRecentPointsThenLastActivityAndRetainsInactiveParticipants(){
        val now=20770*86400L;val rows=listOf(row(a,20769,"2"),row(b,20768,"2"),row(c,20700,"1"),row("d".repeat(64),20769,"1"))
        val ranks=duelRankings(rows,listOf(a,b,c,"e".repeat(64)),now)
        assertEquals(listOf(a,b,c),ranks.map{it.getString("pubkey")});assertEquals(0,ranks.last().getInt("games"));assertEquals(0,ranks.last().getInt("points"))
    }
    @Test fun leagueIncludesCreatorDedupeAndLatestDefinitionCanRemoveMember(){
        val e=leagueDefinition(a,100,"slug","Name","Desc","",listOf(b,b));assertEquals(listOf(a,b),leagueMembers(e))
        val removed=leagueDefinition(a,101,"slug","Name","Desc","",emptyList())
        assertTrue(latestLeagues(listOf(e,removed),b).isEmpty());assertEquals(removed,latestLeagues(listOf(e,removed),a).single())
    }
    @Test fun leaveRequestHasExactWebAddressAndRejoinCancelsPerAuthor(){
        val e=leagueDefinition(a,100,"slug","Name","","",listOf(b,c));val leave=leagueLeave(b,101,e);val other=leagueLeave(c,102,e)
        assertEquals(listOf("league","slug",a),leave.tags.first{it[0]=="league"});assertEquals("leave-slug-$a",leave.tag("d"))
        assertEquals(2,pendingLeagueLeaves(e,listOf(leave,other)).size)
        assertEquals(listOf(c),pendingLeagueLeaves(e,listOf(leave,other,leagueLeave(b,103,e,true))).map{it.pubkey})
        val forged=Event(b,104,30078,leave.tags.filterNot{it[0]=="league"}+listOf(listOf("league","slug",c)),"")
        assertTrue(pendingLeagueLeaves(e,listOf(forged)).isEmpty())
    }
    @Test fun leaveOlderThanDefinitionAndCreatorLeaveCannotApply(){
        val e=leagueDefinition(a,100,"slug","Name","","",listOf(b));assertTrue(pendingLeagueLeaves(e,listOf(leagueLeave(b,99,e))).isEmpty())
        assertThrows(IllegalArgumentException::class.java){leagueLeave(a,101,e)}
    }
    @Test fun weeklyAndDailyScoresUseAbsolutePuzzlePeriodAndSharedWinners(){
        val rows=listOf(row(a,20999,"2"),row(a,21000,"3"),row(b,21000,"3"),row(c,21000,"X"),row(a,21000,"3"))
        val board=leagueBoard(rows,listOf(a,b,c),20999,21005);assertEquals(12,board.first().getInt("points"));assertEquals(2,board.first().getInt("games"))
        assertEquals(listOf(a,b),leagueDayWinners(rows,listOf(a,b,c),21000));assertTrue(leagueDayWinners(rows,listOf(a,b,c),21001).isEmpty())
    }
    @Test fun challengeMatchesWebPublicationContract(){
        val left=SocialIdentity(a,"Alice","alice@example.com","");val right=SocialIdentity(b,"Bob","bob@example.com","");val hash="d".repeat(64);val url="https://blossom.example/duel.png"
        val event=duelChallenge(a,123,left,right,17,12,url,hash,456)
        assertEquals(1,event.kind);assertEquals(10,event.tags.size)
        assertEquals(listOf(listOf("t","word5duel"),listOf("t","word5challenge"),listOf("game","word5"),listOf("window","21d"),listOf("score_left","17"),listOf("score_right","12"),listOf("r",url),listOf("imeta","url $url","x $hash","size 456","m image/png"),listOf("p",a),listOf("p",b)),event.tags)
        assertEquals("$url\n\nWORD5 Duel · Alice vs Bob\nnostr:${encodeNpub(a)} vs nostr:${encodeNpub(b)}\nPlay WORD5 and challenge your friends:\nhttps://otherstuff.ai/word5/",event.content)
    }
    @Test fun invalidLeagueSizeAndUnrelatedChallengeSignerRejected(){
        assertThrows(IllegalArgumentException::class.java){leagueDefinition(a,1,"slug","Name","","",(1..10).map{it.toString(16).padStart(64,'0')})}
        assertThrows(IllegalArgumentException::class.java){duelChallenge(c,1,SocialIdentity(a,"A","A",""),SocialIdentity(b,"B","B",""),1,2,"https://example.com/x","f".repeat(64),1)}
    }
    @Test fun laterOwnerDefinitionRevealsLeagueAfterLocalLeave(){
        assertFalse(leagueHiddenAfterLeave(null,100));assertTrue(leagueHiddenAfterLeave(101,100));assertTrue(leagueHiddenAfterLeave(101,101));assertFalse(leagueHiddenAfterLeave(101,102))
    }
}
