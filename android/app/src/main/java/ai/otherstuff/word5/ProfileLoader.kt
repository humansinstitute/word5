package ai.otherstuff.word5

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import okhttp3.*
import org.json.*
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Only signed public kind-0 events enter this store. Reverify on every cold process start. */
class ProfileEventCache(private val file:File?=null,private val capacity:Int=256) {
    private val events=linkedMapOf<String,Event>()
    init { runCatching {
        if(file!=null && file.exists() && file.length()<=4_000_000) {
            val rows=JSONArray(file.readText());repeat(minOf(rows.length(),capacity)){i->runCatching{accept(Event.parse(rows.getJSONObject(i)),false)}}
        }
    } }
    @Synchronized fun get(key:String)=events[key]
    @Synchronized fun accept(event:Event,persist:Boolean=true):Boolean {
        if(event.kind!=0 || event.json().toString().toByteArray().size>12000 || event.created>System.currentTimeMillis()/1000+60 || !event.verified() || parseChatProfile(event.content)==null)return false
        val old=events[event.pubkey]
        if(old!=null && !newerProfile(event,old))return false
        events.remove(event.pubkey);events[event.pubkey]=event
        while(events.size>capacity)events.remove(events.keys.first())
        if(persist && file!=null)runCatching {
            val target=file!!;target.parentFile?.mkdirs();val temp=File(target.path+".new")
            temp.writeText(array(events.values.map{it.json()}).toString());check(temp.renameTo(target))
        }
        return true
    }
}
fun newerProfile(a:Event,b:Event)=a.created>b.created || (a.created==b.created && a.id<b.id)

/** A shared, reference-counted socket per fixed trusted endpoint. No metadata-controlled relay URLs. */
class ProfileRelayPool(private val client:OkHttpClient=OkHttpClient.Builder().connectTimeout(4,TimeUnit.SECONDS).readTimeout(0,TimeUnit.SECONDS).build()) {
    private data class Subscription(val authors:Set<String>,val event:(Event)->Unit,val done:CompletableDeferred<Boolean>)
    private inner class Connection(val url:String) {
        val subscriptions=linkedMapOf<String,Subscription>()
        var opened=false
        var idle:Job?=null
        lateinit var socket:WebSocket
        fun request(id:String,s:Subscription)=array(listOf("REQ",id,JSONObject().put("kinds",array(listOf(0))).put("authors",array(s.authors.toList())).put("limit",s.authors.size))).toString()
        fun start(){socket=client.newWebSocket(Request.Builder().url(url).build(),object:WebSocketListener(){
            override fun onOpen(webSocket:WebSocket,response:Response){synchronized(this@ProfileRelayPool){opened=true;subscriptions.forEach{(id,s)->webSocket.send(request(id,s))}}}
            override fun onMessage(webSocket:WebSocket,text:String){
                if(text.length>150000)return
                runCatching {
                    val msg=JSONArray(text)
                    synchronized(this@ProfileRelayPool){
                        val s=subscriptions[msg.optString(1)]?:return
                        when(msg.optString(0)){
                            "EVENT"->runCatching { val e=Event.parseRelay(msg.getJSONObject(2));if(e.kind==0&&e.pubkey in s.authors&&e.verified())s.event(e) }
                            "EOSE"->s.done.complete(true)
                            "CLOSED"->s.done.complete(false)
                        }
                    }
                }
            }
            override fun onFailure(webSocket:WebSocket,t:Throwable,response:Response?){synchronized(this@ProfileRelayPool){subscriptions.values.forEach{it.done.complete(false)};if(connections[url]===this@Connection)connections.remove(url)}}
            override fun onClosed(webSocket:WebSocket,code:Int,reason:String){synchronized(this@ProfileRelayPool){subscriptions.values.forEach{it.done.complete(false)};if(connections[url]===this@Connection)connections.remove(url)}}
        })}
    }
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.IO)
    private val connections=mutableMapOf<String,Connection>()
    suspend fun request(url:String,authors:Set<String>,timeout:Long,onEvent:(Event)->Unit):Boolean {
        val id=UUID.randomUUID().toString();val s=Subscription(authors,onEvent,CompletableDeferred())
        val c=synchronized(this){
            val c=connections[url]?:Connection(url).also{connections[url]=it;it.start()}
            c.idle?.cancel();c.subscriptions[id]=s;if(c.opened)c.socket.send(c.request(id,s));c
        }
        return try{withTimeoutOrNull(timeout){s.done.await()}?:false}finally{
            synchronized(this){c.subscriptions.remove(id);c.socket.send(array(listOf("CLOSE",id)).toString())
                if(c.subscriptions.isEmpty())c.idle=scope.launch{delay(250);synchronized(this@ProfileRelayPool){
                    if(c.subscriptions.isEmpty()){if(connections[url]===c)connections.remove(url);c.socket.close(1000,"Idle");c.socket.cancel()}
                }}
            }
        }
    }
    fun close(){scope.cancel();synchronized(this){connections.values.forEach{it.subscriptions.values.forEach{s->s.done.complete(false)};it.socket.cancel()};connections.clear()}}
}

/** Kotlin counterpart of Applesauce's cache-first, joined, buffered address loader. */
class ProfileLoader(
    private val cache:ProfileEventCache=ProfileEventCache(),
    private val pool:ProfileRelayPool=ProfileRelayPool(),
    private val primary:List<String> = PublicNostr.relays,
    private val lookup:List<String> = listOf("wss://purplepag.es","wss://relay.primal.net"),
    private val stageMs:Long=3500,
    private val bufferMs:Long=200
) {
    data class Update(val event:Event?,val complete:Boolean=false,val allRelaysCompleted:Boolean=false)
    private class Entry {val updates=MutableSharedFlow<Update>(replay=1,extraBufferCapacity=16);var users=0;var job:Job?=null}
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.IO)
    private val entries=linkedMapOf<String,Entry>()
    private val pending=linkedMapOf<String,Entry>()
    private var flush:Job?=null
    private val batches=Semaphore(4)
    fun observe(owner:String):Flow<Update> = flow {
        require(owner.matches(Regex("[0-9a-f]{64}")))
        val entry=synchronized(this@ProfileLoader){
            val e=entries.getOrPut(owner){Entry().also{pending[owner]=it}}
            e.users++
            if(flush?.isActive!=true)flush=scope.launch{delay(bufferMs);drain()}
            e
        }
        try {
            cache.get(owner)?.let{emit(Update(it))}
            entry.updates.takeWhile{u->emit(u);!u.complete}.collect()
        }finally{synchronized(this@ProfileLoader){
            entry.users--;if(entry.users==0){pending.remove(owner);if(entries[owner]===entry)entries.remove(owner)
                val job=entry.job;if(job!=null&&entries.values.none{it.job===job&&it.users>0})job.cancel()
            }
        }}
    }
    private fun drain(){
        synchronized(this){
            flush=null;val rows=pending.toMap();pending.clear()
            rows.entries.chunked(200).forEach{chunk->
                val selected=chunk.associate{it.key to it.value}
                val job=scope.launch(start=CoroutineStart.LAZY){batches.withPermit{load(selected)}}
                selected.values.forEach{it.job=job};job.start()
            }
        }
    }
    private suspend fun load(rows:Map<String,Entry>){
        val found=mutableMapOf<String,Event>();rows.keys.forEach{key->cache.get(key)?.let{found[key]=it}}
        var complete=true
        suspend fun stage(urls:List<String>,keys:Set<String>):Boolean = withTimeoutOrNull(stageMs) { coroutineScope {
            urls.map{url->async {
                var remaining=keys;var ok=true
                // Retry partial batches while making progress; a relay may clamp limit.
                repeat(3){
                    if(remaining.isEmpty())return@repeat
                    val received=java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
                    val ended=pool.request(url,remaining,stageMs){e->
                        if(e.created<=System.currentTimeMillis()/1000+60 && parseChatProfile(e.content)!=null){
                            received.add(e.pubkey)
                            synchronized(found){val old=found[e.pubkey];if(old==null||newerProfile(e,old)){
                                found[e.pubkey]=e;cache.accept(e);rows[e.pubkey]?.updates?.tryEmit(Update(e))
                            }}
                        }
                    }
                    ok=ok&&ended
                    val next=remaining-received
                    if(next.size==remaining.size)return@async ok
                    remaining=next
                };ok
            }}.awaitAll().all{it}
        } } ?: false
        try{
            complete=stage(primary,rows.keys)&&complete
            val unresolved=synchronized(found){rows.keys-found.keys}
            if(unresolved.isNotEmpty())complete=stage(lookup,unresolved)&&complete
            rows.forEach{(key,e)->e.updates.emit(Update(synchronized(found){found[key]},true,complete))}
        }finally{synchronized(this){rows.forEach{(key,e)->if(entries[key]===e)entries.remove(key)}}}
    }
    fun close(){scope.cancel();pool.close();synchronized(this){entries.clear();pending.clear()}}
}

/** One app-wide loader; only the public cache is durable across account/room changes. */
object PublicProfiles {
    @Volatile private var loader:ProfileLoader?=null
    private var directory:File?=null
    @Synchronized fun initialize(directory:File){if(this.directory==null)this.directory=directory}
    fun observe(owner:String):Flow<ProfileLoader.Update> = flow {
        // Cold disk reads and signature revalidation must not block Compose/the main thread.
        val shared=withContext(Dispatchers.IO){synchronized(this@PublicProfiles){
            loader?:ProfileLoader(ProfileEventCache(directory?.let{File(it,"public-profiles-v1.json")})).also{loader=it}
        }}
        emitAll(shared.observe(owner))
    }
}
