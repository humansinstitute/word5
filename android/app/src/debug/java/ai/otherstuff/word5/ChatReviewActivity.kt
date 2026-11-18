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

/** Debug-package-only two-room review; no signer, network or release data access. */
class ChatReviewActivity:ComponentActivity() {
    override fun onCreate(savedInstanceState:Bundle?) {
        super.onCreate(savedInstanceState);enableEdgeToEdge(statusBarStyle=SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),navigationBarStyle=SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        val yesterdayOnly=intent.getBooleanExtra("yesterdayOnly",false)
        setContent {
            MaterialTheme(colorScheme=darkColorScheme(primary=Purple,background=Background,surface=Panel)) {
                val today=Rules.period();val owner="a".repeat(64);val other="b".repeat(64)
                var selected by remember{mutableLongStateOf(today)}
                val rooms=remember{listOf(today,today-1).associateWith{period->ChatRoom(owner,period,java.time.LocalDate.ofEpochDay(period).toString(),if(period==today)"JOKER"else"CRANE",(period+2)*86400000,ByteArray(32){period.toByte()})}}
                val scrolls=remember{mutableMapOf<Long,ChatScrollMemory>()}
                var drafts by remember{mutableStateOf(mapOf<Long,String>())}
                var rows by remember{mutableStateOf(rooms.keys.associateWith{period->(1..16).map{index->ChatMessage("fixture-$period-$index",if(index%3==0)owner else other,System.currentTimeMillis()/1000-index,"${if(period==today)"Today"else"Yesterday"}: ${if(index%3==0)"I got there!"else"How did everyone find this word?"} · $index")}})}
                val members=if(selected==today)mapOf(owner to ChatMember("Alex (review)","","2"),other to ChatMember("Maya (review)","","X"))else mapOf(owner to ChatMember("Alex (review)","","5"),other to ChatMember("Maya (review)","","3"))
                Column(Modifier.fillMaxSize().background(Background).safeDrawingPadding()) {
                    Copy("TWO-ROOM REVIEW FIXTURE · no network or signer",10,Orange,modifier=Modifier.fillMaxWidth().padding(8.dp))
                    ChatToolbar(selected,today,if(yesterdayOnly&&selected==today)null else rooms.getValue(selected),false,System.currentTimeMillis(),{finish()},{selected=it},{})
                    if(yesterdayOnly&&selected==today)Column(Modifier.padding(20.dp)){Copy("Today is not completed",20,bold=true);Copy("Yesterday’s verified room remains available using the button above.",13,Muted,modifier=Modifier.padding(top=12.dp))}
                    else ChatConversation(rooms.getValue(selected),owner,rows.getValue(selected),members,drafts[selected].orEmpty(),"",false,System.currentTimeMillis(),{drafts=drafts+(selected to it)},{rows=rows+(selected to (rows.getValue(selected)+ChatMessage("fixture-$selected-${rows.getValue(selected).size+1}",owner,System.currentTimeMillis()/1000,drafts[selected].orEmpty())));drafts=drafts+(selected to "")},{},{finish()},scrolls.getOrPut(selected){ChatScrollMemory()})
                }
            }
        }
    }
}
