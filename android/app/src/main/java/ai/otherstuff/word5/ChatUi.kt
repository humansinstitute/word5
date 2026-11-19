package ai.otherstuff.word5

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.*
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.draw.clip
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
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

class ChatScrollMemory(val list:LazyListState=LazyListState()) {
    var count=0;var lastMessage:String?=null;var initialized=false
}
/** One navigation row; room details stay available without occupying conversation space. */
@Composable fun ChatToolbar(selected:Long,today:Long,room:ChatRoom?,busy:Boolean,now:Long,onMenu:()->Unit,onSelect:(Long)->Unit,onRefresh:()->Unit) {
    var details by remember(selected){mutableStateOf(false)}
    BackHandler(details){details=false}
    val current=selected==today
    Row(Modifier.fillMaxWidth().background(Panel).heightIn(min=56.dp).padding(horizontal=4.dp),verticalAlignment=Alignment.CenterVertically) {
        Box(Modifier.size(44.dp).semantics{contentDescription="Menu"}.clickable(onClick=onMenu),contentAlignment=Alignment.Center){Copy("☰",22)}
        Column(Modifier.weight(1f).clickable{details=true}.padding(horizontal=4.dp,vertical=6.dp).semantics{contentDescription="Chat room details"}) {
            Text((if(current)"Today"else"Yesterday")+" · "+(room?.word?:"Chat"),maxLines=1,overflow=TextOverflow.Ellipsis,color=Color.White,fontSize=15.sp,fontFamily=WebFont)
            Copy(room?.date?:java.time.LocalDate.ofEpochDay(selected).toString(),10,Muted)
        }
        Box(Modifier.heightIn(min=44.dp).semantics{contentDescription=if(current)"See yesterday’s chat"else"See today’s chat"}.clickable{onSelect(if(current)today-1 else today)}.padding(horizontal=8.dp),contentAlignment=Alignment.Center){Copy(if(current)"Yesterday"else"Today",12,Color(0xFFD8B4FE),true)}
        Box(Modifier.size(44.dp).semantics{contentDescription=if(busy)"Cancel chat action"else"Refresh messages"}.clickable(onClick=onRefresh),contentAlignment=Alignment.Center){Copy(if(busy)"×"else"↻",25)}
    }
    RuleLine()
    if(details)WebModal({details=false}) {
        Copy("${if(current)"Today’s"else"Yesterday’s"} chat",20,bold=true)
        Copy(room?.let{"${it.date} · ${it.word}"}?:java.time.LocalDate.ofEpochDay(selected).toString(),16,modifier=Modifier.padding(top=12.dp))
        Copy("Finishers only · spoilers welcome",13,Muted,modifier=Modifier.padding(top=8.dp))
        room?.let { val seconds=maxOf(0,(it.expiresAt-now)/1000);Copy("Closes in ${seconds/3600}h ${seconds%3600/60}m",13,Muted,modifier=Modifier.padding(top=12.dp)) }
        WebButton("Close",Modifier.fillMaxWidth().padding(top=16.dp)){details=false}
    }
}
@Composable fun ChatScreen(m:GameModel,onMenu:()->Unit,back:()->Unit) {
    var confirm by remember(m.owner,m.selectedChatPeriod){mutableStateOf(false)}
    var now by remember{mutableLongStateOf(System.currentTimeMillis())}
    val scrolls=remember(m.owner){mutableMapOf<Long,ChatScrollMemory>()}
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle){
        val observer=androidx.lifecycle.LifecycleEventObserver{_,_->m.setChatVisible(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED),syncWhenHidden=false)}
        lifecycle.addObserver(observer);m.setChatVisible(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED),syncWhenHidden=false)
        onDispose{lifecycle.removeObserver(observer);m.setChatVisible(false)}
    }
    LaunchedEffect(m.owner){if(m.owner.isNotEmpty()&&m.chatRoom==null)m.openChat()}
    LaunchedEffect(Unit){var ticks=0;while(true){delay(1000);now=System.currentTimeMillis();m.chatTick();ticks++;if(ticks%10==0&&lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)&&m.chatRoom!=null)m.refreshChat(false)}}
    val today=Rules.period(now);val yesterday=m.selectedChatPeriod==today-1
    scrolls.keys.removeAll{it !in (today-1)..today}
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            ChatToolbar(m.selectedChatPeriod,today,m.chatRoom,m.chatBusy,now,onMenu,{confirm=false;m.selectChatDay(it)},{if(m.chatBusy)m.cancelChat()else m.refreshChat()})
            Box(Modifier.weight(1f)) {
                val room=m.chatRoom
                if(room!=null)ChatConversation(room,m.owner,m.chatMessages,m.chatMembers,m.chatDraft,m.chatStatus,m.chatBusy,now,m::editChat,m::sendChat,{if(m.chatBusy)m.cancelChat()else m.refreshChat()},back,scrolls.getOrPut(room.period){ChatScrollMemory()})
                else Column(Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState())) {
                    Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.SpaceBetween){Copy(if(yesterday)"Yesterday’s chat"else"Daily chat",21,bold=true);WebButton("Back",compact=true,onClick=back)}
                    Copy(if(yesterday)"Yesterday’s verified finishers"else"One group for today’s finishers",14,Muted,modifier=Modifier.padding(top=12.dp))
                    Copy("Choose today or yesterday. Each room requires that day’s verified completion and has its own server-generated daily encryption key.",13,Muted,modifier=Modifier.padding(top=16.dp))
                    Copy(m.chatStatus,13,if(m.chatBusy)Muted else Color.White,modifier=Modifier.padding(top=20.dp))
                    when {
                        m.owner.isEmpty()->WebButton("Login with Amber",Modifier.fillMaxWidth().padding(top=18.dp),primary=true){m.login()}
                        m.chatBusy->WebButton("Cancel chat action",Modifier.fillMaxWidth().padding(top=18.dp)){m.cancelChat()}
                        else->{
                            WebButton(if(yesterday)"Check yesterday’s chat"else"Check existing chat",Modifier.fillMaxWidth().padding(top=18.dp)){m.openChat()}
                            if(yesterday)Copy("Yesterday’s chat is available if you verified yesterday’s result with Word5. Completing today’s puzzle unlocks today’s room.",12,Muted,modifier=Modifier.padding(top=16.dp))
                            else if(m.completed()&&m.state.current().guesses.isNotEmpty()) {
                                Copy("Your native save is private. Unlocking today’s chat is separate: Word5 receives today’s ordered guesses to validate your result and record its score. No public Nostr post is created.",12,Muted,modifier=Modifier.padding(top=16.dp))
                                WebButton("Validate result and unlock chat",Modifier.fillMaxWidth().padding(top=14.dp),primary=true){confirm=true}
                            }else if(m.completed())Copy("This restored result has no original guesses. You can join only if its completion was already verified. Missing guesses will never be invented.",12,Muted,modifier=Modifier.padding(top=16.dp))
                            else WebButton("Return to today’s puzzle",Modifier.fillMaxWidth().padding(top=14.dp),primary=true,onClick=back)
                        }
                    }
                }
            }
        }
        if(confirm)WebModal({confirm=false},result=true){
            Copy("Validate result and unlock chat?",20,bold=true)
            Copy("Word5 will receive today’s ordered guesses, result and account signature to validate completion and record your score. Your encrypted backup stays separate. No public Nostr post is created.",13,Muted,modifier=Modifier.padding(top=16.dp))
            Copy("Chat uses a shared daily key held by the server and that day’s finishers; participants can retain copies.",12,Muted,modifier=Modifier.padding(top=12.dp))
            Row(Modifier.padding(top=18.dp),horizontalArrangement=Arrangement.spacedBy(10.dp)){WebButton("Cancel",Modifier.weight(1f)){confirm=false};WebButton("Join chat",Modifier.weight(1f),primary=true){confirm=false;m.unlockChat()}}
        }
    }
}

/** Native-only view; debug review fixtures cannot call a signer or API. */
@Composable fun ChatConversation(room:ChatRoom,owner:String,messages:List<ChatMessage>,members:Map<String,ChatMember>,draft:String,status:String,busy:Boolean,now:Long,onDraft:(String)->Unit,onSend:()->Unit,onRefresh:()->Unit,onBack:()->Unit,scroll:ChatScrollMemory?=null) {
    var selectedProfile by remember(room,owner){mutableStateOf<String?>(null)}
    var profileFocus by remember(room,owner){mutableStateOf<FocusRequester?>(null)}
    val profileScope=rememberCoroutineScope()
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle,room,owner){
        val observer=androidx.lifecycle.LifecycleEventObserver{_,event->if(event==Lifecycle.Event.ON_PAUSE)selectedProfile=null}
        lifecycle.addObserver(observer);onDispose{lifecycle.removeObserver(observer)}
    }
    LaunchedEffect(now){if(!room.active(owner,now))selectedProfile=null}
    val memory=scroll?:remember(room.owner,room.period){ChatScrollMemory()};val list=memory.list
    LaunchedEffect(room.period,messages.lastOrNull()?.id){
        val last=messages.lastOrNull()?.id
        if(memory.initialized&&memory.lastMessage==last)return@LaunchedEffect
        val follow=messages.lastOrNull()?.pubkey==owner||memory.count==0||list.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let{it>=memory.count-2}!=false
        if(messages.isNotEmpty()&&follow)list.scrollToItem(messages.lastIndex)
        memory.count=messages.size;memory.lastMessage=last;memory.initialized=true
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        if(messages.isEmpty())Box(Modifier.weight(1f).fillMaxWidth().padding(24.dp),contentAlignment=Alignment.Center){Column(horizontalAlignment=Alignment.CenterHorizontally){Copy("You made it. Let’s talk.",18,bold=true);Copy("How did you find today’s word? Be the first to start the conversation.",13,Muted,modifier=Modifier.padding(top=12.dp))}}
        else LazyColumn(Modifier.weight(1f).fillMaxWidth(),state=list,contentPadding=PaddingValues(12.dp),verticalArrangement=Arrangement.spacedBy(16.dp)) {
            items(messages,key={it.id}){message->ChatMessageRow(message,members[message.pubkey],message.pubkey==owner){focus->profileFocus=focus;selectedProfile=message.pubkey}}
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
            Copy("Encrypted group · tap room title for details",10,Muted,modifier=Modifier.padding(top=8.dp))
        }
    }
    selectedProfile?.let{key->ChatProfileDialog(key,members[key]?:ChatMember(profileState="loading")){selectedProfile=null;profileScope.launch{withFrameNanos{};runCatching{profileFocus?.requestFocus()}}}}
}
@Composable private fun ChatMessageRow(message:ChatMessage,member:ChatMember?,own:Boolean,onProfile:(FocusRequester)->Unit) {
    val focus=remember(message.id){FocusRequester()}
    val name=member?.name.orEmpty().ifEmpty{if(own)"You" else message.pubkey.take(6)+"…"+message.pubkey.takeLast(4)}
    Row(Modifier.fillMaxWidth(),horizontalArrangement=if(own)Arrangement.End else Arrangement.Start,verticalAlignment=Alignment.Bottom){
        if(!own)ChatAvatar(member?.picture.orEmpty(),name,Modifier.padding(end=8.dp).size(40.dp).focusRequester(focus).clickable(role=androidx.compose.ui.semantics.Role.Button,onClickLabel="View profile",onClick={onProfile(focus)}))
        Column(Modifier.widthIn(max=300.dp).weight(1f,fill=false)) {
            Row(Modifier.padding(horizontal=4.dp).fillMaxWidth(),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(6.dp)) {
                Text(name,maxLines=1,overflow=TextOverflow.Ellipsis,fontSize=11.sp,color=Color(0xFFD6CBDD),modifier=Modifier.weight(1f))
                if(own&&name!="You")Copy("You",10,Muted)
                member?.result?.takeIf{it.isNotEmpty()}?.let { result->Copy("$result/6",11,Color(0xFFD8B4FE),true,Modifier.semantics{contentDescription=if(result=="X")"6 guesses · not solved"else"$result of 6 guesses"}) }
                Copy(DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault()).format(Instant.ofEpochSecond(message.createdAt)),10,Muted)
            }
            Text(profileStatus(member?.profileState?:"loading"),fontSize=10.sp,color=Muted,maxLines=1,overflow=TextOverflow.Ellipsis,modifier=Modifier.fillMaxWidth().height(20.dp).padding(horizontal=4.dp,vertical=3.dp))
            Copy(message.text,14,modifier=Modifier.padding(top=6.dp).background(if(own)Color(0xFF7036AD)else Color(0xFF28232E),RoundedCornerShape(topStart=16.dp,topEnd=16.dp,bottomStart=if(own)16.dp else 4.dp,bottomEnd=if(own)4.dp else 16.dp)).border(1.dp,if(own)Color(0xFF8547C2)else Color(0xFF3C3443),RoundedCornerShape(topStart=16.dp,topEnd=16.dp,bottomStart=if(own)16.dp else 4.dp,bottomEnd=if(own)4.dp else 16.dp)).padding(12.dp))
        }
        if(own)ChatAvatar(member?.picture.orEmpty(),name,Modifier.padding(start=8.dp).size(40.dp).focusRequester(focus).clickable(role=androidx.compose.ui.semantics.Role.Button,onClickLabel="View profile",onClick={onProfile(focus)}))
    }
}

/** Always retains initials underneath failed or loading pictures. */
@Composable private fun ChatAvatar(url:String,name:String,modifier:Modifier=Modifier){
    Box(modifier.background(Border,androidx.compose.foundation.shape.CircleShape).semantics{contentDescription="Profile photo for $name"},contentAlignment=Alignment.Center){
        Copy(name.take(1).uppercase().ifEmpty{"?"},18,bold=true)
        var bitmap by remember(url){mutableStateOf<android.graphics.Bitmap?>(null)}
        LaunchedEffect(url){bitmap=chatProfileBitmap(url)}
        bitmap?.let{androidx.compose.foundation.Image(it.asImageBitmap(),"Profile photo for $name",Modifier.fillMaxSize().clip(androidx.compose.foundation.shape.CircleShape),contentScale=androidx.compose.ui.layout.ContentScale.Crop)}
    }
}
@Composable fun ChatProfileDialog(pubkey:String,member:ChatMember,close:()->Unit){
    val clipboard=androidx.compose.ui.platform.LocalClipboard.current
    val scope=rememberCoroutineScope()
    var copied by remember(pubkey){mutableStateOf(false)}
    val npub=encodeNpub(pubkey)
    val copyFocus=remember(pubkey){FocusRequester()}
    androidx.compose.ui.window.Dialog(onDismissRequest=close){
        LaunchedEffect(pubkey){withFrameNanos{};copyFocus.requestFocus()}
        Column(Modifier.widthIn(max=360.dp).heightIn(max=520.dp).background(Panel,RoundedCornerShape(18.dp)).padding(20.dp).verticalScroll(rememberScrollState()),horizontalAlignment=Alignment.CenterHorizontally){
            ChatAvatar(member.picture,member.name,Modifier.size(72.dp))
            Text(member.name.ifEmpty{"Nostr profile"},fontSize=20.sp,color=Color.White,modifier=Modifier.padding(top=12.dp),maxLines=3,overflow=TextOverflow.Ellipsis)
            profileStatus(member.profileState).takeIf{it.isNotEmpty()}?.let{Copy(it,12,Muted,modifier=Modifier.padding(top=8.dp))}
            Copy(member.bio.ifEmpty{"No public bio"},13,Muted,modifier=Modifier.fillMaxWidth().padding(top=12.dp))
            androidx.compose.foundation.text.selection.SelectionContainer{Copy(npub,12,modifier=Modifier.fillMaxWidth().padding(top=16.dp))}
            WebButton(if(copied)"Copied npub"else"Copy npub",Modifier.fillMaxWidth().padding(top=12.dp).focusRequester(copyFocus)){
                scope.launch { clipboard.setClipEntry(androidx.compose.ui.platform.ClipEntry(android.content.ClipData.newPlainText("Nostr public key",npub)));copied=true }
            }
            WebButton("Close",Modifier.fillMaxWidth().padding(top=8.dp),onClick=close)
        }
    }
}
