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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** Debug-package-only review: no signer, network transport or release data access. */
class ChatReviewActivity:ComponentActivity() {
    override fun onCreate(savedInstanceState:Bundle?) {
        super.onCreate(savedInstanceState);enableEdgeToEdge(statusBarStyle=SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),navigationBarStyle=SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        setContent {
            MaterialTheme(colorScheme=darkColorScheme(primary=Purple,background=Background,surface=Panel)) {
                val period=Rules.period();val owner="a".repeat(64);val other="b".repeat(64)
                val room=remember{ChatRoom(owner,period,java.time.LocalDate.ofEpochDay(period).toString(),"JOKER",(period+1)*86400000,ByteArray(32))}
                var draft by remember{mutableStateOf("")}
                var rows by remember{mutableStateOf((1..16).map{index->ChatMessage("fixture-$index",if(index%3==0)owner else other,System.currentTimeMillis()/1000-index,"${if(index%3==0)"I got there in two guesses!"else"That was a close one. How did everyone find today’s word?"} · $index")})}
                val members=mapOf(owner to ChatMember("Alex (review)","","2"),other to ChatMember("Maya (review)","","X"))
                Column(Modifier.fillMaxSize().background(Background).safeDrawingPadding()) {
                    Copy("NATIVE REVIEW FIXTURE · no network or signer",10,Orange,modifier=Modifier.fillMaxWidth().padding(8.dp))
                    ChatConversation(room,owner,rows,members,draft,"",false,System.currentTimeMillis(),{draft=it},{rows=rows+ChatMessage("fixture-${rows.size+1}",owner,System.currentTimeMillis()/1000,draft);draft=""},{},{finish()})
                }
            }
        }
    }
}
