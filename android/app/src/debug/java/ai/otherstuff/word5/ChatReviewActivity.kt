package ai.otherstuff.word5

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.collect

/** Debug-package-only two-room review; no signer, chat API or release data access. */
class ChatReviewActivity:ComponentActivity() {
    override fun onCreate(savedInstanceState:Bundle?) {
        super.onCreate(savedInstanceState);enableEdgeToEdge(statusBarStyle=SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),navigationBarStyle=SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        val profileReview=intent.getBooleanExtra("profiles",false)
        val yesterdayOnly=intent.getBooleanExtra("yesterdayOnly",false)
        setContent {
            MaterialTheme(colorScheme=darkColorScheme(primary=Purple,background=Background,surface=Panel)) {
                val today=Rules.period();var identity by remember{mutableStateOf(false)}
                val owner=if(identity)"c".repeat(64)else"a".repeat(64);val other=intent.getStringExtra("publicKey")?.takeIf{it.matches(Regex("[0-9a-f]{64}"))}?:"b".repeat(64)
                var profileMode by remember{mutableIntStateOf(intent.getIntExtra("profileMode",0))}
                var expired by remember{mutableStateOf(false)}
                var fixtureNow by remember{mutableLongStateOf(System.currentTimeMillis())}
                val profiles=remember{ChatProfiles({fixtureNow},{0.5})}
                var profileVersion by remember{mutableIntStateOf(0)}
                LaunchedEffect(profileMode,identity){
                    profiles.clear();fixtureNow=System.currentTimeMillis()
                    if(profileMode==6) {
                        PublicProfiles.initialize(filesDir)
                        val read=profiles.begin(listOf(other),true).single();profileVersion++
                        PublicProfiles.observe(other).collect { u->
                            val p=u.event?.let{parseChatProfile(it.content)}
                            if(u.complete)profiles.finish(read,p,p==null&&!u.allRelaysCompleted)
                            else if(p!=null)profiles.progress(read,p)
                            profileVersion++
                        }
                    }else if(profileMode==0) {
                        val read=profiles.begin(listOf(other),true).single();profileVersion++
                        kotlinx.coroutines.delay(5000);profiles.finish(read,null,true);profileVersion++
                        kotlinx.coroutines.delay(5000);fixtureNow+=2200
                        profiles.finish(profiles.begin(listOf(other),true).single(),org.json.JSONObject().put("name","Maya (recovered)").put("about","A public bio after a simulated relay failure."),false);profileVersion++
                    }else if(profileMode==1){profiles.begin(listOf(other),false);profileVersion++}
                    else if(profileMode==2){profiles.finish(profiles.begin(listOf(other),true).single(),null,false);profileVersion++}
                    else {profiles.put(other,org.json.JSONObject().put("name","<script>Hostile & literal</script>").put("about","<img src=x onerror=alert(1)> This is plain text. "+"Long bio. ".repeat(16)).put("picture",if(profileMode==3)"javascript:alert(1)"else if(profileMode==4)"https://example.invalid/broken.png"else"https://otherstuff.ai/word5/assets/icon-word5.png"));profileVersion++}
                }
                var selected by remember{mutableLongStateOf(today)}
                val rooms=remember(owner){listOf(today,today-1).associateWith{period->ChatRoom(owner,period,java.time.LocalDate.ofEpochDay(period).toString(),if(period==today)"JOKER"else"CRANE",(period+2)*86400000,ByteArray(32){period.toByte()})}}
                val scrolls=remember(owner){mutableMapOf<Long,ChatScrollMemory>()}
                var drafts by remember(owner){mutableStateOf(mapOf<Long,String>())}
                var rows by remember(owner){mutableStateOf(rooms.keys.associateWith{period->(1..16).map{index->ChatMessage("fixture-$period-$index",if(index%3==0)owner else other,System.currentTimeMillis()/1000-index,"${if(period==today)"Today"else"Yesterday"}: ${if(index%3==0)"I got there!"else"How did everyone find this word?"} · $index")}})}
                LaunchedEffect(Unit){
                    val change=intent.getStringExtra("timedScope")
                    if(change!=null){kotlinx.coroutines.delay(7000);when(change){"identity"->identity=!identity;"room"->selected=today-1;"expiry"->{rooms.getValue(selected).discard();expired=true}}}
                }
                val baseMembers=if(selected==today)mapOf(owner to ChatMember("Alex (review)","","2"),other to ChatMember("Maya (review)","","X"))else mapOf(owner to ChatMember("Alex (review)","","5"),other to ChatMember("Maya (review)","","3"))
                val members=if(profileReview){profileVersion;val v=profiles.value(other);baseMembers+(other to chatRoomMember(v.profile,null,if(selected==today)"X"else"3").copy(profileState=v.state))}else baseMembers
                Column(Modifier.fillMaxSize().background(Background).safeDrawingPadding()) {
                    Copy("REVIEW FIXTURE · no chat API or signer",10,Orange,modifier=Modifier.fillMaxWidth().padding(8.dp))
                    if(profileReview)Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceEvenly){
                        WebButton("State $profileMode",compact=true){profileMode=(profileMode+1)%7}
                        WebButton("Identity",compact=true){identity=!identity}
                        WebButton("Expire",compact=true){expired=true}
                    }
                    ChatToolbar(selected,today,if(yesterdayOnly&&selected==today)null else rooms.getValue(selected),false,System.currentTimeMillis(),{finish()},{selected=it},{})
                    if(yesterdayOnly&&selected==today)Column(Modifier.padding(20.dp)){Copy("Today is not completed",20,bold=true);Copy("Yesterday’s verified room remains available using the button above.",13,Muted,modifier=Modifier.padding(top=12.dp))}
                    else if(expired)Copy("Room expired · profile closed",16)
                    else ChatConversation(rooms.getValue(selected),owner,rows.getValue(selected),members,drafts[selected].orEmpty(),"",false,System.currentTimeMillis(),{drafts=drafts+(selected to it)},{rows=rows+(selected to (rows.getValue(selected)+ChatMessage("fixture-$selected-${rows.getValue(selected).size+1}",owner,System.currentTimeMillis()/1000,drafts[selected].orEmpty())));drafts=drafts+(selected to "")},{},{finish()},scrolls.getOrPut(selected){ChatScrollMemory()})
                }
            }
        }
    }
}
