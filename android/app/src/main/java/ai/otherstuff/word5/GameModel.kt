package ai.otherstuff.word5

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.compose.runtime.*
import kotlinx.coroutines.*
import java.io.File

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
    fun notify(text: String) { notice = text; noticeSerial++ }
    fun resultCount(): Int = state.current().let { g -> g.outcome ?: if(rules.won(g)) g.guesses.size else if(state.baseline?.through == Rules.period()) state.baseline?.todayResult?.toIntOrNull() ?: 7 else 7 }
    var profileName by mutableStateOf(""); private set
    var profilePicture by mutableStateOf(""); private set
    private var profileJob: Job? = null
    private var profileAccount = ""
    private var publicJob: Job? = null
    private var syncJob: Job? = null
    private var generation = 0
    private var operation = 0L
    private var activePeriod = Rules.period()
    private val backup = Backup(amber, rules)
    init { load(); if(owner.isNotEmpty()) message = "Backup pending; reconnecting automatically."; viewModelScope.launch { delay(500); if(completed()) openResult() } }
    private fun file(key: String = owner) = File(getApplication<Application>().filesDir, "state-${key.ifEmpty { "guest" }}.json")
    private fun load() {
        profileName = prefs.getString("name-$owner", "").orEmpty(); profilePicture = prefs.getString("picture-$owner", "").orEmpty(); syncEnabled=prefs.getBoolean("auto-sync-$owner",true)
        draft = ""; revealing = false; resultOpen = false; state = State()
        if (file().exists()) try { state = Codec.decode(file().readText(), owner, rules) }
        catch(_: Exception) { message = "Local save could not be read. Server restore will be attempted; damaged file retained." }
    }
    private fun save() {
        val target = file(); val temp = File(target.path + ".new")
        temp.writeText(Codec.encode(state, owner)); check(temp.renameTo(target)) { "Local save failed" }
    }
    fun login() {
        if(syncing || publicBusy) return
        val token = ++operation
        syncJob = viewModelScope.launch {
            syncing = true; amber.interactive = true
            try {
                val key = amber.login()
                ensureActive(); check(operation == token)
                generation++; owner = key; prefs.edit().putString("owner", key).apply(); load(); refreshProfile()
                message = if(syncEnabled) "Connected with Amber. Restoring encrypted backup…" else "Encrypted sync paused. Tap status to resume."
            } catch(e: CancellationException) { throw e }
            catch(_: Exception) { message = "Amber sign in failed or was cancelled. Install/unlock Amber and retry.";notify("Amber sign in cancelled or unavailable") }
            finally { if(operation == token) { syncing = false; amber.interactive = false } }
            if(operation == token) sync(true)
        }
    }
    fun signOut() {
        publicJob?.cancel(); publicBusy = false; publicStatus = ""
        generation++; operation++; syncJob?.cancel(); amber.cancel(); syncing = false
        owner = ""; prefs.edit().remove("owner").apply(); load(); message = "Signed out. Account save retained on this device."
    }
    fun cancel() { val wasPublic=publicBusy;operation++; syncJob?.cancel(); publicJob?.cancel(); amber.cancel(); syncing = false; publicBusy = false; amber.interactive = false; message = "Sync cancelled. Local game kept; tap Retry.";if(wasPublic)publicStatus="Action cancelled. Local save kept." }
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
        if(owner.isEmpty() || syncing || publicBusy) return
        if(!syncEnabled) { if(!interactive)return;syncEnabled=true;prefs.edit().putBoolean("auto-sync-$owner",true).apply() }
        syncJob = viewModelScope.launch {
            val account = owner; val epoch = generation; val token = ++operation
            syncing = true; amber.interactive = interactive
            try {
                repeat(3) {
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
        if(activePeriod != Rules.period()) { activePeriod = Rules.period(); draft = ""; revealing = false; resultOpen = false; state = state.copy(); message = "A new daily puzzle is ready." }
    }
    fun onResume() { rollover(); sync(); refreshProfile() }
    private fun refreshProfile() {
        if(owner.isEmpty() || profileAccount == owner) return
        val account=owner; profileAccount=account; profileJob?.cancel()
        profileJob=viewModelScope.launch { runCatching { PublicNostr.profile(account) }.onSuccess { if(owner==account) { profileName=it.optString("display_name").ifEmpty { it.optString("name") };profilePicture=it.optString("picture");prefs.edit().putString("name-$account",profileName).putString("picture-$account",profilePicture).apply() } }.onFailure { if(owner==account)profileAccount="" } }
    }
    fun publicAction(action: suspend (String) -> String) {
        if(owner.isEmpty()) { notify("Sign in with Amber first"); return }
        if(syncing || publicBusy) { notify("Wait for the current action to finish"); return }
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
        try { PublicNostr.publish(signed);prefs.edit().remove(key).apply();"Stats correction published" }
        catch(e:CancellationException){throw e}
        catch(_:Exception){"Stats corrected locally · public post pending; retry in My Profile"}
    }
    fun retryCorrectionPublication() = publicAction { account ->
        val key="correction-publish-$account";val raw=prefs.getString(key,null)?:error("No correction post is pending")
        val event=Event.parse(org.json.JSONObject(raw));require(event.pubkey==account && event.verified())
        PublicNostr.publish(event);prefs.edit().remove(key).apply();"Stats correction published"
    }
    fun postResult() = publicAction { account ->
        check(completed()) { "Finish today's game first" }
        val draft = resultPostDraft(state,rules,account)
        val pendingKey="publication-$account-${state.current().period}"
        val pending=prefs.getString(pendingKey,null)?.let { runCatching { Event.parse(org.json.JSONObject(it)) }.getOrNull() }?.takeIf { it.verified() && it.pubkey==account && it.kind==1 && it.tag("period")==draft.tag("period") && it.tag("result")==draft.tag("result") }
        val event = pending ?: amber.sign(draft)
        check(owner==account)
        if(pending==null) { PublicNostr.publish(event);prefs.edit().putString(pendingKey,event.json().toString()).apply() }
        val linked = runCatching { submitPublicScore(account); PublicNostr.api("api/publication", event);prefs.edit().remove(pendingKey).apply() }.onFailure { if(it is CancellationException)throw it }
        if(linked.isSuccess) "Posted to Nostr · score recorded" else "Posted to Nostr · score link pending: ${linked.exceptionOrNull()?.message}"
    }
    fun recordScore() = publicAction { account ->
        submitPublicScore(account)
        val key="publication-$account-${state.current().period}"
        prefs.getString(key,null)?.let { raw -> val event=Event.parse(org.json.JSONObject(raw));require(event.verified() && event.pubkey==account && event.kind==1);PublicNostr.api("api/publication",event);prefs.edit().remove(key).apply() }
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
    fun shareText(): String = resultShareText(state,rules)
}
