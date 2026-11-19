package ai.otherstuff.word5

import java.io.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.*
import java.security.MessageDigest

/** Public profile avatars only. A single atomic envelope keeps key/URL/bytes/freshness together. */
class AvatarStore(private val directory:File,private val validImage:(ByteArray)->Boolean,
    private val clock:()->Long=System::currentTimeMillis,private val maxBytes:Long=64L*1024*1024,
    private val maxFile:Int=3_000_000,private val maxEntries:Int=512) {
    data class Saved(val key:String,val url:String,val checkedAt:Long,val bytes:ByteArray) {
        fun fresh(url:String,now:Long)=this.url==url && now-checkedAt in 0 until PROFILE_TTL_MS
    }
    private var pinned:String?=null
    private val revisions=mutableMapOf<String,Long>()
    @Synchronized fun revision(key:String)=revisions[key]?:0L
    @Synchronized fun pin(key:String?){pinned=key}
    private fun file(key:String):File {require(key.matches(Regex("[pu]-[0-9a-f]{64}")));return File(directory,"$key.avatar")}
    @Synchronized fun read(key:String):Saved? = runCatching {
        val f=file(key);require(f.isFile && f.length() in 1..(maxFile+8192).toLong())
        DataInputStream(f.inputStream().buffered()).use { input->
            require(input.readInt()==0x57354131);require(input.readUTF()==key)
            val url=input.readUTF();require(safeProfilePicture(url).isNotEmpty())
            val time=input.readLong();require(time in 1..clock())
            val hash=input.readUTF();val size=input.readInt();require(size in 1..maxFile)
            val bytes=ByteArray(size);input.readFully(bytes);require(input.read()==-1)
            require(avatarHash(bytes)==hash && validImage(bytes));f.setLastModified(clock())
            Saved(key,url,time,bytes)
        }
    }.getOrNull()
    @Synchronized fun remove(key:String){file(key).delete();revisions[key]=revision(key)+1}
    @Synchronized fun save(key:String,url:String,bytes:ByteArray,expectedRevision:Long?=null):Boolean {
        val target=file(key)
        if(expectedRevision!=null && expectedRevision!=revision(key))return false
        if(safeProfilePicture(url).isEmpty() || bytes.size !in 1..maxFile || !validImage(bytes))return false
        directory.mkdirs();val temp=File(directory,target.name+".new")
        try {
            FileOutputStream(temp).use { stream->val out=DataOutputStream(stream)
                out.writeInt(0x57354131);out.writeUTF(key);out.writeUTF(url);out.writeLong(clock());out.writeUTF(avatarHash(bytes));out.writeInt(bytes.size);out.write(bytes);out.flush();stream.fd.sync()
            }
            check(temp.renameTo(target));target.setLastModified(clock());trim(key);return true
        }finally{temp.delete()}
    }
    private fun trim(active:String) {
        val files=directory.listFiles()?.filter{it.name.matches(Regex("[pu]-[0-9a-f]{64}\\.avatar"))}?.sortedBy{it.lastModified()}.orEmpty()
        var total=files.sumOf{it.length()};var count=files.size
        for(f in files){if(total<=maxBytes&&count<=maxEntries)break
            if(f.name=="$pinned.avatar"||f.name=="$active.avatar")continue
            val length=f.length();if(f.delete()){total-=length;count--}
        }
    }
}
fun avatarHash(bytes:ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)}
fun avatarKey(owner:String,url:String)=if(owner.matches(Regex("[0-9a-f]{64}")))"p-$owner" else "u-${avatarHash(url.toByteArray())}"

/** Shared cache-first orchestration, tested with an injected clock and transport. */
class AvatarLoader(private val store:AvatarStore,private val download:suspend(String)->ByteArray,private val clock:()->Long=System::currentTimeMillis) {
    private class Lock(val mutex:Mutex=Mutex(),var users:Int=0)
    private val locks=mutableMapOf<String,Lock>()
    private val attempts=object:LinkedHashMap<String,Long>(512,.75f,true){override fun removeEldestEntry(eldest:MutableMap.MutableEntry<String,Long>?)=size>512}
    private val permits=Semaphore(3)
    fun observe(owner:String,url:String):Flow<ByteArray> = flow {
        val key=avatarKey(owner,url);val saved=store.read(key)
        saved?.let{emit(it.bytes)}
        if(safeProfilePicture(url).isEmpty() || saved?.fresh(url,clock())==true)return@flow
        val lock=synchronized(this@AvatarLoader){locks.getOrPut(key){Lock()}.also{it.users++}}
        try {lock.mutex.withLock {
            val latest=store.read(key)
            if(latest?.fresh(url,clock())==true){if(latest.checkedAt!=saved?.checkedAt)emit(latest.bytes);return@withLock}
            val request=key+url;val now=clock()
            if(synchronized(this@AvatarLoader){(attempts[request]?:0)>now})return@withLock
            synchronized(this@AvatarLoader){attempts[request]=now+60_000}
            try {
                val revision=store.revision(key)
                val bytes=permits.withPermit{download(url)};currentCoroutineContext().ensureActive()
                if(store.save(key,url,bytes,revision))emit(bytes)
            }catch(e:CancellationException){synchronized(this@AvatarLoader){attempts.remove(request)};throw e}catch(_:Exception){ /* Retain last known success. */ }
        }}finally{synchronized(this@AvatarLoader){lock.users--;if(lock.users==0)locks.remove(key)}}
    }.flowOn(Dispatchers.IO)
}
