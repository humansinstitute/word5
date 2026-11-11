package ai.otherstuff.word5

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.BackHandler
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
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription

val WebFont = FontFamily(Font(R.font.arimo_regular), Font(R.font.arimo_bold,FontWeight.Bold))
val Background = Color(0xFF121213)
val Panel = Color(0xFF1A1A1B)
val Border = Color(0xFF3A3A3C)
val Muted = Color(0xFF818384)
val Purple = Color(0xFF9333EA)
val Orange = Color(0xFFF97316)
fun markColor(mark: Int) = listOf(Border, Orange, Purple)[mark]
class MainActivity: ComponentActivity() {
    private val model: GameModel by viewModels()
    private val signerResult = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { model.amber.result(it) }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        model.amber.launch = { signerResult.launch(it) }
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = Purple, background = Background, surface = Panel)) {
                CompositionLocalProvider(LocalTextStyle provides TextStyle(color = Color.White, fontFamily = WebFont, fontSize = 14.sp, letterSpacing = 0.sp)) {
                    Word5Screen(model) { startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, model.shareText()), "Share Word5 result")) }
                }
            }
        }
    }
    override fun onDestroy() { model.amber.launch = null; super.onDestroy() }
}

@Composable fun Copy(text: String, size: Int = 14, color: Color = Color.White, bold: Boolean = false, modifier: Modifier = Modifier, align: TextAlign? = null) {
    Text(text, modifier, color = color, fontSize = size.sp, fontWeight = if(bold) FontWeight.Bold else FontWeight.Normal, textAlign = align, lineHeight = (size * 1.2f).sp)
}
@Composable fun WebButton(text: String, modifier: Modifier = Modifier, color: Color = Color(0xFF2A2A2B), primary: Boolean = false, compact: Boolean = false, horizontalPadding: Int = 12, onClick: () -> Unit) {
    Box(modifier.background(if(primary && color == Color(0xFF2A2A2B)) Purple else color, RoundedCornerShape(if(primary) 4.dp else 6.dp)).border(if(primary) 0.dp else 1.dp, if(primary) Color.Transparent else Border, RoundedCornerShape(6.dp)).clickable(onClick = onClick).padding(horizontal = horizontalPadding.dp, vertical = if(primary) 14.dp else if(compact) 9.dp else 11.dp), contentAlignment = Alignment.Center) {
        Copy(text, if(primary) 14 else 12, bold = primary, modifier=Modifier.height(if(primary)16.dp else if(text.contains("⚡"))20.dp else 14.dp), align = TextAlign.Center)
    }
}
@Composable fun RuleLine() { Box(Modifier.fillMaxWidth().height(1.dp).background(Border)) }
@Composable fun WebModal(close: () -> Unit, result: Boolean = false, cardMaxWidth: androidx.compose.ui.unit.Dp = 400.dp, cardPadding: androidx.compose.ui.unit.Dp = if(result)25.dp else 21.dp, cardRadius: androidx.compose.ui.unit.Dp = if(result)8.dp else 10.dp, heightFraction: Float = .9f, darkness: Float = if(result).5f else .6f, content: @Composable ColumnScope.() -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize().background(Color.Black.copy(alpha = darkness)).clickable(onClick = close), contentAlignment = Alignment.Center) {
        Column(Modifier.width(minOf(if(result) maxWidth * .9f else maxWidth * .92f, cardMaxWidth)).heightIn(max = maxHeight * heightFraction).background(if(result) Background else Panel, RoundedCornerShape(cardRadius)).border(1.dp, Border, RoundedCornerShape(cardRadius)).clickable(enabled = true, onClick = {}).verticalScroll(rememberScrollState()).padding(cardPadding), horizontalAlignment = if(result) Alignment.CenterHorizontally else Alignment.Start, content = content)
    }
}
@Composable fun ModalHeading(title: String, close: () -> Unit, size: Int = 18) {
    Row(Modifier.fillMaxWidth().padding(bottom = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
        Copy(title, size, bold = true); WebButton("Close", compact=true, onClick = close)
    }
}
@Composable fun StatsRow(m: GameModel) {
    val stats = statistics(m.state, m.rules)
    Row(Modifier.fillMaxWidth().padding(vertical = 16.dp), horizontalArrangement = Arrangement.spacedBy(24.dp,Alignment.CenterHorizontally)) {
        listOf(stats.played.toString() to "Played", (if(stats.played == 0) 0 else kotlin.math.round(stats.won * 100.0 / stats.played).toInt()).toString() to "Win %", stats.streak.toString() to "Streak", stats.best.toString() to "Max Streak").forEach { (n,label) ->
            Column(horizontalAlignment = Alignment.CenterHorizontally) { Copy(n, 32, bold = true,modifier=Modifier.height(39.dp)); Text(label,fontSize=11.sp,lineHeight=12.sp,color=Muted,modifier=Modifier.height(12.dp)) }
        }
    }
}
@Composable fun Word5Screen(m: GameModel, share: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    var modal by remember { mutableStateOf("") }
    var page by remember { mutableStateOf("Play") }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var toast by remember { mutableStateOf("") }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if(event == Lifecycle.Event.ON_RESUME) m.onResume() }
        lifecycle.addObserver(observer); onDispose { lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(Unit) { while(true) { delay(1000); now = System.currentTimeMillis(); if(now / 1000 % 60 == 0L && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) m.onResume() } }
    LaunchedEffect(m.noticeSerial) { if(m.notice.isNotEmpty()) { toast = m.notice; delay(1500); toast = "" } }
    val game = m.state.games[now / 86400000] ?: Game(now / 86400000, hard = m.state.hard)
    val target = m.rules.answer(game.period)
    val colors = mutableMapOf<Char, Int>()
    game.guesses.take(if(m.revealing) maxOf(0,game.guesses.size-1) else game.guesses.size).forEach { guess -> Rules.evaluate(guess, target).forEachIndexed { i, mark -> colors[guess[i]] = maxOf(colors[guess[i]] ?: 0, mark) } }
    val seconds = (86400000 - now % 86400000) / 1000
    val countdown = "%02d:%02d:%02d".format(seconds / 3600, seconds / 60 % 60, seconds % 60)
    val close = { modal = ""; m.resultOpen = false }
    BackHandler(menu || modal.isNotEmpty() || m.resultOpen || page!="Play") { if(menu)menu=false else if(modal.isNotEmpty() || m.resultOpen)close() else page="Play" }
    val focus=remember{FocusRequester()}
    LaunchedEffect(modal,page,menu,m.resultOpen){if(modal.isEmpty() && page=="Play" && !menu && !m.resultOpen)focus.requestFocus()}
    val shake=remember{Animatable(0f)}
    LaunchedEffect(m.noticeSerial){if(page=="Play" && m.notice.isNotEmpty() && !m.completed()){repeat(3){shake.animateTo(-5f,tween(50));shake.animateTo(5f,tween(50))};shake.snapTo(0f)}}
    Box(Modifier.fillMaxSize().background(Background).safeDrawingPadding().focusRequester(focus).onPreviewKeyEvent { event ->
        val key=event.nativeKeyEvent
        if(modal.isNotEmpty() || menu || m.resultOpen || page!="Play" || key.action!=android.view.KeyEvent.ACTION_DOWN || key.isCtrlPressed || key.isAltPressed || key.isMetaPressed)false
        else when(key.keyCode){android.view.KeyEvent.KEYCODE_ENTER->{m.key("ENTER");true};android.view.KeyEvent.KEYCODE_DEL->{m.key("⌫");true};else->{val c=key.unicodeChar.toChar().uppercaseChar();if(c in 'A'..'Z'){m.key(c.toString());true}else false}}
    }.focusable()) {
        BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            val viewportWidth = maxWidth
            val width = minOf(viewportWidth, 500.dp)
            val mobile = viewportWidth <= 480.dp
            val tile = (maxWidth * .12f).coerceIn(48.dp, 58.dp)
            val keyHeight = (maxWidth * .10f).coerceIn(48.dp, 58.dp)
            val keyGap = (maxWidth * .01f).coerceIn(4.dp, 6.dp)
            Column(Modifier.width(width).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally) {
                Row(Modifier.fillMaxWidth().height(if(mobile)62.dp else 63.dp).padding(horizontal = if(mobile)8.dp else 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                    Box(Modifier.size(36.dp).background(Panel,RoundedCornerShape(8.dp)).border(1.dp,Border,RoundedCornerShape(8.dp)).semantics{contentDescription="Menu"}.clickable { menu = !menu }, contentAlignment = Alignment.Center) { Canvas(Modifier.size(12.dp,10.dp)) { for(y in listOf(1f,5f,9f))drawLine(Color.White,androidx.compose.ui.geometry.Offset(0f,y.dp.toPx()),androidx.compose.ui.geometry.Offset(size.width,y.dp.toPx()),strokeWidth=1.2.dp.toPx()) } }
                    Row(verticalAlignment = Alignment.CenterVertically) { Text("WORD5",fontSize = if(mobile)20.sp else 32.sp,fontWeight = FontWeight.Bold,letterSpacing = if(mobile).8.sp else 3.2.sp); if(game.hard) Copy("*",10,Orange,true,Modifier.padding(start=8.dp)) }
                    Row(verticalAlignment = Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(if(mobile)0.dp else 4.dp)) {
                        Copy("⚡",16,Orange,modifier=Modifier.clickable { menu=false;modal="donate" }.padding(horizontal=8.dp,vertical=6.dp))
                        Copy("Play",if(mobile)12 else 14,if(page=="Play") Purple else Muted,true,Modifier.clickable { page="Play";menu=false }.padding(horizontal=if(mobile)5.dp else 12.dp,vertical=if(mobile)6.dp else 8.dp))
                        Copy("Social",if(mobile)12 else 14,if(page=="Social") Purple else Muted,true,Modifier.clickable { page="Social";menu=false }.padding(horizontal=if(mobile)5.dp else 12.dp,vertical=if(mobile)6.dp else 8.dp))
                        if(page=="Play")Box(Modifier.size(28.dp).border(2.dp,Border,RoundedCornerShape(50)).clickable { menu=false;modal="help" },contentAlignment=Alignment.Center) { Copy("?",14,Muted,true) }
                    }
                }
                RuleLine()
                if(page=="Play") {
                    Column(Modifier.weight(1f).padding(top=8.dp).verticalScroll(rememberScrollState()),horizontalAlignment=Alignment.CenterHorizontally) {
                        Column(Modifier.padding(10.dp), verticalArrangement=Arrangement.spacedBy(5.dp)) {
                            repeat(6) { row ->
                                Row(Modifier.offset(x=if(row==game.guesses.size)shake.value.dp else 0.dp),horizontalArrangement=Arrangement.spacedBy(5.dp)) {
                                    val guess=game.guesses.getOrNull(row); val marks=guess?.let { Rules.evaluate(it,target) }
                                    repeat(5) { col ->
                                        val letter=guess?.getOrNull(col) ?: if(row==game.guesses.size && !m.completed()) m.draft.getOrNull(col) else null
                                        BoardTile(letter,marks?.get(col),tile,(viewportWidth.value*.06f).coerceIn(24f,32f),m.revealing && row==game.guesses.lastIndex,col)
                                    }
                                }
                            }
                        }
                        Copy("Next word in: $countdown",14,Muted,modifier=Modifier.padding(vertical=8.dp))
                        if(m.profileName.isNotBlank()) Copy(m.profileName,14,Muted,modifier=Modifier.padding(bottom=8.dp))
                    }
                    Column(Modifier.fillMaxWidth().padding(start=20.dp,end=20.dp,bottom=16.dp,top=8.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
                        listOf("QWERTYUIOP".map { it.toString() },"ASDFGHJKL".map { it.toString() },listOf("ENTER")+"ZXCVBNM".map { it.toString() }+"⌫").forEach { row ->
                            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(keyGap,Alignment.CenterHorizontally)) {
                                val weightSum=row.sumOf { if(it.length>1)1.5 else 1.0 }.toFloat()
                                val free=maxOf(0f,width.value-40f-keyGap.value*(row.size-1)-4f*row.size)
                                row.forEach { key ->
                                    val keyWidth=minOf(if(key.length>1)65f else 44f,free*(if(key.length>1)1.5f else 1f)/weightSum+4f)
                                    Box(Modifier.width(keyWidth.dp).height(keyHeight).background(if(key.length==1 && colors.containsKey(key[0])) markColor(colors.getValue(key[0])) else Muted,RoundedCornerShape(4.dp)).clickable { m.key(key) },contentAlignment=Alignment.Center) {
                                        Text(key,fontSize=if(key.length>1) (viewportWidth.value*.025f).coerceIn(10f,12f).sp else (viewportWidth.value*.03f).coerceIn(11f,14f).sp,fontWeight=FontWeight.Bold)
                                    }
                                }
                            }
                        }
                    }
                } else SocialScreen(m, { modal=it }, share)
            }
            if(menu) {
                Box(Modifier.fillMaxSize().clickable { menu=false })
                Column(Modifier.align(Alignment.TopStart).padding(start=(maxWidth-width)/2+8.dp,top=57.dp).width(240.dp).heightIn(max=maxHeight-65.dp).background(Panel,RoundedCornerShape(8.dp)).border(1.dp,Border,RoundedCornerShape(8.dp)).verticalScroll(rememberScrollState()).padding(13.dp)) {
                    ToggleRow("Hard Mode",if(game.guesses.isEmpty()) "Must use revealed hints" else "Only at puzzle start",m.state.hard,game.guesses.isEmpty() && !m.completed()) { m.toggleHard() }
                    ToggleRow("Encrypted Sync",if(m.publicBusy) "Amber action · tap to cancel" else if(m.owner.isEmpty()) if(m.message.contains("failed")) "Amber unavailable · tap to retry" else "Sign in for automatic backup" else if(!m.syncEnabled) "Paused · tap to resume" else if(m.syncing) "Syncing… · tap to cancel" else if(m.message.startsWith("Encrypted backup")) "Up to date · tap to sync" else "Backup pending · tap to retry",m.owner.isNotEmpty() && m.syncEnabled,m.owner.isNotEmpty() && !m.publicBusy, { if(m.publicBusy || m.syncing)m.cancel() else if(m.owner.isEmpty())m.login() else m.sync(true) }) { m.toggleSync() }
                    Copy(if(m.owner.isEmpty()) "Session: offline player" else "Amber: ${m.owner.take(8)}…${m.owner.takeLast(4)}",12,modifier=Modifier.padding(bottom=10.dp).height(14.dp))
                    WebButton(if(m.owner.isEmpty()) "Login with Amber" else "Switch Amber account",Modifier.fillMaxWidth().padding(bottom=6.dp),color=Purple) { menu=false;m.login() }
                    WebButton("My Profile",Modifier.fillMaxWidth().padding(bottom=6.dp)) { menu=false;modal="profile" }
                    WebButton("New Player",Modifier.fillMaxWidth().padding(bottom=6.dp)) { menu=false;modal="new" }
                    WebButton("Check my streak",Modifier.fillMaxWidth().padding(top=8.dp,bottom=6.dp),color=Purple) { menu=false;modal="stats";m.sync() }
                    WebButton("Donate ⚡",Modifier.fillMaxWidth().padding(top=4.dp,bottom=6.dp),color=Orange) { menu=false;modal="donate" }
                    Copy("Version ${BuildConfig.VERSION_NAME}",11,Muted,modifier=Modifier.fillMaxWidth().padding(top=8.dp),align=TextAlign.Center)
                }
            }
        }
        if(m.resultOpen && modal.isEmpty()) {
            WebModal(close,result=true) {
                val result=m.resultCount(); val won=result in 1..6
                Copy(if(won) listOf("Genius!","Magnificent!","Impressive!","Splendid!","Great!","Phew!")[result-1] else "Better luck next time!",20,bold=true,modifier=Modifier.height(25.dp))
                Copy(if(won) "You got it in $result ${if(result==1) "guess" else "guesses"}!" else "The word was:",14,Muted,modifier=Modifier.padding(top=16.dp,bottom=16.dp).height(16.dp))
                Text(target,fontSize=24.sp,fontWeight=FontWeight.Bold,letterSpacing=4.8.sp,color=Purple,modifier=Modifier.height(29.dp))
                StatsRow(m); RuleLine()
                Copy("NEXT WORD",12,Muted,modifier=Modifier.padding(top=16.dp,bottom=4.dp).height(14.dp))
                Text(countdown,color=Color.White,fontSize=28.sp,fontWeight=FontWeight.Bold,lineHeight=34.sp,style=TextStyle(fontFeatureSettings="tnum"),modifier=Modifier.height(34.dp))
                WebButton("Discuss today’s game",primary=true,horizontalPadding=24) { modal="chat" }
                if(m.donationDue) { Spacer(Modifier.height(16.dp));RuleLine();Copy("Word5 is a free game, but hosted on real servers. If you find it valuable, please consider donating",14,Muted,modifier=Modifier.padding(vertical=12.dp),align=TextAlign.Center);WebButton("Donate",Modifier.fillMaxWidth(),color=Orange) { modal="donate" } }
                Row(Modifier.fillMaxWidth().padding(top=16.dp),horizontalArrangement=Arrangement.spacedBy(10.dp)) {
                    WebButton("Share",Modifier.weight(1f),primary=true,onClick=share)
                    WebButton("Post to Nostr",Modifier.weight(1f),color=Color(0xFF8B5CF6),primary=true) { modal="post" }
                }
                Spacer(Modifier.height(8.dp))
                WebButton("Retry score / restore history",Modifier.fillMaxWidth(),primary=true) { modal="score" }
                if(m.publicStatus.isNotEmpty()) Copy(m.publicStatus,12,Muted,modifier=Modifier.padding(top=6.dp),align=TextAlign.Center)
                if(m.historyNeedsRefresh)Copy("Some earlier corrected streak details need a history refresh.",11,Orange,modifier=Modifier.padding(top=8.dp),align=TextAlign.Center)
                Spacer(Modifier.height(12.dp))
            }
        }
        when(modal) {
            "help" -> WebModal(close,heightFraction=.8f) {
                ModalHeading("How to Play",close,16)
                Text("Guess the 5-letter word in 6 tries. A new word appears every 24 hours. After each guess, the tiles change colour to show how close you are.",fontSize=13.sp,lineHeight=19.5.sp,color=Color(0xFFB0B0B0))
                Spacer(Modifier.height(12.dp))
                listOf(Purple to "Purple — correct letter in the correct spot", Orange to "Orange — correct letter but in the wrong spot", Border to "Grey — letter is not in the word").forEach { (color,text) ->
                    Row(Modifier.padding(bottom=10.dp),verticalAlignment=Alignment.CenterVertically) { Box(Modifier.size(32.dp).background(color,RoundedCornerShape(4.dp)));Text(buildAnnotatedString { val parts=text.split(" — ",limit=2);withStyle(SpanStyle(fontWeight=FontWeight.Bold)){append(parts[0])};append(" — "+parts[1]) },fontSize=13.sp,lineHeight=18.2.sp,modifier=Modifier.padding(start=12.dp)) }
                }
                Text("The keyboard also updates with these colours to help you track which letters you've used.",fontSize=12.sp,lineHeight=18.sp,color=Muted,modifier=Modifier.padding(top=4.dp,bottom=18.dp))
            }
            "stats" -> WebModal(close) {
                ModalHeading("My Stats",close)
                val stats=statistics(m.state,m.rules)
                Row(Modifier.fillMaxWidth().padding(bottom=20.dp),horizontalArrangement=Arrangement.spacedBy(16.dp)) {
                    StatPanel(stats.streak.toString(),"CURRENT STREAK",Purple,Modifier.weight(1f),32)
                    StatPanel(stats.best.toString(),"BEST STREAK",Orange,Modifier.weight(1f),32)
                }
                Row(Modifier.fillMaxWidth().padding(bottom=20.dp),horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                    StatPanel(stats.played.toString(),"Played",Color.White,Modifier.weight(1f),24)
                    StatPanel(stats.won.toString(),"Won",Color.White,Modifier.weight(1f),24)
                    StatPanel("${if(stats.played==0)0 else kotlin.math.round(stats.won*100.0/stats.played).toInt()}%","Win Rate",Color.White,Modifier.weight(1f),24)
                }
                RuleLine();Copy(if(m.historyNeedsRefresh)"Some earlier corrected streak details need a history refresh." else "Complete encrypted history and verified web games",11,if(m.historyNeedsRefresh)Orange else Muted,modifier=Modifier.padding(top=12.dp))
                if(m.historyNeedsRefresh)WebButton("Refresh history",Modifier.fillMaxWidth().padding(top=8.dp)){m.sync(true)}
                var distribution by remember { mutableStateOf(false) }
                Copy("Guess distribution ${if(distribution) "▴" else "▾"}",12,Muted,modifier=Modifier.fillMaxWidth().clickable { distribution=!distribution }.padding(top=12.dp))
                if(distribution)stats.distribution.forEachIndexed { i,n -> Row(Modifier.fillMaxWidth().padding(vertical=3.dp),verticalAlignment=Alignment.CenterVertically) { Copy("${i+1}",12,modifier=Modifier.width(20.dp));Box(Modifier.fillMaxWidth(maxOf(.08f,n.toFloat()/maxOf(1,stats.distribution.maxOrNull()?:1))).background(Purple).padding(horizontal=6.dp,vertical=2.dp)) { Copy(n.toString(),12,bold=true) } } }
                if(m.state.baseline!=null)Copy("Earlier totals are preserved; some older games lack distribution details.",11,Muted,modifier=Modifier.padding(top=12.dp))
            }
            "new" -> WebModal(close) { ModalHeading("New Player",close);Copy("Your current account's save stays on this device and in its encrypted backup. Choose another account in Amber, or return to offline play.",13,Muted);WebButton("Choose account in Amber",Modifier.fillMaxWidth().padding(top=16.dp),primary=true) { close();m.login() };if(m.owner.isNotEmpty())WebButton("Sign out",Modifier.fillMaxWidth().padding(top=8.dp)) { close();m.signOut() } }
            "chat" -> WebModal(close) { ModalHeading("Daily chat",close);Copy("Daily group chat is not supported by the web app’s Amber sign-in. Your native Amber account can play, restore encrypted stats and explicitly post results. Chat remains unavailable for this sign-in method.",13,Muted) }
            "post" -> WebModal(close,result=true) { Copy("Post to Nostr?",20,bold=true);Text(m.shareText(),color=Color.White,fontFamily=FontFamily.Monospace,fontSize=12.sp,lineHeight=16.2.sp,modifier=Modifier.fillMaxWidth().padding(top=12.dp).heightIn(max=220.dp).background(Background).border(1.dp,Border,RoundedCornerShape(6.dp)).verticalScroll(rememberScrollState()).padding(13.dp));Copy("Your active Amber account will be used after you confirm. This publishes your result and summary statistics publicly and records today’s score with Word5. Guesses go only to Word5 for score validation, never to public relays.",12,Muted,modifier=Modifier.padding(top=12.dp));Row(Modifier.padding(top=16.dp),horizontalArrangement=Arrangement.spacedBy(10.dp)) { WebButton("Cancel",Modifier.weight(1f),color=Border,primary=true) { modal="" };WebButton("Post",Modifier.weight(1f),primary=true) { modal="";m.postResult() } } }
            "score" -> WebModal(close) { ModalHeading("Score / restore history",close);Copy("Restore is private. Recording a score sends today's guesses and result to Word5's public scoreboard. It happens only if you choose to record it.",13,Muted);WebButton("Restore encrypted history",Modifier.fillMaxWidth().padding(top=12.dp)) { m.sync(true) };if(m.completed())WebButton("Record today's score publicly",Modifier.fillMaxWidth().padding(top=8.dp),primary=true) { modal="";m.recordScore() } }
            "donate" -> DonateModal(close)
            "profile" -> ProfileModal(m,close)
        }
        if(toast.isNotEmpty()) Box(Modifier.align(Alignment.TopCenter).padding(top=80.dp).background(Color.White,RoundedCornerShape(4.dp)).padding(horizontal=24.dp,vertical=14.dp)) { Copy(toast,14,Background,true) }
    }
}
@Composable fun ToggleRow(label: String, sublabel: String, checked: Boolean, enabled: Boolean, statusClick: (() -> Unit)? = null, click: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical=10.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.SpaceBetween) {
        Column(Modifier.weight(1f).then(if(statusClick!=null)Modifier.clickable(onClick=statusClick) else Modifier).padding(end=6.dp)) { Copy(label,12,bold=true,modifier=Modifier.height(15.dp));Spacer(Modifier.height(2.dp));Copy(sublabel,10,Muted,modifier=Modifier.height(12.dp)) }
        Box(Modifier.size(44.dp,24.dp).background(if(checked) Purple.copy(alpha=if(enabled)1f else .5f) else Border,RoundedCornerShape(24.dp)).clickable(enabled=enabled,onClick=click)) { Box(Modifier.align(if(checked) Alignment.CenterEnd else Alignment.CenterStart).padding(horizontal=3.dp).size(18.dp).background(Color.White.copy(alpha=if(enabled)1f else .5f),RoundedCornerShape(50))) }
    }
    RuleLine();Spacer(Modifier.height(10.dp))
}
@Composable fun StatPanel(value:String,label:String,color:Color,modifier:Modifier,size:Int) {
    Column(modifier.background(Color(0xFF2A2A2B),RoundedCornerShape(8.dp)).padding(if(size==32)16.dp else 12.dp),horizontalAlignment=Alignment.CenterHorizontally) { Copy(value,size,color,true);Copy(label,if(size==32)11 else 10,Muted) }
}
@Composable fun BoardTile(letter:Char?,mark:Int?,size:androidx.compose.ui.unit.Dp,fontSize:Float,reveal:Boolean,column:Int) {
    val rotation=remember{Animatable(0f)};val scale=remember{Animatable(1f)};var shown by remember(mark,reveal){mutableStateOf(!reveal)}
    LaunchedEffect(reveal,mark) { if(reveal && mark!=null) { shown=false;delay(column*300L);rotation.animateTo(90f,tween(250));shown=true;rotation.snapTo(-90f);rotation.animateTo(0f,tween(250)) } else { shown=true;rotation.snapTo(0f) } }
    LaunchedEffect(letter) { if(letter!=null && mark==null){scale.animateTo(1.1f,tween(50));scale.animateTo(1f,tween(50))} }
    val color=if(shown)mark?.let{markColor(it)} else null
    Box(Modifier.size(size).graphicsLayer{rotationX=rotation.value;scaleX=scale.value;scaleY=scale.value;cameraDistance=8*density}.background(color?:Background).border(2.dp,color?:if(letter==null)Border else Color(0xFF565758)),contentAlignment=Alignment.Center) {Text(letter?.toString()?:"",fontSize=fontSize.sp,fontWeight=FontWeight.Bold)}
}
