package ai.otherstuff.word5

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.*
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable fun ChatScreen(m:GameModel,back:()->Unit) {
    var confirm by remember(m.owner){mutableStateOf(false)}
    var now by remember{mutableLongStateOf(System.currentTimeMillis())}
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    DisposableEffect(Unit){m.setChatVisible(true);onDispose{m.setChatVisible(false)}}
    LaunchedEffect(m.owner){if(m.owner.isNotEmpty() && m.chatRoom==null)m.openChat()}
    LaunchedEffect(Unit){var ticks=0;while(true){delay(1000);now=System.currentTimeMillis();m.chatTick();ticks++;if(ticks%10==0 && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) && m.chatRoom!=null)m.refreshChat(false)}}
    Box(Modifier.fillMaxSize()) {
        val room=m.chatRoom
        if(room!=null) ChatConversation(room,m.owner,m.chatMessages,m.chatMembers,m.chatDraft,m.chatStatus,m.chatBusy,now,m::editChat,m::sendChat,{if(m.chatBusy)m.cancelChat()else m.refreshChat()},back)
        else Column(Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState())) {
            Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.SpaceBetween){Copy("Daily chat",21,bold=true);WebButton("Back",compact=true,onClick=back)}
            Copy("One group for today’s finishers",14,Muted,modifier=Modifier.padding(top=12.dp))
            Copy("The room is named for the date and word. Messages use a fresh shared server-generated key each day. The room, key and draft disappear when the next word starts.",13,Muted,modifier=Modifier.padding(top=16.dp))
            Copy(m.chatStatus,13,if(m.chatBusy)Muted else Color.White,modifier=Modifier.padding(top=20.dp))
            when {
                m.owner.isEmpty()->WebButton("Login with Amber",Modifier.fillMaxWidth().padding(top=18.dp),primary=true){m.login()}
                m.chatBusy->WebButton("Cancel chat action",Modifier.fillMaxWidth().padding(top=18.dp)){m.cancelChat()}
                else->{
                    WebButton("Check existing chat",Modifier.fillMaxWidth().padding(top=18.dp)){m.openChat()}
                    if(m.completed() && m.state.current().guesses.isNotEmpty()) {
                        Copy("Your native save is private. Unlocking chat is separate: Word5 receives today’s ordered guesses to validate your result and record its score. This does not post to public Nostr relays.",12,Muted,modifier=Modifier.padding(top=16.dp))
                        WebButton("Validate result and unlock chat",Modifier.fillMaxWidth().padding(top=14.dp),primary=true){confirm=true}
                    } else if(m.completed()) Copy("This restored result has no original guesses. You can join only if its completion was already verified by Word5. Missing guesses will never be invented.",12,Muted,modifier=Modifier.padding(top=16.dp))
                    else WebButton("Return to today’s puzzle",Modifier.fillMaxWidth().padding(top=14.dp),primary=true,onClick=back)
                }
            }
        }
        if(confirm)WebModal({confirm=false},result=true){
            Copy("Validate result and unlock chat?",20,bold=true)
            Copy("Word5 will receive today’s ordered guesses, result and account signature to validate completion and record your score. Your encrypted backup stays separate. No public Nostr post is created.",13,Muted,modifier=Modifier.padding(top=16.dp))
            Copy("Chat is encrypted with a shared daily key held by the server and today’s finishers; participants can retain copies.",12,Muted,modifier=Modifier.padding(top=12.dp))
            Row(Modifier.padding(top=18.dp),horizontalArrangement=Arrangement.spacedBy(10.dp)){WebButton("Cancel",Modifier.weight(1f)){confirm=false};WebButton("Join chat",Modifier.weight(1f),primary=true){confirm=false;m.unlockChat()}}
        }
    }
}

/** Native-only view; debug review fixtures cannot call a signer or API. */
@Composable fun ChatConversation(room:ChatRoom,owner:String,messages:List<ChatMessage>,members:Map<String,ChatMember>,draft:String,status:String,busy:Boolean,now:Long,onDraft:(String)->Unit,onSend:()->Unit,onRefresh:()->Unit,onBack:()->Unit) {
    val list=rememberLazyListState()
    var previousCount by remember(room.period){mutableIntStateOf(0)}
    LaunchedEffect(messages.lastOrNull()?.id){
        val follow=messages.lastOrNull()?.pubkey==owner || previousCount==0 || list.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let{it>=previousCount-2}!=false
        if(messages.isNotEmpty()&&follow)list.scrollToItem(messages.lastIndex)
        previousCount=messages.size
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        Column(Modifier.fillMaxWidth().background(Panel).padding(16.dp)) {
            Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.SpaceBetween){Column(Modifier.weight(1f)){Copy("${room.date} · ${room.word}",19,bold=true);Copy("Today’s finishers · spoilers welcome",12,Muted,modifier=Modifier.padding(top=4.dp))};WebButton("Back",compact=true,onClick=onBack)}
            val seconds=maxOf(0,(room.expiresAt-now)/1000)
            Row(Modifier.fillMaxWidth().padding(top=14.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.SpaceBetween){WebButton(if(busy)"Cancel" else "Refresh",compact=true,onClick=onRefresh);Copy("Closes in ${seconds/3600}h ${seconds%3600/60}m",11,Muted)}
        }
        RuleLine()
        if(messages.isEmpty())Box(Modifier.weight(1f).fillMaxWidth().padding(24.dp),contentAlignment=Alignment.Center){Column(horizontalAlignment=Alignment.CenterHorizontally){Copy("You made it. Let’s talk.",18,bold=true);Copy("How did you find today’s word? Be the first to start the conversation.",13,Muted,modifier=Modifier.padding(top=12.dp))}}
        else LazyColumn(Modifier.weight(1f).fillMaxWidth(),state=list,contentPadding=PaddingValues(12.dp),verticalArrangement=Arrangement.spacedBy(16.dp)) {
            items(messages,key={it.id}){message->ChatMessageRow(message,members[message.pubkey],message.pubkey==owner)}
        }
        Column(Modifier.fillMaxWidth().background(Panel).padding(12.dp)) {
            if(status.isNotEmpty())Copy(status,12,Color(0xFFD8B4FE),modifier=Modifier.padding(bottom=10.dp))
            Row(Modifier.fillMaxWidth().background(Color(0xFF292330),RoundedCornerShape(14.dp)).border(1.dp,Color(0xFF483751),RoundedCornerShape(14.dp)).padding(6.dp),verticalAlignment=Alignment.Bottom,horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                Box(Modifier.weight(1f).heightIn(min=42.dp,max=120.dp).padding(8.dp)){
                    if(draft.isEmpty())Copy("Message the group…",15,Muted)
                    BasicTextField(draft,onDraft,Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).semantics{contentDescription="Message the group"},textStyle=TextStyle(color=Color.White,fontSize=16.sp,fontFamily=WebFont),cursorBrush=SolidColor(Purple))
                }
                Box(Modifier.height(42.dp).width(58.dp).background(if(!busy&&draft.isNotBlank())Purple else Border,RoundedCornerShape(10.dp)).clickable(enabled=!busy&&draft.isNotBlank(),onClick=onSend),contentAlignment=Alignment.Center){Copy("Send",13,bold=true)}
            }
            Copy("Encrypted group · closes with the next word",10,Muted,modifier=Modifier.padding(top=8.dp))
        }
    }
}
@Composable private fun ChatMessageRow(message:ChatMessage,member:ChatMember?,own:Boolean) {
    val name=member?.name.orEmpty().ifEmpty{if(own)"You" else message.pubkey.take(6)+"…"+message.pubkey.takeLast(4)}
    Row(Modifier.fillMaxWidth(),horizontalArrangement=if(own)Arrangement.End else Arrangement.Start,verticalAlignment=Alignment.Bottom){
        if(!own)Avatar(member?.picture.orEmpty(),name,Modifier.padding(end=8.dp).size(32.dp))
        Column(Modifier.widthIn(max=300.dp).weight(1f,fill=false)) {
            Row(Modifier.padding(horizontal=4.dp).fillMaxWidth(),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(6.dp)) {
                Text(name,maxLines=1,overflow=TextOverflow.Ellipsis,fontSize=11.sp,color=Color(0xFFD6CBDD),modifier=Modifier.weight(1f))
                if(own&&name!="You")Copy("You",10,Muted)
                member?.result?.takeIf{it.isNotEmpty()}?.let { result->Copy("$result/6",11,Color(0xFFD8B4FE),true,Modifier.semantics{contentDescription=if(result=="X")"6 guesses · not solved"else"$result of 6 guesses"}) }
                Copy(DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault()).format(Instant.ofEpochSecond(message.createdAt)),10,Muted)
            }
            Copy(message.text,14,modifier=Modifier.padding(top=6.dp).background(if(own)Color(0xFF7036AD)else Color(0xFF28232E),RoundedCornerShape(topStart=16.dp,topEnd=16.dp,bottomStart=if(own)16.dp else 4.dp,bottomEnd=if(own)4.dp else 16.dp)).border(1.dp,if(own)Color(0xFF8547C2)else Color(0xFF3C3443),RoundedCornerShape(topStart=16.dp,topEnd=16.dp,bottomStart=if(own)16.dp else 4.dp,bottomEnd=if(own)4.dp else 16.dp)).padding(12.dp))
        }
        if(own)Avatar(member?.picture.orEmpty(),name,Modifier.padding(start=8.dp).size(32.dp))
    }
}
