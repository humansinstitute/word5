package ai.otherstuff.word5

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.compose.runtime.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import java.io.File

private data class ChatRoomView(val room:ChatRoom,val messages:List<ChatMessage> = emptyList(),val members:Map<String,ChatMember> = emptyMap(),val draft:String="",val reply:String?=null)

class GameModel(app: Application): AndroidViewModel(app) {
    val rules = Rules(app.assets.open("answers.txt").bufferedReader().readLines().map { it.trim() }.filter { it.length == 5 }, app.assets.open("wla.txt").bufferedReader().readLines().map { it.trim() }.filter { it.length == 5 })
    val amber = Amber(app)
    private val prefs = app.getSharedPreferences("identity", 0)
    var owner by mutableStateOf(prefs.getString("owner", "") ?: ""); private set
    var state by mutableStateOf(State()); private set
    var draft by mutableStateOf(""); private set
    var message by mutableStateOf("Play offline or sign in with Amber for automatic encrypted backup."); private set
    var syncing by mutableStateOf(false); private set
    var syncEnabled by mutableStateOf(true); private set
    var notice by mutableStateOf(""); private set
    var noticeSerial by mutableIntStateOf(0); private set
    var publicStatus by mutableStateOf(""); private set
    var publicBusy by mutableStateOf(false); private set
    val correctionPublicationPending get() = owner.isNotEmpty() && prefs.contains("correction-publish-$owner")
    val historyNeedsRefresh: Boolean get() {
        val base=state.baseline ?: return false
        if(base.correction==null || base.correctionCreated==null || base.correctionAnchor!=null)return false
        val local=state.correction?.event ?: return true
        return Corrections.newer(base.correctionCreated,base.correction,local.created,local.id)
    }
    var revealing by mutableStateOf(false); private set
    var resultOpen by mutableStateOf(false)
    var donationDue by mutableStateOf(false); private set
    private fun openResult() { val count=prefs.getInt("resultDisplays",0)+1;prefs.edit().putInt("resultDisplays",count).apply();donationDue=count%6==0;resultOpen=true }
    fun reopenResult() { if(completed()) openResult() }
    private fun publishedKey(account: String = owner, period: Long = state.current().period) = "published-$account-$period"
    fun publicationActionLabel(): String = if(prefs.contains(publishedKey())) "Posted to Nostr" else if(prefs.contains("publication-$owner-${state.current().period}")) "Retry score link" else "Post to Nostr"
    fun notify(text: String) { notice = text; noticeSerial++ }
    fun resultCount(): Int = state.current().let { g -> g.outcome ?: if(rules.won(g)) g.guesses.size else if(state.baseline?.through == Rules.period()) state.baseline?.todayResult?.toIntOrNull() ?: 7 else 7 }
    var profileName by mutableStateOf(""); private set
    var profilePicture by mutableStateOf(""); private set
    private var profileJob: Job? = null
    private var publicJob: Job? = null
    private var syncJob: Job? = null
    private var generation = 0
    private var operation = 0L
    private var activePeriod = Rules.period()
    private val backup = Backup(amber, rules)
    private val completionQueue = CompletionQueue({prefs.getString(it,null)}, {k,v->check(prefs.edit().putString(k,v).commit())}, {check(prefs.edit().remove(it).commit())}, {prefs.all.keys})
    private var chatViews by mutableStateOf<Map<Long,ChatRoomView>>(emptyMap())
    var selectedChatPeriod by mutableLongStateOf(Rules.period());private set
    val chatRooms get()=chatViews.values.map{it.room}.sortedByDescending{it.period}
    val chatRoom get()=chatViews[selectedChatPeriod]?.room
    val chatMessages get()=chatViews[selectedChatPeriod]?.messages.orEmpty()
    val chatMembers get()=chatViews[selectedChatPeriod]?.members.orEmpty()
    val chatDraft get()=chatViews[selectedChatPeriod]?.draft.orEmpty()
    val chatReply get()=chatViews[selectedChatPeriod]?.reply
    fun replyChat(target:String?) {chatTick();val view=chatViews[selectedChatPeriod]?:return;if(target!=null&&view.messages.none{it.id==target})return;chatViews=chatViews+(selectedChatPeriod to view.copy(reply=target))}
    fun likeChat(target:String)=chatAction(true){account,epoch,period->val view=chatViews[period]?:return@chatAction;chatStatus="Sending encrypted reaction…";chatClient.like(account,view.room,target);currentChat(account,epoch,period);installConfirmedChat(account,period,view.room);readChat(account,epoch,period,view.room)}
    private val chatProfiles=ChatProfiles()
    var chatStatus by mutableStateOf("Finish today’s puzzle to unlock its chat."); private set
    var chatBusy by mutableStateOf(false); private set
    private var chatVisible=false
    private var chatEpoch=0
    private var chatJob: Job?=null
    private var chatMetadataJob: Job?=null
    private val chatClient=DailyChatClient(amber)
    init { PublicProfiles.initialize(app.filesDir); load(); if(owner.isNotEmpty()) message = "Backup pending; reconnecting automatically."; viewModelScope.launch { delay(500); if(completed()) openResult() } }
    private fun file(key: String = owner) = File(getApplication<Application>().filesDir, "state-${key.ifEmpty { "guest" }}.json")
    private fun load() {
        profileJob?.cancel();profileJob=null
        profileName = prefs.getString("name-$owner", "").orEmpty(); profilePicture = prefs.getString("picture-$owner", "").orEmpty(); syncEnabled=prefs.getBoolean("auto-sync-$owner",true)
        PublicProfiles.seed(owner,profileName,profilePicture)
        if(owner.isNotEmpty() && (profileName.isNotBlank()||profilePicture.isNotBlank()))chatProfiles.seed(owner,org.json.JSONObject().put("name",profileName).put("picture",profilePicture))
        draft = ""; revealing = false; resultOpen = false; state = State()
        if (file().exists()) try { state = Codec.decode(file().readText(), owner, rules) }
        catch(_: Exception) { message = "Local save could not be read. Server restore will be attempted; damaged file retained." }
    }
    private fun save() {
        val target = file(); val temp = File(target.path + ".new")
        temp.writeText(Codec.encode(state, owner)); check(temp.renameTo(target)) { "Local save failed" }
    }
    fun login() {
        if(syncing || publicBusy || chatBusy) return
        val token = ++operation
        syncJob = viewModelScope.launch {
            syncing = true; amber.interactive = true
            try {
                val key = amber.login()
                ensureActive(); check(operation == token)
                clearChat("Account changed. Finish today’s puzzle to join chat."); generation++; owner = key; prefs.edit().putString("owner", key).apply(); load(); refreshProfile()
                message = if(syncEnabled) "Connected with Amber. Restoring encrypted backup…" else "Encrypted sync paused. Tap status to resume."
            } catch(e: CancellationException) { throw e }
            catch(_: Exception) { message = "Amber sign in failed or was cancelled. Install/unlock Amber and retry.";notify("Amber sign in cancelled or unavailable") }
            finally { if(operation == token) { syncing = false; amber.interactive = false } }
            if(operation == token) sync(true)
        }
    }
    fun signOut() {
        clearChat("Sign in with Amber to join daily chat.")
        publicJob?.cancel(); publicBusy = false; publicStatus = ""
        generation++; operation++; syncJob?.cancel(); amber.cancel(); syncing = false
        owner = ""; prefs.edit().remove("owner").apply(); load(); message = "Signed out. Account save retained on this device."
    }
    fun cancel() { if(chatBusy)cancelChat();val wasPublic=publicBusy;operation++; syncJob?.cancel(); publicJob?.cancel(); amber.cancel(); syncing = false; publicBusy = false; amber.interactive = false; message = "Sync cancelled. Local game kept; tap Retry.";if(wasPublic)publicStatus="Action cancelled. Local save kept." }
    fun toggleHard() {
        if(state.current().guesses.isNotEmpty() || completed()) { message = "Hard mode can change before your first guess."; return }
        val hard = !state.hard
        state = state.copy(hard = hard, hardUpdated = System.currentTimeMillis(), games = state.games.mapValues { (_, g) -> if(g.period == Rules.period() && g.guesses.isEmpty() && g.outcome == null) g.copy(hard = hard) else g }); save(); notify(if(hard) "Hard mode ON" else "Hard mode OFF"); sync()
    }
    fun completed(): Boolean = rules.completed(state.current()) || (state.baseline?.through == Rules.period() && state.baseline?.todayResult != null)
    fun key(key: String) {
        rollover()
        if(completed() || revealing) return
        when(key) {
            "⌫" -> draft = draft.dropLast(1)
            "ENTER" -> submit()
            else -> if(draft.length < 5 && key.matches(Regex("[A-Z]"))) draft += key
        }
    }
    private fun submit() {
        if(draft.length != 5) { notify("Not enough letters"); return }
        if(draft !in rules.valid) { notify("Not in word list"); return }
        val game = state.current()
        if(game.hard) rules.hardError(game.guesses, draft, rules.answer(game.period))?.let { notify(it); return }
        state = state.with(game.copy(guesses = game.guesses + draft)); draft = ""; revealing = true; save()
        val revealAccount = owner; val revealPeriod = activePeriod
        viewModelScope.launch { delay(1800); if(owner == revealAccount && activePeriod == revealPeriod) revealing = false }
        if(completed()) { viewModelScope.launch { delay(2300); if(owner == revealAccount && activePeriod == revealPeriod) openResult() } }
        if(owner.isNotEmpty() && rules.completed(state.current())) completionQueue.enqueue(completionDraft(state.current(),rules,owner),state.current().period)
        message = if(completed()) "Today's game is saved." else "Guess saved on this device."
        sync()
    }
    fun toggleSync() {
        if(owner.isEmpty()) { login(); return }
        syncEnabled=!syncEnabled;prefs.edit().putBoolean("auto-sync-$owner",syncEnabled).apply()
        if(syncEnabled)sync(true) else { if(syncing)cancel();message="Encrypted sync paused. Local save kept.";notify("Encrypted sync paused") }
    }
    /** Every attempt fetches first. No fetched revision survives a failed/unknown read. */
    fun sync(interactive: Boolean = false) {
        if(owner.isEmpty() || syncing || publicBusy || chatBusy) return
        if(!syncEnabled) { if(!interactive)return;syncEnabled=true;prefs.edit().putBoolean("auto-sync-$owner",true).apply() }
        syncJob = viewModelScope.launch {
            val account = owner; val epoch = generation; val token = ++operation
            syncing = true; amber.interactive = interactive
            try {
                repeat(3) {
                    // Validation persists independently of optional Nostr posting and encrypted backup.
                    completionQueue.drain(account,{amber.sign(it)},{event->
                        ensureActive();check(owner==account && generation==epoch)
                        PublicNostr.api("api/completion",event)
                    })
                    val downloaded = backup.fetch(account)
                    ensureActive(); check(owner == account && epoch == generation && operation == token)
                    val wasComplete = completed()
                    state = merge(state, downloaded.state, rules); save()
                    if(!wasComplete && completed()) openResult()
                    if(completed()) draft = ""
                    val snapshot = state
                    val identical = downloaded.event != null && Codec.encode(compact(snapshot, rules), account) == downloaded.stored?.let { Codec.encode(compact(it, rules), account) }
                    if(identical || backup.upload(account, downloaded.event, snapshot)) {
                        ensureActive(); check(owner == account && epoch == generation && operation == token)
                        if(state != snapshot) { message = "New changes pending backup."; return@repeat }
                        message = "Encrypted backup up to date. Only you can decrypt it."; return@launch
                    }
                }
                message = "Backup changed on another device. Local game kept; retry."
            } catch(e: CancellationException) { throw e }
            catch(e: Exception) {
                if(owner == account && epoch == generation && operation == token) message = when {
                    e.message?.contains("approval needed") == true -> "Backup pending: tap Retry to approve Amber permissions."
                    e.message?.contains("denied") == true -> "Amber denied backup permission. Change permissions in Amber, then retry."
                    else -> "Backup failed. Local game kept; retry when online and Amber is unlocked."
                }
            } finally { if(owner == account && epoch == generation && operation == token) { syncing = false; amber.interactive = false } }
        }
    }
    private fun rollover() {
        if(activePeriod != Rules.period()) { activePeriod = Rules.period(); chatTick(); draft = ""; revealing = false; resultOpen = false; state = state.copy(); message = "A new daily puzzle is ready." }
    }
    fun onResume() { rollover(); chatTick(); if(!chatVisible)sync(); refreshProfile() }
    private fun applyOwnProfile(account:String,data:org.json.JSONObject,localEdit:Boolean=false){
        if(owner!=account)return
        val name=data.optString("display_name").ifBlank{data.optString("name")}
        if(localEdit||name.isNotBlank())profileName=name
        if(localEdit||safeProfilePicture(data.optString("picture")).isNotEmpty())profilePicture=data.optString("picture")
        prefs.edit().putString("name-$account",profileName).putString("picture-$account",profilePicture).apply()
        chatProfiles.put(account,ownDisplaySnapshot(data,profileName,profilePicture),PublicProfiles.checkedAt(account))
    }
    private fun refreshProfile() {
        if(owner.isEmpty() || profileJob?.isActive==true)return
        val account=owner;profileJob?.cancel()
        profileJob=viewModelScope.launch {
            PublicProfiles.snapshot(account)?.let{applyOwnProfile(account,it)}
            try {PublicProfiles.observe(account).collect{u->if(u.event!=null)PublicProfiles.snapshot(account)?.let{applyOwnProfile(account,it)}}}
            catch(e:CancellationException){throw e}catch(_:Exception){ /* Keep the local identity. */ }
        }
    }
    fun publicAction(action: suspend (String) -> String) {
        if(owner.isEmpty()) { notify("Sign in with Amber first"); return }
        if(syncing || publicBusy || chatBusy) { notify("Wait for the current action to finish"); return }
        val account = owner
        publicBusy = true
        val publicToken = ++operation
        publicJob = viewModelScope.launch {
            amber.interactive = true
            try { publicStatus = "Working…"; val result = action(account); check(owner == account) { "Account changed" }; publicStatus = result; notify(result.substringBefore(" · ")) }
            catch(e: CancellationException) { throw e }
            catch(e: Exception) { if(owner == account && operation == publicToken) { publicStatus = e.message ?: "Action failed; retry"; notify("Action failed; see status") } }
            finally { if(operation == publicToken) { amber.interactive = false; publicBusy = false; sync() } }
        }
    }
    fun correctStats(current:Int,best:Int) = publicAction { account ->
        val before=statistics(state,rules)
        Corrections.validateLowering(before,current,best)
        val stats=org.json.JSONObject().put("played",before.played).put("won",before.won).put("streak",current).put("maxStreak",best)
        val content=org.json.JSONObject().put("game","word5").put("type","stats-correction").put("stats",stats).put("version",1).toString()
        val tags=listOf(listOf("t","word5"),listOf("game","word5"),listOf("schema","word5.stats.v1"),listOf("type","stats-correction"),listOf("streak",current.toString()),listOf("maxStreak",best.toString()),listOf("played",before.played.toString()),listOf("won",before.won.toString()),listOf("version","1"),listOf("previousStreak",before.streak.toString()),listOf("previousMaxStreak",before.best.toString()))
        val signed=amber.sign(Event(account,System.currentTimeMillis()/1000,5555,tags,content))
        check(owner==account)
        state=Corrections.applyCorrection(state,signed,account,rules);save()
        val key="correction-publish-$account";prefs.edit().putString(key,signed.json().toString()).apply()
        try { PublicNostr.publish(signed);prefs.edit().remove(key).apply();"Correction proposal published · server baseline awaits review" }
        catch(e:CancellationException){throw e}
        catch(_:Exception){"Local correction proposed · publication pending; accepted server best is preserved"}
    }
    fun retryCorrectionPublication() = publicAction { account ->
        val key="correction-publish-$account";val raw=prefs.getString(key,null)?:error("No correction post is pending")
        val event=Event.parse(org.json.JSONObject(raw));require(event.pubkey==account && event.verified())
        PublicNostr.publish(event);prefs.edit().remove(key).apply();"Correction proposal published · server baseline awaits review"
    }
    fun postResult() = publicAction { account ->
        check(completed()) { "Finish today's game first" }
        check(!prefs.contains(publishedKey())) { "This result is already posted to Nostr" }
        val draft = resultPostDraft(state,rules,account)
        val period = state.current().period
        val confirmedKey = publishedKey(account,period)
        val pendingKey="publication-$account-$period"
        val pending=prefs.getString(pendingKey,null)?.let { runCatching { Event.parse(org.json.JSONObject(it)) }.getOrNull() }?.takeIf { it.verified() && it.pubkey==account && it.kind==1 && it.tag("period")==draft.tag("period") && it.tag("result")==draft.tag("result") }
        val event = pending ?: amber.sign(draft)
        check(owner==account && state.current().period==period) { "Account or puzzle changed; reopen the result" }
        if(pending==null) { PublicNostr.publish(event);prefs.edit().putString(pendingKey,event.json().toString()).apply() }
        val linked = runCatching { submitPublicScore(account); PublicNostr.api("api/publication", event);prefs.edit().putString(confirmedKey,event.json().toString()).remove(pendingKey).apply() }.onFailure { if(it is CancellationException)throw it }
        if(linked.isSuccess) "Posted to Nostr · score recorded" else "Posted to Nostr · score link pending: ${linked.exceptionOrNull()?.message}"
    }
    fun recordScore() = publicAction { account ->
        submitPublicScore(account)
        val key="publication-$account-${state.current().period}"
        val confirmedKey=publishedKey(account)
        prefs.getString(key,null)?.let { raw -> val event=Event.parse(org.json.JSONObject(raw));require(event.verified() && event.pubkey==account && event.kind==1);PublicNostr.api("api/publication",event);prefs.edit().putString(confirmedKey,event.json().toString()).remove(key).apply() }
        "Score recorded publicly"
    }
    private suspend fun submitPublicScore(account: String) {
        val g=state.current(); check(completed()) { "Finish today's puzzle first" }
        if(g.guesses.isEmpty()) {
            val status=PublicNostr.api("api/completion/status",amber.sign(completionStatusDraft(account,g.period)))
            check(status.optBoolean("completed")) { "Restored result has no guesses; cannot newly record it" };return
        }
        val event=amber.sign(completionDraft(g,rules,account))
        check(owner==account); PublicNostr.api("api/completion",event)
    }
    fun editChat(text:String) { chatTick();val view=chatViews[selectedChatPeriod]?:return;chatViews=chatViews+(selectedChatPeriod to view.copy(draft=text.take(2000))) }
    fun setChatVisible(visible:Boolean,syncWhenHidden:Boolean=true) { chatVisible=visible;if(!visible){chatMetadataJob?.cancel();chatProfiles.cancel()};chatTick();if(!visible&&syncWhenHidden&&!chatBusy)sync() }
    private fun stopChatAction() {
        chatEpoch++;chatJob?.cancel();chatMetadataJob?.cancel();chatProfiles.cancel();chatClient.cancelRequests()
        if(chatBusy){amber.cancel();amber.interactive=false};chatBusy=false
    }
    fun chatTick() {
        val expired=chatViews.values.filter{!it.room.active(owner,System.currentTimeMillis())}
        if(expired.any{it.room.period==selectedChatPeriod})stopChatAction()
        expired.forEach{chatClient.forget(it.room);it.room.discard()}
        if(expired.isNotEmpty())chatViews=chatViews-expired.map{it.room.period}.toSet()
        chatClient.prune(owner)
        if(chatVisible)chatRoom?.let{loadChatMembers(owner,chatEpoch,it,chatMessages)}
        if(selectedChatPeriod !in (Rules.period()-1)..Rules.period()) {
            stopChatAction();selectedChatPeriod=Rules.period();chatStatus="Yesterday’s chat has closed. Finish today’s puzzle to join its room."
        }
    }
    private fun clearChat(status:String) {
        stopChatAction();chatClient.reset();chatViews.values.forEach{it.room.discard()};chatViews=emptyMap();chatProfiles.clear();selectedChatPeriod=Rules.period();chatStatus=status
    }
    fun cancelChat() { stopChatAction();chatStatus="Chat action cancelled. This room’s draft is kept; retry when ready." }
    fun selectChatDay(period:Long) {
        chatTick();if(period !in (Rules.period()-1)..Rules.period())return
        stopChatAction();selectedChatPeriod=period;chatStatus=""
        if(chatRoom!=null)refreshChat()else openChat()
    }
    private fun chatAction(interactive:Boolean,action:suspend(String,Int,Long)->Unit) {
        chatTick()
        if(owner.isEmpty()){chatStatus="Sign in with Amber to join daily chat.";return}
        if(chatBusy||syncing||publicBusy){if(interactive)chatStatus="Wait for the current Amber action to finish, then retry chat.";return}
        val account=owner;val epoch=chatEpoch;val period=selectedChatPeriod;chatBusy=true
        chatJob=viewModelScope.launch {
            amber.interactive=interactive
            try{action(account,epoch,period)}catch(e:CancellationException){throw e}catch(e:Exception){if(owner==account&&chatEpoch==epoch&&selectedChatPeriod==period)chatStatus=when {
                e.message?.contains("approval needed")==true->"Chat needs Amber permission. Tap Refresh and approve kind30078; remembered permission enables automatic updates."
                e is java.io.IOException->"Chat is offline or the server is unavailable. This room’s cached messages and draft are kept; retry."
                e is org.json.JSONException->"Chat response could not be read. This room’s cached messages and draft are kept; retry."
                else->e.message?.take(240)?:"Chat unavailable. This room’s draft is kept; retry when online."
            }}finally{if(owner==account&&chatEpoch==epoch){chatBusy=false;amber.interactive=false;if(!chatVisible)sync()}}
        }
    }
    private fun currentChat(account:String,epoch:Int,period:Long){check(owner==account&&chatEpoch==epoch&&selectedChatPeriod==period&&period in (Rules.period()-1)..Rules.period()){ "Chat account, selection or expiry changed" }}
    private fun installChatRooms(rooms:List<ChatRoom>) {
        chatMetadataJob?.cancel();chatProfiles.cancel()
        val next=rooms.associate{room->
            val old=chatViews[room.period]
            val retained=old?.takeIf{it.room.owner==room.owner&&it.room.key.contentEquals(room.key)}
            if(old!=null){if(retained==null)chatClient.forget(old.room);old.room.discard()}
            room.period to (retained?.copy(room=room)?:ChatRoomView(room))
        }
        chatViews.filterKeys{it !in next}.values.forEach{chatClient.forget(it.room);it.room.discard()}
        chatViews=next
    }
    private suspend fun checkedChatRooms(account:String,epoch:Int,period:Long):List<ChatRoom> {
        val rooms=chatClient.rooms(account)
        try{currentChat(account,epoch,period);return rooms}catch(e:Exception){rooms.forEach{it.discard()};throw e}
    }
    /** Membership checks never send guesses, including for yesterday. */
    fun openChat()=chatAction(true){account,epoch,period->
        chatStatus="Checking available chats…"
        val rooms=checkedChatRooms(account,epoch,period);installChatRooms(rooms)
        val room=chatRoom
        if(room==null){chatStatus=if(period==Rules.period()-1)"Yesterday’s chat is available if you verified yesterday’s result with Word5. Completing today’s puzzle unlocks today’s room."else if(completed())"Validate today’s completed result to unlock its chat, or check an existing server completion."else"Finish today’s puzzle to unlock its chat. You can still visit yesterday if you completed it.";return@chatAction}
        chatStatus="";readChat(account,epoch,period,room)
    }
    /** Only today's informed confirmation can submit native ordered guesses. */
    fun unlockChat()=chatAction(true){account,epoch,period->
        check(period==Rules.period()&&completed()){ "Only today’s completed game can be newly validated" }
        val confirmedGame=state.current();check(confirmedGame.period==period)
        var rooms=checkedChatRooms(account,epoch,period)
        if(rooms.none{it.period==period}){
            rooms.forEach{it.discard()};chatStatus="Validating today’s result with Word5…"
            check(period==Rules.period()&&confirmedGame.period==period){"The new word has started. Open today’s room and confirm validation again."}
            chatClient.validateCompletion(account,confirmedGame,rules,period);currentChat(account,epoch,period)
            rooms=checkedChatRooms(account,epoch,period)
        }
        installChatRooms(rooms);val room=chatRoom?:error("Result validation did not unlock today’s chat. Retry checking the room.")
        chatStatus="";readChat(account,epoch,period,room)
    }
    fun refreshChat(interactive:Boolean=true){if(chatRoom==null){if(interactive)openChat();return};chatAction(interactive){account,epoch,period->readChat(account,epoch,period,chatRoom?:return@chatAction)}}
    fun sendChat()=chatAction(true){account,epoch,period->
        val view=chatViews[period]?:error("This room requires a verified completion")
        val text=view.draft;check(text.isNotBlank()){ "Write a message first" };chatStatus="Sending encrypted message…"
        chatClient.send(account,view.room,text,view.reply);currentChat(account,epoch,period)
        val latest=chatViews[period];if(latest?.room===view.room)chatViews=chatViews+(period to latest.copy(draft=if(latest.draft==text)""else latest.draft,reply=if(latest.reply==view.reply)null else latest.reply))
        installConfirmedChat(account,period,view.room);chatStatus="";readChat(account,epoch,period,view.room)
    }
    private fun installConfirmedChat(account:String,period:Long,room:ChatRoom) {
        val view=chatViews[period]?:return;if(view.room!==room)return
        chatViews=chatViews+(period to view.copy(messages=chatClient.cachedMessages(account,room)))
    }
    private suspend fun readChat(account:String,epoch:Int,period:Long,room:ChatRoom){
        val rows=chatClient.read(account,room);currentChat(account,epoch,period)
        val old=chatViews[period]?:return;if(old.room!==room)return
        val outcomes=chatClient.results(account,room)
        rows.map{it.pubkey}.distinct().forEach{key->PublicProfiles.snapshot(key)?.let{chatProfiles.seed(key,it)}}
        currentChat(account,epoch,period)
        val members=rows.map{it.pubkey}.distinct().associateWith{pubkey->chatRoomMember(chatProfiles.value(pubkey).profile,old.members[pubkey],outcomes[pubkey].orEmpty()).copy(profileState=chatProfiles.value(pubkey).state)}
        chatViews=chatViews+(period to old.copy(messages=rows,members=members));chatStatus="";loadChatMembers(account,epoch,room,rows)
    }
    private fun loadChatMembers(account:String,epoch:Int,room:ChatRoom,rows:List<ChatMessage>){
        if(!chatVisible||chatMetadataJob?.isActive==true)return
        val keys=rows.map{it.pubkey}.distinct()
        val reads=chatProfiles.begin(keys,true)
        fun update(){
            if(owner!=account||chatEpoch!=epoch||chatRoom!==room||!chatVisible||!room.active(owner,System.currentTimeMillis()))return
            val view=chatViews[room.period]?:return
            val members=view.messages.map{it.pubkey}.distinct().associateWith{key->val v=chatProfiles.value(key);chatRoomMember(v.profile,view.members[key],view.members[key]?.result.orEmpty()).copy(profileState=v.state)}
            chatViews=chatViews+(room.period to view.copy(members=members))
        }
        update()
        if(reads.isEmpty())return
        chatMetadataJob=viewModelScope.launch {
            reads.forEach{read->launch {
                try {
                    PublicProfiles.observe(read.key).collect { result ->
                        if(owner==account&&chatEpoch==epoch&&chatRoom===room&&chatVisible&&room.active(owner,System.currentTimeMillis())) {
                            val profile=result.event?.let{parseChatProfile(it.content)}
                            if(result.complete)chatProfiles.finish(read,profile,profile==null&&!result.allRelaysCompleted,result.checkedAt)
                            else if(profile!=null)chatProfiles.progress(read,profile)
                            update()
                        }
                    }
                }catch(e:CancellationException){throw e}catch(_:Exception){chatProfiles.finish(read,null,true);update()}
            }}
        }
    }
    suspend fun chatProfilePublished(event:Event){
        require(event.pubkey==owner && event.kind==0 && event.verified())
        check(PublicProfiles.accept(event,localEdit=true)){"Profile changed; reload before saving"}
        run {
            applyOwnProfile(event.pubkey,org.json.JSONObject(event.content),localEdit=true)
            chatViews=chatViews.mapValues{(_,view)->view.copy(members=view.members+(event.pubkey to chatRoomMember(org.json.JSONObject(event.content),view.members[event.pubkey],view.members[event.pubkey]?.result.orEmpty()).copy(profileState="ready")))}
        }
    }

    fun shareText(): String = resultShareText(state,rules)
}
