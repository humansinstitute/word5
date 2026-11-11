package ai.otherstuff.word5

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay

private val Neon = Color(0xFFADFF2F)
private val Ink = Color(0xFF0A0A0A)
private fun markColor(mark: Int) = listOf(Color(0xFF333333), Color(0xFFB59F3B), Color(0xFF538D4E))[mark]
class MainActivity: ComponentActivity() {
    private val model: GameModel by viewModels()
    private val signerResult = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { model.amber.result(it) }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        model.amber.launch = { signerResult.launch(it) }
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = Neon, background = Ink, surface = Color(0xFF181818))) {
                GameScreen(model) { startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, model.shareText()), "Share Word5 result")) }
            }
        }
    }
    override fun onDestroy() { model.amber.launch = null; super.onDestroy() }
}
@Composable fun GameScreen(m: GameModel, share: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    var help by remember { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if(event == Lifecycle.Event.ON_RESUME) m.onResume() }
        lifecycle.addObserver(observer); onDispose { lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(Unit) { while(true) { delay(1000); now = System.currentTimeMillis(); if(now / 1000 % 60 == 0L && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) m.onResume() } }
    val game = m.state.games[now / 86400000] ?: Game(now / 86400000, hard = m.state.hard)
    val target = m.rules.answer(game.period)
    val colors = mutableMapOf<Char, Int>()
    game.guesses.forEach { guess -> Rules.evaluate(guess, target).forEachIndexed { i, mark -> colors[guess[i]] = maxOf(colors[guess[i]] ?: 0, mark) } }
    val seconds = (86400000 - now % 86400000) / 1000
    val countdown = "%02d:%02d:%02d".format(seconds / 3600, seconds / 60 % 60, seconds % 60)
    Surface(Modifier.fillMaxSize(), color = Ink) {
        Column(Modifier.safeDrawingPadding().fillMaxSize().padding(horizontal = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Row(Modifier.fillMaxWidth().height(58.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                TextButton(onClick = { help = true }) { Text("?") }
                Text("WORD5", color = Neon, fontSize = 32.sp, fontWeight = FontWeight.Black, letterSpacing = 5.sp)
                Box { TextButton(onClick = { menu = true }) { Text("☰", fontSize = 24.sp) }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem(text = { Text(if(m.owner.isEmpty()) "Sign in with Amber" else "Switch Amber account") }, onClick = { menu = false; m.login() })
                        DropdownMenuItem(text = { Text("Statistics") }, onClick = { menu = false; m.resultOpen = true })
                        DropdownMenuItem(text = { Text("Hard mode: ${if(m.state.hard) "on" else "off"}") }, onClick = { menu = false; m.toggleHard() })
                        if(m.owner.isNotEmpty()) DropdownMenuItem(text = { Text("Sign out") }, onClick = { menu = false; m.signOut() })
                    }
                }
            }
            Text("DAILY #${game.period % 1000}${if(game.hard) " · HARD" else ""}   •   NEXT $countdown", color = Color.LightGray, fontSize = 12.sp)
            Column(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                BoxWithConstraints(Modifier.fillMaxWidth().widthIn(max = 350.dp).aspectRatio(5f / 6.1f)) {
                    val tile = minOf((maxWidth - 24.dp) / 5, (maxHeight - 30.dp) / 6)
                    Column(verticalArrangement = Arrangement.spacedBy(5.dp), horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.align(Alignment.Center)) {
                        repeat(6) { row ->
                            Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                                val guess = game.guesses.getOrNull(row)
                                val marks = guess?.let { Rules.evaluate(it, target) }
                                repeat(5) { col ->
                                    val letter = guess?.getOrNull(col) ?: if(row == game.guesses.size && !m.completed()) m.draft.getOrNull(col) else null
                                    Box(Modifier.size(tile).background(if(marks == null) Ink else markColor(marks[col]), RoundedCornerShape(3.dp)).border(1.dp, if(letter == null) Color(0xFF303030) else Color(0xFF777777), RoundedCornerShape(3.dp)), contentAlignment = Alignment.Center) {
                                        Text(letter?.toString() ?: "", fontSize = 28.sp, fontWeight = FontWeight.Bold, color = Color.White)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Text(m.message, Modifier.fillMaxWidth().padding(vertical = 5.dp), color = Color.LightGray, fontSize = 12.sp, minLines = 2)
            if(m.owner.isEmpty()) TextButton(onClick = { m.login() }, enabled = !m.syncing) { Text("Sign in with Amber · encrypted backup") }
            else Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Amber · ${m.owner.take(8)}…", fontSize = 12.sp, color = Neon)
                TextButton(onClick = { if(m.syncing) m.cancel() else m.sync(true) }) { Text(if(m.syncing) "Cancel sync" else "Retry backup") }
            }
            listOf("QWERTYUIOP".map { it.toString() }, "ASDFGHJKL".map { it.toString() }, listOf("ENTER") + "ZXCVBNM".map { it.toString() } + "⌫").forEach { row ->
                Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    row.forEach { key ->
                        Box(Modifier.weight(if(key.length > 1) 1.5f else 1f).height(51.dp).background(if(key.length == 1 && colors.containsKey(key[0])) markColor(colors.getValue(key[0])) else Color(0xFF555555), RoundedCornerShape(5.dp)).clickable { m.key(key) }, contentAlignment = Alignment.Center) {
                            Text(key, color = Color.White, fontSize = if(key.length > 1) 11.sp else 17.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
    if(help) AlertDialog(onDismissRequest = { help = false }, title = { Text("How to play") }, text = { Text("Guess the five-letter word in six tries. Green means the right letter and position. Yellow means the letter is elsewhere. Grey means it is absent. A new puzzle starts at midnight UTC.\n\nHard mode requires all revealed clues. Play works offline. Amber holds your key and encrypts your complete save. Remember its permissions for automatic backup. Scores stay private unless you share a result.") }, confirmButton = { TextButton(onClick = { help = false }) { Text("Play") } })
    if(m.resultOpen) {
        val stats = statistics(m.state, m.rules)
        AlertDialog(onDismissRequest = { m.resultOpen = false }, title = { Text(if(m.completed()) if(m.rules.won(game)) "Brilliant!" else "Today's game complete" else "Statistics", color = Neon) }, text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                if(m.completed()) Text("The word was $target\nNext puzzle in $countdown\n")
                Text("${stats.played} played     ${if(stats.played == 0) 0 else stats.won * 100 / stats.played}% wins\n${stats.streak} streak     ${stats.best} best streak", fontSize = 20.sp)
                Text("\nGuess distribution", fontWeight = FontWeight.Bold)
                stats.distribution.forEachIndexed { index, count -> Row(Modifier.padding(vertical = 2.dp)) { Text("${index + 1}  "); Text(" $count ", Modifier.fillMaxWidth(maxOf(0.08f, count.toFloat() / maxOf(1, stats.distribution.maxOrNull() ?: 1))).background(Color(0xFF538D4E))) } }
                if(m.state.baseline != null) Text("Earlier totals are preserved. Distribution includes recorded games; some older totals lack per-game details.", fontSize = 12.sp)
                Text("\n" + m.message, fontSize = 12.sp)
            }
        }, confirmButton = { TextButton(onClick = { m.resultOpen = false }) { Text("Close") } }, dismissButton = { if(m.completed()) TextButton(onClick = share) { Text("Share result") } })
    }
}
