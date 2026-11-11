package ai.otherstuff.word5

import kotlinx.coroutines.ensureActive
import org.json.JSONObject
import java.time.LocalDate

private val socialPubkey = Regex("[0-9a-f]{64}")
fun resultPoints(result:String):Int = when(result.uppercase()) { "1"->10;"2"->7;"3"->5;"4"->3;"5"->2;"6"->1;else->0 }

/** Archive rows are normalized server records, not signed Event objects. Keep their provenance. */
fun historyPeriod(row:JSONObject):Long {
    if(row.has("periodId") && !row.isNull("periodId")) return row.getLong("periodId")
    runCatching { LocalDate.parse(row.optString("date")).toEpochDay() }.getOrNull()?.let { return it }
    val day=row.getLong("createdAt")/86400
    // Legacy public posts have a rotating display puzzle but no absolute period tag.
    val puzzle=row.optInt("puzzle",-1)
    return if(puzzle in 0..999) day-Math.floorMod(day-puzzle,1000L) else day
}
fun scoreHistory(rows:List<JSONObject>):List<JSONObject> = rows.filter {
    it.optString("pubkey").matches(socialPubkey) && it.optLong("createdAt",-1)>=0 &&
        it.optString("result").uppercase() in listOf("1","2","3","4","5","6","X") &&
        it.optString("eventType","score")=="score"
}.groupBy { it.getString("pubkey")+":"+historyPeriod(it) }.values.map {
    it.maxWith(compareBy<JSONObject>{r->r.getLong("createdAt")}.thenBy{r->r.optString("eventId")})
}.map { JSONObject(it.toString()).put("periodId",historyPeriod(it)).put("result",it.getString("result").uppercase()).put("points",resultPoints(it.getString("result"))) }
    .sortedWith(compareByDescending<JSONObject>{historyPeriod(it)}.thenByDescending{it.getLong("createdAt")})

fun duelRankings(rows:List<JSONObject>,authors:List<String>,now:Long):List<JSONObject> = scoreHistory(rows).filter {
    it.optString("pubkey") in authors && it.getLong("createdAt")<=now
}.groupBy{it.getString("pubkey")}.map{(pk,games)->
    val recent=games.filter{it.getLong("createdAt")>=now-21*86400}
    JSONObject().put("pubkey",pk).put("games",recent.size).put("points",recent.sumOf{it.getInt("points")})
        .put("lastPlayedAt",games.maxOf{it.getLong("createdAt")})
}.sortedWith(compareByDescending<JSONObject>{it.getInt("games")>0}.thenByDescending{it.getInt("points")}.thenByDescending{it.getLong("lastPlayedAt")}.thenBy{it.getString("pubkey")})

data class SocialIdentity(val pubkey:String,val name:String,val handle:String,val avatar:String)
fun socialIdentity(pk:String,profiles:Map<String,JSONObject>):SocialIdentity {
    val p=profiles[pk];val npub=runCatching{encodeNpub(pk)}.getOrDefault(pk)
    val short=if(npub.length>20)npub.take(10)+".."+npub.takeLast(6) else npub
    return SocialIdentity(pk,p?.optString("display_name")?.ifBlank{p.optString("name")}?.ifBlank{short}?:short,p?.optString("nip05")?.ifBlank{short}?:short,p?.optString("picture").orEmpty())
}
fun leagueMembers(e:Event):List<String> = (listOf(e.pubkey)+e.tags.filter{it.size>1&&it[0]=="p"}.map{it[1]}).filter{it.matches(socialPubkey)}.distinct()
fun leagueKey(e:Event)=e.pubkey+":"+e.tag("d")
fun latestLeagues(events:List<Event>,owner:String):List<Event> = events.filter{it.kind==30078&&it.tags.contains(listOf("t","word5league"))&&it.tag("d").isNotEmpty()}
    .groupBy{leagueKey(it)}.values.map{it.maxWith(compareBy<Event>{e->e.created}.thenBy{e->e.id})}.filter{owner in leagueMembers(it)}.sortedByDescending{it.created}
fun leagueDefinition(owner:String,at:Long,slug:String,name:String,description:String,image:String,members:List<String>):Event {
    require(owner.matches(socialPubkey)&&slug.isNotBlank()&&name.isNotBlank())
    val all=(members+owner).distinct();require(all.size<=10&&all.all{it.matches(socialPubkey)}){"League permits at most 10 members including you"}
    return Event(owner,at,30078,listOf(listOf("d",slug),listOf("name",name),listOf("description",description),listOf("image",image),listOf("t","word5league"))+all.map{listOf("p",it)},"")
}
fun leagueLeave(owner:String,at:Long,e:Event,rejoin:Boolean=false):Event {
    require(owner!=e.pubkey && owner in leagueMembers(e))
    return Event(owner,at,30078,listOf(listOf("d","leave-${e.tag("d")}-${e.pubkey}"),listOf("t",if(rejoin)"word5league-rejoin" else "word5league-leave"),listOf("p",e.pubkey),listOf("league",e.tag("d"),e.pubkey)),"")
}
/** Only verified relay events enter this function. Rejoin replaces a leave per author AND d tag. */
fun pendingLeagueLeaves(e:Event,requests:List<Event>):List<Event> = requests.filter { r->
    r.kind==30078 && r.pubkey!=e.pubkey && r.pubkey in leagueMembers(e) &&
        r.tag("d")=="leave-${e.tag("d")}-${e.pubkey}" &&
        r.tags.contains(listOf("p",e.pubkey)) && r.tags.contains(listOf("league",e.tag("d"),e.pubkey)) &&
        (r.tags.contains(listOf("t","word5league-leave")) || r.tags.contains(listOf("t","word5league-rejoin")))
}.groupBy{it.pubkey+":"+it.tag("d")}.values.map{it.maxWith(compareBy<Event>{r->r.created}.thenBy{r->r.id})}
    .filter{it.created>=e.created && it.tags.contains(listOf("t","word5league-leave"))}
fun leagueBoard(rows:List<JSONObject>,members:List<String>,startPeriod:Long,endPeriod:Long):List<JSONObject> {
    val scores=scoreHistory(rows).filter{historyPeriod(it) in startPeriod..endPeriod}
    return members.distinct().map{pk->val games=scores.filter{it.optString("pubkey")==pk};JSONObject().put("pubkey",pk).put("points",games.sumOf{it.getInt("points")}).put("games",games.size)}
        .sortedByDescending{it.getInt("points")}
}
fun leagueDayWinners(rows:List<JSONObject>,members:List<String>,period:Long):List<String> {
    val board=leagueBoard(rows,members,period,period);val best=board.firstOrNull()?.optInt("points")?:0
    return if(best<=0)emptyList() else board.filter{it.getInt("points")==best}.map{it.getString("pubkey")}
}
fun duelChallenge(owner:String,at:Long,left:SocialIdentity,right:SocialIdentity,leftScore:Int,rightScore:Int,url:String,hash:String,size:Int):Event {
    require(owner==left.pubkey||owner==right.pubkey);require(url.startsWith("https://")&&hash.matches(Regex("[0-9a-f]{64}"))&&size>0)
    val content=listOf(url,"","WORD5 Duel · ${left.name} vs ${right.name}","nostr:${encodeNpub(left.pubkey)} vs nostr:${encodeNpub(right.pubkey)}","Play WORD5 and challenge your friends:","https://otherstuff.ai/word5/").joinToString("\n")
    return Event(owner,at,1,listOf(listOf("t","word5duel"),listOf("t","word5challenge"),listOf("game","word5"),listOf("window","21d"),listOf("score_left",leftScore.toString()),listOf("score_right",rightScore.toString()),listOf("r",url),listOf("imeta","url $url","x $hash","size $size","m image/png"),listOf("p",left.pubkey),listOf("p",right.pubkey)),content)
}

/** Injectable public-write boundary: caller supplies transports only inside an explicit publicAction. */
suspend fun publishDuelChallenge(owner:String,at:Long,left:SocialIdentity,right:SocialIdentity,leftScore:Int,rightScore:Int,
    render:suspend()->ByteArray,upload:suspend(ByteArray)->String,sign:suspend(Event)->Event,publish:suspend(Event)->Unit):Event {
    require(owner==left.pubkey||owner==right.pubkey)
    val bytes=render();kotlinx.coroutines.currentCoroutineContext().ensureActive()
    val hash=java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)}
    val url=upload(bytes);kotlinx.coroutines.currentCoroutineContext().ensureActive()
    val signed=sign(duelChallenge(owner,at,left,right,leftScore,rightScore,url,hash,bytes.size))
    kotlinx.coroutines.currentCoroutineContext().ensureActive();publish(signed);return signed
}

/** Web local-hide semantics: a later owner definition re-invites the member. */
fun leagueHiddenAfterLeave(leftAt:Long?,definitionCreated:Long)=leftAt!=null&&definitionCreated<=leftAt
