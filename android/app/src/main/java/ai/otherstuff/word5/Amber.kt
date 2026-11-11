package ai.otherstuff.word5

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResult
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** No key handling. Silent native provider calls require remembered Amber permissions. */
interface NativeSigner {
    suspend fun sign(event: Event): Event
    suspend fun encrypt(owner: String, text: String): String
    suspend fun decrypt(owner: String, text: String): String
}
class Amber(private val context: Context): NativeSigner {
    companion object { const val PACKAGE = "com.greenart7c3.nostrsigner" }
    data class Pending(val id: String, val result: CompletableDeferred<Intent>)
    private var pending: Pending? = null
    var launch: ((Intent) -> Unit)? = null
    var interactive = false
    fun result(r: ActivityResult) {
        val p = pending ?: return
        val data = r.data
        when {
            r.resultCode != Activity.RESULT_OK || data == null -> p.result.completeExceptionally(IllegalStateException("Amber cancelled. Local game kept; tap Retry."))
            data.getBooleanExtra("rejected", false) || data.getStringExtra("rejected") == "true" -> p.result.completeExceptionally(IllegalStateException("Amber permission declined. Local game kept."))
            data.getStringExtra("id") != p.id -> p.result.completeExceptionally(IllegalStateException("Unmatched Amber response. Retry."))
            else -> p.result.complete(data)
        }
    }
    fun cancel() { pending?.result?.cancel() }
    private suspend fun request(type: String, owner: String = "", payload: String = ""): Intent {
        require(payload.toByteArray().size <= 100000)
        if (owner.isNotEmpty()) {
            val reply = withContext(Dispatchers.IO) {
                context.contentResolver.query(Uri.parse("content://$PACKAGE.${type.uppercase(java.util.Locale.ROOT)}"), arrayOf(payload, if (type.startsWith("nip44")) owner else "", owner), null, null, null)?.use { c ->
                    check(c.getColumnIndex("rejected") < 0) { "Amber denied this permission. Change it in Amber and retry." }
                    if (!c.moveToFirst()) null else Intent().apply {
                        listOf("result", "event").forEach { name -> val i = c.getColumnIndex(name); if (i >= 0) putExtra(name, c.getString(i)) }
                    }
                }
            }
            if (reply != null) return reply
            check(interactive) { "Backup pending: Amber approval needed. Tap Retry and remember permissions." }
        }
        check(pending == null) { "An Amber request is already pending" }
        val p = Pending(UUID.randomUUID().toString(), CompletableDeferred()); pending = p
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:$payload")).setPackage(PACKAGE).putExtra("type", type).putExtra("id", p.id)
            if (owner.isNotEmpty()) intent.putExtra("current_user", owner)
            if (type.startsWith("nip44")) intent.putExtra("pubkey", owner)
            if (type == "get_public_key") intent.putExtra("permissions", JSONArray().put(JSONObject().put("type", "sign_event").put("kind", 27235)).put(JSONObject().put("type", "sign_event").put("kind", 30078)).put(JSONObject().put("type", "nip44_encrypt")).put(JSONObject().put("type", "nip44_decrypt")).toString())
            withContext(Dispatchers.Main) { (launch ?: error("Open Word5 to approve Amber"))(intent) }
            return withTimeout(120000) { p.result.await() }
        } catch (e: android.content.ActivityNotFoundException) { error("Install and unlock Amber, then retry sign in.") }
        finally { if (pending === p) pending = null }
    }
    suspend fun login(): String {
        val r = request("get_public_key")
        require(r.getStringExtra("package").let { it == null || it == PACKAGE })
        return amberPublicKey(r.getStringExtra("result") ?: error("Amber returned no account"))
    }
    override suspend fun sign(event: Event): Event {
        val r = request("sign_event", event.pubkey, event.json().toString())
        val signed = r.getStringExtra("event")?.let { Event.parse(JSONObject(it)) }
            ?: event.copy(id = event.hash(), sig = r.getStringExtra("result") ?: error("Amber returned no signature"))
        require(signed.samePayload(event) && signed.verified()) { "Amber signature did not match request" }
        return signed
    }
    override suspend fun encrypt(owner: String, text: String): String = (request("nip44_encrypt", owner, text).getStringExtra("result") ?: error("Amber returned no ciphertext")).also { require(it.length in 100..90000) }
    override suspend fun decrypt(owner: String, text: String): String = (request("nip44_decrypt", owner, text).getStringExtra("result") ?: error("Amber returned no plaintext")).also { require(it.toByteArray().size <= 60000) }
}
