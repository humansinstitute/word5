package ai.otherstuff.word5

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

private val SocialDivider=Color(0xFF2A2A2B)
private fun nowSeconds()=System.currentTimeMillis()/1000
private fun openSocialLink(context:Context,url:String) { if(url.startsWith("https://")||url.startsWith("http://"))runCatching{context.startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(url)))} }
private fun contactsOf(e:Event?)=e?.tags.orEmpty().filter{it.size>1&&it[0]=="p"&&it[1].matches(Regex("[0-9a-f]{64}"))}.map{it[1]}.distinct()
private suspend fun socialProfiles(authors:List<String>):Map<String,JSONObject> {
    val events=authors.filter{it.matches(Regex("[0-9a-f]{64}"))}.distinct().chunked(40).flatMap {
        PublicNostr.query(JSONObject().put("kinds",array(listOf(0))).put("authors",array(it)).put("limit",it.size*3))
    }
    return events.groupBy{it.pubkey}.mapValues{(_,es)->runCatching{JSONObject(es.maxBy{it.created}.content)}.getOrDefault(JSONObject())}
}
private suspend fun loadSocialLeagues(owner:String):List<Event> {
    val base=JSONObject().put("kinds",array(listOf(30078))).put("#t",array(listOf("word5league"))).put("limit",500)
    val mentions=PublicNostr.query(JSONObject(base.toString()).put("#p",array(listOf(owner))))
    val own=PublicNostr.query(JSONObject(base.toString()).put("authors",array(listOf(owner))))
    // An old membership event may remain on another relay. Resolve each address before displaying it.
    val latest=(mentions+own).distinctBy{it.id}.groupBy{it.pubkey}.flatMap{(author,es)->
        PublicNostr.query(JSONObject(base.toString()).put("authors",array(listOf(author))).put("#d",array(es.map{it.tag("d")}.distinct())))
    }
    return latestLeagues(latest+mentions+own,owner)
}
private fun hiddenLeague(context:Context,owner:String,e:Event):Boolean {
    val prefs=context.getSharedPreferences("word5-social",Context.MODE_PRIVATE);val key="left:$owner:${leagueKey(e)}"
    val stored=prefs.all[key];val leftAt=(stored as? Number)?.toLong() ?: if(stored==true)nowSeconds().also{prefs.edit().putLong(key,it).apply()} else null
    val hidden=leagueHiddenAfterLeave(leftAt,e.created)
    if(leftAt!=null&&!hidden)prefs.edit().remove(key).apply()
    return hidden
}
private fun hideLeague(context:Context,owner:String,e:Event) { context.getSharedPreferences("word5-social",Context.MODE_PRIVATE).edit().putLong("left:$owner:${leagueKey(e)}",nowSeconds()).apply() }


@Composable fun SocialScreen(m:GameModel,open:(String)->Unit,share:()->Unit) {
    var tab by remember { mutableStateOf("Social") };var days by remember{mutableIntStateOf(7)};var published by remember{mutableStateOf(false)}
    var revision by remember{mutableIntStateOf(0)};var following by remember{mutableStateOf(false)}
    var status by remember{mutableStateOf("Loading…")};var events by remember{mutableStateOf(emptyList<Event>())}
    var rows by remember{mutableStateOf(emptyList<JSONObject>())};var profiles by remember(m.owner){mutableStateOf(emptyMap<String,JSONObject>())}
    var selected by remember(m.owner){mutableStateOf("")};var visits by remember{mutableStateOf<JSONObject?>(null)}
    var opponent by remember(m.owner){mutableStateOf("")};var league by remember(m.owner){mutableStateOf<Event?>(null)};var createLeague by remember(m.owner){mutableStateOf(false)}
    var headline by remember{mutableStateOf("Loading current game players…")}
    val scope=rememberCoroutineScope();val context=LocalContext.current
    BackHandler(opponent.isNotEmpty()||league!=null){opponent="";league=null}
    LaunchedEffect(revision){runCatching{PublicNostr.get("api/visits/current-game")}.onSuccess{headline="Current game ${it.optInt("gameNumber")} has ${it.optInt("people")} players · View last 7 games"}.onFailure{if(it is CancellationException)throw it;headline="Current game count unavailable · View last 7 games"}}
    LaunchedEffect(tab,days,published,revision,following,m.owner) {
        status="Loading…";events=emptyList();rows=emptyList();opponent="";league=null
        try {
            when(tab) {
                "Top Scores" -> rows=PublicNostr.get("api/scores?days=$days&published=$published").optJSONArray("rows")?.objects().orEmpty()
                "Top Streaks" -> rows=PublicNostr.get("api/top-streaks?limit=50").optJSONArray("rows")?.objects().orEmpty().filter{it.optInt("maxStreak")>0}.sortedByDescending{it.optInt("maxStreak")}
                "League" -> if(m.owner.isEmpty())status="Log in with Amber to see your leagues." else events=loadSocialLeagues(m.owner).filterNot{hiddenLeague(context,m.owner,it)}
                "Duels" -> {
                    if(m.owner.isEmpty())status="Sign in with Amber to compare with people you follow." else {
                        val authors=contactsOf(PublicNostr.contacts(m.owner));val now=nowSeconds()
                        rows=duelRankings(PublicNostr.history(authors,now-400*86400,now),authors,now)
                        if(authors.isEmpty())status="No contacts found. Follow some people to compare scores here."
                    }
                }
                else -> {
                    val filter=JSONObject().put("kinds",array(listOf(1))).put("#t",array(listOf("word5"))).put("limit",80)
                    val authors=if(following&&m.owner.isNotEmpty())contactsOf(PublicNostr.contacts(m.owner)) else emptyList()
                    if(following&&authors.isEmpty())status=if(m.owner.isEmpty())"Sign in with Amber to see posts from your follows." else "Follow players to see their posts here."
                    else events=(if(following)authors.chunked(40).flatMap{PublicNostr.query(JSONObject(filter.toString()).put("authors",array(it)))} else PublicNostr.query(filter)).distinctBy{it.id}.sortedByDescending{it.created}.take(80)
                }
            }
            val authors=events.map{it.pubkey}+rows.map{it.optString("pubkey")}+listOf(m.owner)
            profiles=profiles+socialProfiles(authors)
            if(status=="Loading…")status=if(events.isEmpty()&&rows.isEmpty())when(tab){"League"->"No leagues yet";"Duels"->"No published WORD5 results from your follows yet.";else->"No results found yet."} else ""
        } catch(e:CancellationException){throw e} catch(e:Exception){status="Could not load $tab: ${e.message}"}
    }
    Column(Modifier.fillMaxSize().background(Background)) {
        Copy(headline,13,Color(0xFFD5B8F4),modifier=Modifier.fillMaxWidth().clickable {scope.launch{try{visits=PublicNostr.get("api/visits/recent-games")}catch(e:CancellationException){throw e}catch(e:Exception){m.notify("Visits unavailable; retry")}}}.padding(horizontal=16.dp,vertical=9.dp),align=TextAlign.Center)
        RuleLine()
        SocialTabs(tab){tab=it;opponent="";league=null}
        RuleLine()
        when {
            opponent.isNotEmpty() -> ComparisonLoader(m,opponent,profiles,{profiles=profiles+it},{opponent=""})
            league!=null -> LeagueDetail(m,league!!,{league=null;revision++},{owner,e->hideLeague(context,owner,e);league=null;revision++})
            else -> Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(top=8.dp)) {
                if(tab=="Social"){Row(Modifier.fillMaxWidth().padding(horizontal=16.dp,vertical=10.dp),horizontalArrangement=Arrangement.Center){SocialPill("Global",!following,true){following=false};SocialPill("My Follows",following,false){following=true}};SocialRule()}
                if(tab=="Top Scores") {
                    FlowRow(Modifier.fillMaxWidth().padding(horizontal=4.dp,vertical=10.dp),horizontalArrangement=Arrangement.Center,verticalArrangement=Arrangement.spacedBy(10.dp)) {
                        listOf(1,7,21).forEach{n->SocialPill("$n day${if(n==1)"" else "s"}",days==n,n==1,last=n==21){days=n}}
                        Row(Modifier.clickable{published=!published}.padding(horizontal=8.dp,vertical=7.dp),verticalAlignment=Alignment.CenterVertically){Copy(if(published)"☑" else "☐",14,Purple);Copy("Posted to Nostr only",13,Color(0xFFDDDDDD),modifier=Modifier.padding(start=6.dp))}
                    }
                    Copy("Server recorded scores from signed-in games. A signature identifies a player; it does not prove fair play.",12,Muted,modifier=Modifier.padding(horizontal=4.dp,vertical=12.dp))
                }
                if(tab=="Duels"&&rows.isNotEmpty())DuelIntro()
                if(tab=="League"&&m.owner.isNotEmpty())Row(Modifier.fillMaxWidth().padding(horizontal=16.dp,vertical=12.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.SpaceBetween){Copy("Your Leagues",16,bold=true);SocialAction("+ New",Purple){createLeague=true}}
                if(status.isNotEmpty())Copy(status,14,Muted,modifier=Modifier.fillMaxWidth().padding(24.dp),align=TextAlign.Center)
                events.forEach{e->if(tab=="Social")SocialFeedCard(e,socialIdentity(e.pubkey,profiles),{selected=e.pubkey},{openSocialLink(context,it)}) else if(tab=="League")LeagueCard(e){league=e}}
                rows.forEachIndexed{i,r->SocialRankingRow(tab,i+1,r,socialIdentity(r.optString("pubkey"),profiles)){if(tab=="Duels")opponent=r.optString("pubkey") else selected=r.optString("pubkey")}}
                SocialAction("Refresh",modifier=Modifier.align(Alignment.CenterHorizontally).padding(16.dp)){revision++}
            }
        }
    }
    if(selected.isNotEmpty())SocialPlayerModal(m,selected,socialIdentity(selected,profiles),profiles[selected],{selected=""},{opponent=selected;selected=""})
    visits?.let { data->WebModal({visits=null}){ModalHeading("Game visits · last 7 games",{visits=null});Copy("Each game runs from 00:00 UTC to 00:00 UTC the next day (08:00 Perth). Players are unique sessions; visits count game-page loads.",12,Muted);Row(Modifier.fillMaxWidth().padding(top=12.dp,bottom=8.dp)){Copy("Game · UTC date",12,Muted,modifier=Modifier.weight(1f));Copy("Players   Visits",12,Muted)};data.optJSONArray("games")?.objects()?.forEach{g->Row(Modifier.fillMaxWidth().padding(vertical=9.dp)){Copy("${g.optInt("gameNumber")} · ${g.optString("puzzleDate")}",12,modifier=Modifier.weight(1f));Copy("${g.optInt("people")}       ${g.optInt("visits")}",12)};SocialRule()}}}
    if(createLeague)LeagueEditor(m,null,{createLeague=false;revision++})
}

@Composable fun DuelIntro(){Column(Modifier.fillMaxWidth().padding(start=16.dp,end=16.dp,top=18.dp,bottom=12.dp)){Copy("Pick an opponent",18,bold=true);Copy("Tap someone you follow to compare the last 21 days of published WORD5 results. The list includes anyone you follow who has ever posted WORD5.",13,Muted,modifier=Modifier.padding(top=6.dp))};SocialRule()}
@Composable fun SocialTabs(selected:String,onSelect:(String)->Unit) {
    val labels=listOf("Social","Duels","Top Streaks","Top Scores","League")
    val measurer=rememberTextMeasurer();val density=LocalDensity.current
    val widths=labels.map{with(density){measurer.measure(AnnotatedString(it),TextStyle(fontFamily=WebFont,fontSize=14.sp,fontWeight=androidx.compose.ui.text.font.FontWeight.Bold)).size.width.toDp()}+20.dp}
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val extra=maxOf(0.dp,(maxWidth-widths.reduce{a,b->a+b})/5)
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            labels.forEachIndexed{i,label->Column(Modifier.width(widths[i]+extra).clickable{onSelect(label)},horizontalAlignment=Alignment.CenterHorizontally){Copy(label,14,if(selected==label)Color.White else Muted,true,Modifier.padding(vertical=14.dp));Box(Modifier.fillMaxWidth().height(2.dp).background(if(selected==label)Purple else Color.Transparent))}}
        }
    }
}
@Composable private fun SocialRule(){Box(Modifier.fillMaxWidth().height(1.dp).background(SocialDivider))}
@Composable fun SocialAction(label:String,color:Color=Color.Transparent,modifier:Modifier=Modifier,onClick:()->Unit) {
    Box(modifier.background(color,RoundedCornerShape(50)).border(1.dp,if(color==Color.Transparent)Border else color,RoundedCornerShape(50)).clickable(onClick=onClick).padding(horizontal=14.dp,vertical=9.dp),contentAlignment=Alignment.Center){Copy(label,12,bold=color!=Color.Transparent)}
}
@Composable private fun SocialPill(label:String,active:Boolean,first:Boolean,last:Boolean=!first,onClick:()->Unit) {
    val shape=RoundedCornerShape(topStart=if(first)50.dp else 0.dp,bottomStart=if(first)50.dp else 0.dp,topEnd=if(last)50.dp else 0.dp,bottomEnd=if(last)50.dp else 0.dp)
    Box(Modifier.background(if(active)Purple else Color.Transparent,shape).border(1.dp,if(active)Purple else Border,shape).clickable(onClick=onClick).padding(horizontal=20.dp,vertical=7.dp)){Copy(label,13,if(active)Color.White else Muted,true)}
}
@Composable fun SocialFeedCard(e:Event,identity:SocialIdentity,onPlayer:()->Unit,onLink:(String)->Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick=onPlayer).padding(16.dp),horizontalArrangement=Arrangement.spacedBy(12.dp)) {
        Avatar(identity.avatar,identity.name,Modifier.size(48.dp))
        Column(Modifier.weight(1f)) {
            FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp),verticalArrangement=Arrangement.spacedBy(2.dp)) {Copy(identity.name,15,bold=true);Copy(identity.handle,13,Muted);Copy("· ${relativeTime(e.created)}",13,Muted)}
            val content=remember(e.content){buildAnnotatedString {
                var cursor=0
                Regex("https?://[^\\s<]+").findAll(e.content.take(16000)).forEach{match->
                    append(e.content.substring(cursor,match.range.first));val start=length;append(match.value)
                    addLink(LinkAnnotation.Url(match.value,TextLinkStyles(style=SpanStyle(color=Purple))),start,length);cursor=match.range.last+1
                };append(e.content.take(16000).substring(cursor))
            }}
            Text(content,Modifier.padding(top=4.dp),color=Color(0xFFE7E9EA),fontSize=15.sp,lineHeight=22.5.sp,fontFamily=WebFont)
            postMedia(e).forEach{url->SocialImage(url,"Post image",Modifier.padding(top=10.dp).fillMaxWidth().heightIn(max=320.dp).aspectRatio(1.6f)){onLink(url)}}
        }
    };SocialRule()
}
@Composable fun SocialRankingRow(tab:String,rank:Int,row:JSONObject,identity:SocialIdentity,onClick:()->Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick=onClick).padding(horizontal=16.dp,vertical=12.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
        Copy(if(tab=="Top Streaks"&&rank<=3)listOf("🥇","🥈","🥉")[rank-1] else "#$rank",16,Muted,true,Modifier.width(36.dp),TextAlign.Center)
        Avatar(identity.avatar,identity.name,Modifier.size(40.dp))
        Column(Modifier.weight(1f)) {
            Text(identity.name,color=Color.White,fontSize=15.sp,fontWeight=androidx.compose.ui.text.font.FontWeight.SemiBold,maxLines=1,overflow=TextOverflow.Ellipsis,fontFamily=WebFont)
            val detail=when(tab){"Duels"->"${row.optInt("points")} pts in 21d · ${row.optInt("games")} recent games";"Top Streaks"->"${row.optInt("played")} played · ${if(row.optInt("played")==0)0 else kotlin.math.round(row.optInt("won")*100.0/row.optInt("played")).toInt()}% win";else->"${row.optInt("games")} games · ${row.optInt("wins")} wins · ${row.optInt("publishedGames")} posted"}
            Copy(detail,12,Muted)
            if(tab=="Duels")Copy("Last played ${relativeTime(row.optLong("lastPlayedAt"))}",12,Muted,modifier=Modifier.padding(top=3.dp))
        }
        Column(horizontalAlignment=Alignment.CenterHorizontally) {Copy(when(tab){"Duels"->"vs";"Top Streaks"->row.optInt("maxStreak").toString();else->row.optInt("points").toString()},24,Purple,true);Copy(when(tab){"Duels"->"COMPARE";"Top Streaks"->"BEST";else->"POINTS"},10,Muted)}
    };SocialRule()
}
@Composable private fun SocialPlayerModal(m:GameModel,pk:String,identity:SocialIdentity,profile:JSONObject?,close:()->Unit,compare:()->Unit) {
    var contact by remember(m.owner,pk){mutableStateOf<Event?>(null)};var loaded by remember(m.owner,pk){mutableStateOf(false)};var status by remember{mutableStateOf("Loading follows…")}
    LaunchedEffect(m.owner,pk){if(m.owner.isNotEmpty())try{contact=PublicNostr.contacts(m.owner);loaded=true;status=if(pk==m.owner)"This is you!" else if(pk in contactsOf(contact))"You already follow this person." else "This will update your follows to ${contactsOf(contact).size+1} people."}catch(e:CancellationException){throw e}catch(e:Exception){status="Could not load follows: ${e.message}"}else status="Sign in with Amber to follow people."}
    WebModal(close) {
        ModalHeading(identity.name,close);Avatar(identity.avatar,identity.name,Modifier.align(Alignment.CenterHorizontally).size(72.dp));Copy(identity.handle,12,Muted,modifier=Modifier.padding(vertical=10.dp));Copy(profile?.optString("about").orEmpty(),13,Muted);Copy(status,13,Muted,modifier=Modifier.padding(vertical=12.dp))
        if(loaded&&pk!=m.owner&&pk !in contactsOf(contact))WebButton("Follow",Modifier.fillMaxWidth(),primary=true){m.publicAction{owner->check(owner!=pk);val fresh=PublicNostr.contacts(owner);check(pk !in contactsOf(fresh)){"Already following"};val tags=fresh?.tags.orEmpty();check(tags.size<5000);PublicNostr.publish(m.amber.sign(Event(owner,nowSeconds(),3,tags+listOf(listOf("p",pk)),fresh?.content.orEmpty())));close();"Following ${identity.name}"}}
        if(m.owner.isEmpty())WebButton("Login with Amber",Modifier.fillMaxWidth()){close();m.login()}
        if(m.owner.isNotEmpty()&&pk!=m.owner)WebButton("Compare scores",Modifier.fillMaxWidth().padding(top=8.dp),onClick=compare)
        Copy(m.publicStatus,12,Muted,modifier=Modifier.padding(top=8.dp))
    }
}

@Composable private fun ComparisonLoader(m:GameModel,opponent:String,profiles:Map<String,JSONObject>,onProfiles:(Map<String,JSONObject>)->Unit,close:()->Unit) {
    var rows by remember(m.owner,opponent){mutableStateOf(emptyList<JSONObject>())};var status by remember{mutableStateOf("Loading comparison…")};var retry by remember{mutableIntStateOf(0)}
    LaunchedEffect(m.owner,opponent,retry){try{val now=nowSeconds();rows=PublicNostr.history(listOf(m.owner,opponent),now-21*86400,now);onProfiles(socialProfiles(listOf(m.owner,opponent)));status=""}catch(e:CancellationException){throw e}catch(e:Exception){status="Comparison unavailable: ${e.message}"}}
    if(status.isNotEmpty())Column(Modifier.fillMaxWidth().padding(16.dp)){SocialAction("Back to follows",onClick=close);Copy(status,14,Muted,modifier=Modifier.padding(vertical=24.dp));SocialAction("Retry"){retry++}}
    else {
        val left=socialIdentity(m.owner,profiles);val right=socialIdentity(opponent,profiles)
        ComparisonView(rows,left,right,close,m.publicStatus,m.publicBusy){a,b->
            m.publicAction{owner->publishDuelChallenge(owner,nowSeconds(),left,right,a,b,{renderDuelCard(left,right,a,b)},{bytes->PublicNostr.upload(bytes,"image/png",owner,m.amber,message="Upload WORD5 duel card")},{draft->m.amber.sign(draft)},{signed->PublicNostr.publish(signed)});"Challenge published"}
        }
    }
}
@Composable fun ComparisonView(rows:List<JSONObject>,left:SocialIdentity,right:SocialIdentity,close:()->Unit,status:String="",busy:Boolean=false,onShare:(Int,Int)->Unit) {
    val scores=scoreHistory(rows);val mine=scores.filter{it.optString("pubkey")==left.pubkey};val theirs=scores.filter{it.optString("pubkey")==right.pubkey}
    val a=mine.sumOf{it.getInt("points")};val b=theirs.sumOf{it.getInt("points")}
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Row(Modifier.fillMaxWidth().padding(bottom=16.dp),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=Alignment.CenterVertically){SocialAction("Back to follows",onClick=close);Copy("LAST 21 DAYS",12,Muted)}
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            if(maxWidth<440.dp)Column(Modifier.fillMaxWidth(),horizontalAlignment=Alignment.CenterHorizontally){ComparePanel(left,a,a>b,Modifier.fillMaxWidth());Copy("VS",12,Muted,modifier=Modifier.padding(vertical=12.dp));ComparePanel(right,b,b>a,Modifier.fillMaxWidth())}
            else Row(verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)){ComparePanel(left,a,a>b,Modifier.weight(1f));Copy("VS",12,Muted);ComparePanel(right,b,b>a,Modifier.weight(1f))}
        }
        Copy("${left.name} vs ${right.name} · ${if(a==b)"tie game" else "trophy for the leader"}",13,Color(0xFFB5B5B7),modifier=Modifier.fillMaxWidth().padding(top=12.dp,bottom=14.dp),align=TextAlign.Center)
        WebButton(if(busy)"Uploading / posting…" else "Share",Modifier.fillMaxWidth()){if(!busy)onShare(a,b)}
        Copy("Publish this head-to-head and invite people to play WORD5.",12,Muted,modifier=Modifier.fillMaxWidth().padding(top=8.dp,bottom=18.dp),align=TextAlign.Center)
        if(status.isNotBlank())Copy(status,12,Muted,modifier=Modifier.padding(bottom=12.dp))
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Color(0xFF171718)).border(1.dp,SocialDivider,RoundedCornerShape(12.dp))) {
            Copy("RECENT MATCHUP LOG",13,bold=true,modifier=Modifier.padding(horizontal=14.dp,vertical=12.dp));SocialRule()
            Row(Modifier.fillMaxWidth().background(Color(0xFF1B1B1D)).padding(horizontal=12.dp,vertical=10.dp),horizontalArrangement=Arrangement.spacedBy(8.dp)){Copy("PUZZLE",11,Muted,true,Modifier.width(72.dp));Copy(left.name,11,Muted,true,Modifier.weight(1f));Copy(right.name,11,Muted,true,Modifier.weight(1f))}
            val periods=(mine+theirs).map{historyPeriod(it)}.distinct().sortedDescending()
            if(periods.isEmpty())Copy("Neither player has published WORD5 results in the last 21 days.",13,Muted,modifier=Modifier.padding(16.dp))
            periods.forEach{period->val x=mine.firstOrNull{historyPeriod(it)==period};val y=theirs.firstOrNull{historyPeriod(it)==period};SocialRule();Row(Modifier.fillMaxWidth().padding(horizontal=12.dp,vertical=10.dp),horizontalArrangement=Arrangement.spacedBy(8.dp),verticalAlignment=Alignment.CenterVertically){Column(Modifier.width(72.dp)){Copy("#${(x?:y)?.optInt("puzzle")?:period%1000}",14,bold=true);Copy(relativeTime(maxOf(x?.optLong("createdAt")?:0,y?.optLong("createdAt")?:0)),11,Muted,modifier=Modifier.padding(top=4.dp))};CompareCell(x,Modifier.weight(1f));CompareCell(y,Modifier.weight(1f))}}
        }
    }
}
@Composable private fun ComparePanel(identity:SocialIdentity,score:Int,winner:Boolean,modifier:Modifier) {
    Column(modifier.background(Panel,RoundedCornerShape(14.dp)).border(1.dp,SocialDivider,RoundedCornerShape(14.dp)).padding(horizontal=14.dp,vertical=16.dp),horizontalAlignment=Alignment.CenterHorizontally){Avatar(identity.avatar,identity.name,Modifier.size(72.dp));Copy(identity.name+if(winner)" 🏆" else "",16,bold=true,modifier=Modifier.padding(top=if(winner)16.dp else 10.dp));Copy(identity.handle,12,Muted,modifier=Modifier.padding(top=4.dp));Copy(score.toString(),40,Purple,true,Modifier.padding(top=14.dp))}
}
@Composable private fun CompareCell(row:JSONObject?,modifier:Modifier){Column(modifier){Copy(row?.let{"${it.optString("result")}/6"}?:"Missed",14,if(row==null)Muted else Color.White,true);Copy("${row?.optInt("points")?:0} pts",12,Orange,modifier=Modifier.padding(top=4.dp))}}

@Composable fun LeagueCard(e:Event,onClick:()->Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick=onClick).padding(horizontal=16.dp,vertical=14.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
        if(e.tag("image").isNotEmpty())SocialImage(e.tag("image"),"League image",Modifier.size(44.dp),onClick)
        Column{Copy(e.tag("name").ifBlank{"Unnamed League"},15,bold=true);Copy("${leagueMembers(e).size} members",12,Muted,modifier=Modifier.padding(top=2.dp))}
    };SocialRule()
}

@Composable private fun LeagueDetail(m:GameModel,initial:Event,close:()->Unit,left:(String,Event)->Unit) {
    var event by remember(initial.id){mutableStateOf(initial)};var weekOffset by remember{mutableIntStateOf(0)};var daily by remember{mutableStateOf(false)}
    val today=LocalDate.now(ZoneOffset.UTC);val thisMonday=today.minusDays((today.dayOfWeek.value-1).toLong()).toEpochDay()
    var day by remember{mutableIntStateOf(today.dayOfWeek.value-1)};var member by remember{mutableStateOf("")};var edit by remember{mutableStateOf(false)};var confirmLeave by remember{mutableStateOf(false)}
    var rows by remember{mutableStateOf(emptyList<JSONObject>())};var profiles by remember{mutableStateOf(emptyMap<String,JSONObject>())};var requests by remember{mutableStateOf(emptyList<Event>())};var status by remember{mutableStateOf("Loading…")};var retry by remember{mutableIntStateOf(0)}
    val members=leagueMembers(event);val monday=thisMonday+weekOffset*7
    LaunchedEffect(event.id,monday,retry){status="Loading…";try{rows=PublicNostr.history(members,monday*86400,(monday+7)*86400-1);profiles=socialProfiles(members);status="";if(event.pubkey==m.owner)requests=PublicNostr.query(JSONObject().put("kinds",array(listOf(30078))).put("#t",array(listOf("word5league-leave","word5league-rejoin"))).put("#p",array(listOf(m.owner))).put("limit",500))}catch(e:CancellationException){throw e}catch(e:Exception){status="League unavailable: ${e.message}"}}
    val pending=pendingLeagueLeaves(event,requests)
    Column(Modifier.fillMaxSize()) {
        if(member.isNotEmpty())LeagueMemberView(member,rows,profiles,monday){member=""}
        else {
            LeagueView(event,rows,profiles,monday,daily,day,close,{daily=!daily;day=if(weekOffset==0)today.dayOfWeek.value-1 else 0},{delta->if(!daily)weekOffset+=delta else{val next=day+delta;if(next<0){weekOffset--;day=6}else if(next>6){weekOffset++;day=0}else day=next}},{day=it;daily=true},{member=it},status) {
                if(status.isNotEmpty())SocialAction("Retry",modifier=Modifier.padding(12.dp)){retry++}
                if(event.pubkey==m.owner) {
                    SocialAction("Edit League",Purple,Modifier.align(Alignment.CenterHorizontally).padding(top=24.dp)){edit=true}
                    if(pending.isNotEmpty()) {
                        Copy("${pending.size} signed leave request${if(pending.size==1)"" else "s"}",12,Muted,modifier=Modifier.padding(top=12.dp))
                        pending.forEach{Copy("${socialIdentity(it.pubkey,profiles).name} requested to leave",12,Muted)}
                        SocialAction("Apply leave requests",modifier=Modifier.padding(top=8.dp)) {
                            m.publicAction{owner->check(owner==event.pubkey);val fresh=PublicNostr.query(JSONObject().put("kinds",array(listOf(30078))).put("authors",array(listOf(owner))).put("#d",array(listOf(event.tag("d")))).put("limit",10)).maxByOrNull{it.created}?:error("League unavailable")
                                val freshRequests=PublicNostr.query(JSONObject().put("kinds",array(listOf(30078))).put("#t",array(listOf("word5league-leave","word5league-rejoin"))).put("#p",array(listOf(owner))).put("limit",500))
                                val remove=pendingLeagueLeaves(fresh,freshRequests).map{it.pubkey}.toSet();check(remove.isNotEmpty()){"No pending requests"}
                                val updated=m.amber.sign(leagueDefinition(owner,maxOf(nowSeconds(),fresh.created+1),fresh.tag("d"),fresh.tag("name"),fresh.tag("description"),fresh.tag("image"),leagueMembers(fresh).filterNot{it in remove}));PublicNostr.publish(updated);event=updated;requests=emptyList();"Leave requests applied"}
                        }
                    }
                } else if(m.owner in members)SocialAction(if(confirmLeave)"Tap again to confirm" else "Leave League",modifier=Modifier.align(Alignment.CenterHorizontally).padding(top=24.dp)) {
                    if(!confirmLeave)confirmLeave=true else m.publicAction{owner->check(owner==m.owner);PublicNostr.publish(m.amber.sign(leagueLeave(owner,nowSeconds(),event)));left(owner,event);"Left league"}
                }
                if(m.publicStatus.isNotBlank())Copy(m.publicStatus,12,Muted,modifier=Modifier.padding(16.dp))
            }
        }
    }
    if(edit)LeagueEditor(m,event,{edit=false},{updated->event=updated;edit=false})
}

@Composable fun LeagueView(e:Event,rows:List<JSONObject>,profiles:Map<String,JSONObject>,monday:Long,daily:Boolean,day:Int,close:()->Unit,toggle:()->Unit,navigate:(Int)->Unit,selectDay:(Int)->Unit,selectMember:(String)->Unit,status:String="",actions:@Composable ColumnScope.()->Unit={}) {
    val members=leagueMembers(e);val board=leagueBoard(rows,members,if(daily)monday+day else monday,if(daily)monday+day else monday+6)
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Row(Modifier.fillMaxWidth().padding(horizontal=16.dp,vertical=12.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(10.dp)) {
            SocialAction("Back",onClick=close);if(e.tag("image").isNotBlank())SocialImage(e.tag("image"),"League image",Modifier.size(40.dp))
            Column(Modifier.weight(1f)){Text(e.tag("name"),color=Color.White,fontSize=16.sp,fontFamily=WebFont,fontWeight=androidx.compose.ui.text.font.FontWeight.Bold,maxLines=1,overflow=TextOverflow.Ellipsis);Text(e.tag("description"),color=Muted,fontSize=12.sp,fontFamily=WebFont,maxLines=1,overflow=TextOverflow.Ellipsis)}
            SocialAction(if(daily)"Daily" else "Week",if(daily)Orange else Purple,onClick=toggle)
        };SocialRule()
        Row(Modifier.fillMaxWidth().padding(horizontal=16.dp,vertical=10.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.SpaceBetween){SocialAction("‹"){navigate(-1)};val date=LocalDate.ofEpochDay(monday+if(daily)day else 0);Copy(if(daily)date.format(DateTimeFormatter.ofPattern("EEEE, MMM d")) else "${date.format(DateTimeFormatter.ofPattern("MMM d"))} – ${java.time.Instant.ofEpochSecond((monday+7)*86400-1).atZone(java.time.ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("MMM d, yyyy"))}",13,bold=true);SocialAction("›"){navigate(1)}};SocialRule()
        Row(Modifier.fillMaxWidth().padding(horizontal=8.dp,vertical=12.dp),horizontalArrangement=Arrangement.SpaceAround){(0..6).forEach{i->
            val winners=leagueDayWinners(rows,members,monday+i);val today=LocalDate.now(ZoneOffset.UTC).toEpochDay()==monday+i
            Column(Modifier.clickable{selectDay(i)}.padding(2.dp),horizontalAlignment=Alignment.CenterHorizontally) {
                Box(Modifier.border(2.dp,if(daily&&day==i)Orange else Color.Transparent,RoundedCornerShape(50)).padding(3.dp).size(36.dp).background(if(winners.isEmpty())SocialDivider else Color.Transparent,RoundedCornerShape(50)),contentAlignment=Alignment.Center) {
                    if(winners.isEmpty())Copy("—",11,Muted)
                    else if(winners.size==1){val identity=socialIdentity(winners[0],profiles);Avatar(identity.avatar,identity.name,Modifier.size(36.dp))}
                    else {val a=socialIdentity(winners[0],profiles);val b=socialIdentity(winners[1],profiles);Avatar(b.avatar,b.name,Modifier.align(Alignment.BottomEnd).size(24.dp));Avatar(a.avatar,a.name,Modifier.align(Alignment.TopStart).size(24.dp))}
                };Copy(listOf("M","T","W","T","F","S","S")[i],10,if(today)Orange else Muted,true,Modifier.padding(top=4.dp))
            }
        }};SocialRule()
        if(status.isNotBlank())Copy(status,13,Muted,modifier=Modifier.padding(16.dp))
        board.forEachIndexed{i,r->val pk=r.getString("pubkey");val identity=socialIdentity(pk,profiles);val entry=scoreHistory(rows).firstOrNull{it.optString("pubkey")==pk&&historyPeriod(it)==monday+day}
            Row(Modifier.fillMaxWidth().clickable{selectMember(pk)}.padding(horizontal=16.dp,vertical=12.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                if(!daily)Copy("#${i+1}",16,Muted,true,Modifier.width(36.dp),TextAlign.Center)
                Avatar(identity.avatar,identity.name,Modifier.size(if(daily)36.dp else 40.dp).then(if(daily&&pk in leagueDayWinners(rows,members,monday+day))Modifier.border(2.dp,Orange,RoundedCornerShape(50)) else Modifier))
                Column(Modifier.weight(1f)){Copy(identity.name,if(daily)14 else 15,bold=true);if(!daily)Copy("${r.optInt("games")} games played",12,Muted)}
                if(daily)Copy(entry?.let{"${it.optString("result")}/6"}?:"—",14,if(entry==null)Muted else Orange,true,Modifier.width(36.dp),TextAlign.Center)
                Column(horizontalAlignment=Alignment.CenterHorizontally){Copy(r.optInt("points").toString(),if(daily)16 else 24,Purple,true);if(!daily)Copy("PTS",10,Muted)}
            };SocialRule()
        }
        actions();Spacer(Modifier.height(16.dp))
    }
}
@Composable fun LeagueMemberView(pk:String,rows:List<JSONObject>,profiles:Map<String,JSONObject>,monday:Long,close:()->Unit) {
    val identity=socialIdentity(pk,profiles);val games=scoreHistory(rows).filter{it.optString("pubkey")==pk&&historyPeriod(it) in monday..monday+6}
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Row(Modifier.fillMaxWidth().padding(horizontal=16.dp,vertical=12.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)){SocialAction("Back",onClick=close);Avatar(identity.avatar,identity.name,Modifier.size(48.dp));Column{Copy(identity.name,16,bold=true);Copy("${games.sumOf{it.getInt("points")}} pts · ${games.size} games",13,Muted)}};SocialRule()
        Column(Modifier.padding(horizontal=16.dp,vertical=12.dp).border(1.dp,SocialDivider,RoundedCornerShape(12.dp))){Copy("DAILY RESULTS",13,bold=true,modifier=Modifier.padding(14.dp));SocialRule();if(games.isEmpty())Copy("No games played this week.",13,Muted,modifier=Modifier.padding(16.dp));games.forEach{r->Row(Modifier.fillMaxWidth().padding(horizontal=14.dp,vertical=12.dp),horizontalArrangement=Arrangement.spacedBy(8.dp),verticalAlignment=Alignment.CenterVertically){Copy("#${r.optInt("puzzle")}",14,bold=true);Copy("${r.optString("result")}/6",13,Orange);Spacer(Modifier.weight(1f));Copy("${r.optInt("points")} pts",13,bold=true);Copy(LocalDate.ofEpochDay(historyPeriod(r)).format(DateTimeFormatter.ofPattern("EEE, MMM d")),12,Muted)};SocialRule()}}
    }
}

@Composable fun LeagueEditor(m:GameModel,existing:Event?,close:()->Unit,saved:(Event)->Unit={close()}) {
    val context=LocalContext.current;val account=m.owner
    var name by remember{mutableStateOf(existing?.tag("name").orEmpty())};var description by remember{mutableStateOf(existing?.tag("description").orEmpty())};var image by remember{mutableStateOf(existing?.tag("image").orEmpty())}
    var imageUri by remember{mutableStateOf<Uri?>(null)}
    val imagePicker=rememberLauncherForActivityResult(ActivityResultContracts.GetContent()){imageUri=it}
    var member by remember{mutableStateOf("")};var search by remember{mutableStateOf("")};var members by remember{mutableStateOf(existing?.let{leagueMembers(it).filter{pk->pk!=account}}.orEmpty())}
    var contacts by remember{mutableStateOf(emptyList<String>())};var profiles by remember{mutableStateOf(emptyMap<String,JSONObject>())};var status by remember{mutableStateOf("Loading mutual follows…")};var loaded by remember{mutableStateOf(false)}
    val scope=rememberCoroutineScope()
    LaunchedEffect(account){try{val follows=contactsOf(PublicNostr.contacts(account));val es=follows.chunked(40).flatMap{PublicNostr.query(JSONObject().put("kinds",array(listOf(3))).put("authors",array(it)).put("limit",it.size*3))};contacts=es.groupBy{it.pubkey}.values.map{it.maxBy{e->e.created}}.filter{account in contactsOf(it)}.map{it.pubkey};profiles=socialProfiles(contacts+members);loaded=true;status="Only mutual follows can be added."}catch(e:CancellationException){throw e}catch(e:Exception){status="Contacts unavailable: ${e.message}"}}
    WebModal(close) {
        ModalHeading(if(existing==null)"Create League" else "Edit League",close)
        WebField("Name",name,{name=it.take(64)});WebField("Description",description,{description=it.take(280)},true);WebField("League image URL",image,{image=it;imageUri=null})
        WebButton(if(imageUri==null)"Choose league image" else "Image selected · Choose another",Modifier.fillMaxWidth().padding(top=8.dp)){imagePicker.launch("image/*")}
        if(image.startsWith("https://"))SocialImage(image,"League image preview",Modifier.padding(top=8.dp).size(64.dp)){openSocialLink(context,image)}
        Copy("Members (${members.size+1}/10 including you)",12,Muted,modifier=Modifier.padding(top=14.dp));Copy("You are included as the creator.",12,Muted)
        WebField("Search mutual follows",search,{search=it})
        (contacts+members).distinct().filter{search.isBlank()||socialIdentity(it,profiles).name.contains(search,true)||it.contains(search,true)}.forEach{pk->val identity=socialIdentity(pk,profiles)
            Row(Modifier.fillMaxWidth().clickable{members=if(pk in members)members-pk else if(members.size<9)members+pk else members;status=if(members.size>=9)"League permits 10 members including you" else "Only mutual follows can be added."}.padding(vertical=8.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(10.dp)){Copy(if(pk in members)"☑" else "☐",14,Purple);Avatar(identity.avatar,identity.name,Modifier.size(32.dp));Copy(identity.name,13,modifier=Modifier.weight(1f))}
        }
        WebField("Paste npub to add",member,{member=it})
        SocialAction("+ Add",modifier=Modifier.padding(top=8.dp)){scope.launch{try{val pk=amberPublicKey(member.trim());check(pk!=account&&members.size<9);check(pk in contactsOf(PublicNostr.contacts(account))&&account in contactsOf(PublicNostr.contacts(pk))){"League members must follow each other"};contacts=(contacts+pk).distinct();members=(members+pk).distinct();profiles=profiles+socialProfiles(listOf(pk));member="";status="Member added"}catch(e:CancellationException){throw e}catch(e:Exception){status=e.message?:"Could not add member"}}}
        WebButton(if(existing==null)"Create League" else "Save League",Modifier.fillMaxWidth().padding(top=14.dp),primary=true) {
            if(name.isBlank())status="Enter a league name" else if(!loaded)status="Load mutual contacts before saving" else m.publicAction{owner->check(owner==account);check(existing==null||existing.pubkey==owner){"Only the creator can edit"}
                // Recheck newly added members immediately before signing, preserving existing members.
                val old=existing?.let{leagueMembers(it)}.orEmpty();val fresh=contactsOf(PublicNostr.contacts(owner))
                for(pk in members.filter{it !in old})check(pk in fresh&&owner in contactsOf(PublicNostr.contacts(pk))){"New members must be mutual follows"}
                val chosen=imageUri
                val imageUrl=if(chosen==null)image else {val bytes=kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO){context.contentResolver.openInputStream(chosen)?.use{it.readBounded(10000000)}?:error("Cannot open image")};PublicNostr.upload(bytes,context.contentResolver.getType(chosen)?:"image/jpeg",owner,m.amber)}
                val draft=leagueDefinition(owner,maxOf(nowSeconds(),(existing?.created?:0)+1),existing?.tag("d")?:java.util.UUID.randomUUID().toString().replace("-","").take(8),name.trim(),description,imageUrl,members)
                val signed=m.amber.sign(draft);PublicNostr.publish(signed);saved(signed);"League saved"}
        }
        Copy(status,12,Muted,modifier=Modifier.padding(top=10.dp));Copy(m.publicStatus,12,Muted,modifier=Modifier.padding(top=8.dp))
    }
}
fun relativeTime(created:Long):String {val seconds=maxOf(0,nowSeconds()-created);return when{seconds<60->"now";seconds<3600->"${seconds/60} min";seconds<86400->"${seconds/3600} hr";seconds<604800->"${seconds/86400} d";else->LocalDate.ofEpochDay(created/86400).toString()}}
