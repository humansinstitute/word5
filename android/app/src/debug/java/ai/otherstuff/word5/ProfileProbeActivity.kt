package ai.otherstuff.word5

import android.os.Bundle
import androidx.activity.ComponentActivity
import kotlinx.coroutines.*
import org.json.*
import kotlinx.coroutines.flow.collect

/** Read-only debug diagnostics. Inputs and output stay in the separate debug app's files. */
class ProfileProbeActivity:ComponentActivity() {
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.IO)
    override fun onCreate(savedInstanceState:Bundle?) {
        super.onCreate(savedInstanceState)
        scope.launch {
            val report=JSONObject()
            runCatching {
                val fixture=java.io.File(filesDir,"profile-fixture.json")
                if(fixture.exists()) {
                    val rows=JSONArray(fixture.readText());val results=JSONArray()
                    repeat(rows.length()) { i->val j=rows.getJSONObject(i).getJSONObject("event");val e=Event.parse(j)
                        results.put(JSONObject().put("kind",e.kind).put("id",e.id).put("hash",e.hash()).put("verified",e.verified()).put("metadata",parseChatProfile(e.content)!=null))
                    };report.put("fixture",results)
                }
                val configFile=java.io.File(filesDir,"profile-probe.json")
                val config=if(configFile.exists())JSONObject(configFile.readText())else JSONObject()
                val key=intent.getStringExtra("pubkey")?:config.optString("pubkey")
                if(key.isNotEmpty()) {
                    val start=android.os.SystemClock.elapsedRealtime()
                    if(config.optBoolean("localFirst")) {
                        val clock={System.currentTimeMillis()+config.optLong("clockOffsetMs")}
                        PublicProfiles.initialize(filesDir,clock)
                        val updates=JSONArray();val images=JSONArray()
                        PublicProfiles.observe(key).collect{u->
                            updates.put(JSONObject().put("id",u.event?.id).put("metadata",u.event?.let{JSONObject(it.content)}).put("complete",u.complete).put("checkedAt",u.checkedAt).put("elapsedMs",android.os.SystemClock.elapsedRealtime()-start))
                            u.event?.let{e->PublicAvatars.observe(e.pubkey,JSONObject(e.content).optString("picture")).collect{bitmap->images.put(JSONObject().put("width",bitmap.width).put("height",bitmap.height).put("elapsedMs",android.os.SystemClock.elapsedRealtime()-start))}}
                        }
                        val ownFile=java.io.File(filesDir,"profile-own-event.json")
                        if(config.optBoolean("acceptOwn") && ownFile.exists()) {
                            val own=Event.parse(JSONObject(ownFile.readText()));report.put("ownAccepted",PublicProfiles.accept(own,localEdit=true));report.put("ownKey",own.pubkey)
                            PublicProfiles.seed(own.pubkey,"Legacy own name","https://example.invalid/legacy.png")
                            report.put("ownSnapshot",PublicProfiles.snapshot(own.pubkey))
                            PublicAvatars.observe(own.pubkey,JSONObject(own.content).optString("picture")).collect{bitmap->report.put("ownImageWidth",bitmap.width)}
                        }
                        report.put("updates",updates).put("images",images).put("profileNetworkReads",PublicProfiles.networkReads).put("imageNetworkReads",PublicAvatars.networkReads)
                    }else                     if(config.optBoolean("legacy")) {
                        val events=PublicNostr.queryRelay(config.getString("relay"),JSONObject().put("kinds",array(listOf(0))).put("authors",array(listOf(key))).put("limit",1))
                        report.put("legacyEvents",events.size)
                    }else {
                        fun urls(name:String,defaults:List<String>)=config.optJSONArray(name)?.let{a->(0 until a.length()).map{a.getString(it)}}?:defaults
                        val cache=ProfileEventCache(java.io.File(filesDir,"probe-public-cache.json"))
                        val loader=ProfileLoader(cache,primary=urls("primary",PublicNostr.relays),lookup=urls("lookup",listOf("wss://purplepag.es","wss://relay.primal.net")),stageMs=config.optLong("stageMs",3500))
                        val updates=JSONArray();val keys=config.optJSONArray("keys")?.let{a->(0 until a.length()).map{a.getString(it)}}?:listOf(key)
                        try { coroutineScope { keys.map { owner->launch {
                            loader.observe(owner).collect { u->
                                synchronized(updates){updates.put(JSONObject().put("owner",owner).put("elapsedMs",android.os.SystemClock.elapsedRealtime()-start).put("id",u.event?.id).put("verified",u.event?.verified()).put("complete",u.complete).put("allRelaysCompleted",u.allRelaysCompleted).put("metadata",u.event?.let{parseChatProfile(it.content)}))}
                            }
                        }}.joinAll() } }finally{loader.close()}
                        report.put("updates",updates)
                    }
                    report.put("elapsedMs",android.os.SystemClock.elapsedRealtime()-start)
                }
            }.onFailure { report.put("error",it.toString()) }
            java.io.File(filesDir,"profile-report.json").writeText(report.toString(2))
            android.util.Log.i("Word5ProfileProbe","Report ready")
        }
    }
    override fun onDestroy(){scope.cancel();super.onDestroy()}
}
