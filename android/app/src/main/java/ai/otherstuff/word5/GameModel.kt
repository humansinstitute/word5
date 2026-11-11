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
    var resultOpen by mutableStateOf(false)
    private var syncJob: Job? = null
    private var generation = 0
    private var operation = 0L
    private var activePeriod = Rules.period()
    private val backup = Backup(amber, rules)
    init { load(); if(owner.isNotEmpty()) message = "Backup pending; reconnecting automatically." }
    private fun file(key: String = owner) = File(getApplication<Application>().filesDir, "state-${key.ifEmpty { "guest" }}.json")
    private fun load() {
        draft = ""; state = State()
        if (file().exists()) try { state = Codec.decode(file().readText(), owner, rules) }
        catch(_: Exception) { message = "Local save could not be read. Server restore will be attempted; damaged file retained." }
    }
    private fun save() {
        val target = file(); val temp = File(target.path + ".new")
        temp.writeText(Codec.encode(state, owner)); check(temp.renameTo(target)) { "Local save failed" }
    }
    fun login() {
        if(syncing) return
        val token = ++operation
        syncJob = viewModelScope.launch {
            syncing = true; amber.interactive = true
            try {
                val key = amber.login()
                ensureActive(); check(operation == token)
                generation++; owner = key; prefs.edit().putString("owner", key).apply(); load()
                message = "Connected with Amber. Restoring encrypted backup…"
            } catch(e: CancellationException) { throw e }
            catch(_: Exception) { message = "Amber sign in failed or was cancelled. Install/unlock Amber and retry." }
            finally { if(operation == token) { syncing = false; amber.interactive = false } }
            if(operation == token) sync(true)
        }
    }
    fun signOut() {
        generation++; operation++; syncJob?.cancel(); amber.cancel(); syncing = false
        owner = ""; prefs.edit().remove("owner").apply(); load(); message = "Signed out. Account save retained on this device."
    }
    fun cancel() { operation++; syncJob?.cancel(); amber.cancel(); syncing = false; amber.interactive = false; message = "Sync cancelled. Local game kept; tap Retry." }
    fun toggleHard() {
        if(state.current().guesses.isNotEmpty() || completed()) { message = "Hard mode can change before your first guess."; return }
        val hard = !state.hard
        state = state.copy(hard = hard, hardUpdated = System.currentTimeMillis(), games = state.games.mapValues { (_, g) -> if(g.period == Rules.period() && g.guesses.isEmpty() && g.outcome == null) g.copy(hard = hard) else g }); save(); sync()
    }
    fun completed(): Boolean = rules.completed(state.current()) || (state.baseline?.through == Rules.period() && state.baseline?.todayResult != null)
    fun key(key: String) {
        rollover()
        if(completed()) { resultOpen = true; return }
        when(key) {
            "⌫" -> draft = draft.dropLast(1)
            "ENTER" -> submit()
            else -> if(draft.length < 5 && key.matches(Regex("[A-Z]"))) draft += key
        }
    }
    private fun submit() {
        if(draft.length != 5) { message = "Enter five letters."; return }
        if(draft !in rules.valid) { message = "Not in the word list."; return }
        val game = state.current()
        if(game.hard) rules.hardError(game.guesses, draft, rules.answer(game.period))?.let { message = it; return }
        state = state.with(game.copy(guesses = game.guesses + draft)); draft = ""; save()
        if(completed()) resultOpen = true
        message = if(completed()) "Today's game is saved." else "Guess saved on this device."
        sync()
    }
    /** Every attempt fetches first. No fetched revision survives a failed/unknown read. */
    fun sync(interactive: Boolean = false) {
        if(owner.isEmpty() || syncing) return
        syncJob = viewModelScope.launch {
            val account = owner; val epoch = generation; val token = ++operation
            syncing = true; amber.interactive = interactive
            try {
                repeat(3) {
                    val downloaded = backup.fetch(account)
                    ensureActive(); check(owner == account && epoch == generation && operation == token)
                    state = merge(state, downloaded.state, rules); save()
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
        if(activePeriod != Rules.period()) { activePeriod = Rules.period(); draft = ""; resultOpen = false; state = state.copy(); message = "A new daily puzzle is ready." }
    }
    fun onResume() { rollover(); sync() }
    fun shareText(): String {
        val g = state.current(); val outcome = if(rules.won(g)) g.guesses.size.toString() else if(completed()) state.baseline?.todayResult ?: "X" else "–"
        return "Word5 #${g.period % 1000} $outcome/6${if(g.hard) "*" else ""}\n" + g.guesses.joinToString("\n") { guess -> Rules.evaluate(guess, rules.answer(g.period)).joinToString("") { listOf("⬛","🟨","🟩")[it] } } + "\nhttps://otherstuff.ai/word5/"
    }
}
