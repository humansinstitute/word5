package ai.otherstuff.word5

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import okhttp3.*
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

fun decodeAvatar(bytes:ByteArray):Bitmap? {
    val bounds=BitmapFactory.Options().apply{inJustDecodeBounds=true};BitmapFactory.decodeByteArray(bytes,0,bytes.size,bounds)
    if(bounds.outWidth !in 1..10000 || bounds.outHeight !in 1..10000)return null
    var sample=1;while(maxOf(bounds.outWidth,bounds.outHeight)/sample>256)sample*=2
    return BitmapFactory.decodeByteArray(bytes,0,bytes.size,BitmapFactory.Options().apply{inSampleSize=sample})
}

/** App-private persistent bytes; post/feed media continue using the separate transient loader. */
object PublicAvatars {
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.IO)
    private val client=OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).connectTimeout(8,TimeUnit.SECONDS).readTimeout(10,TimeUnit.SECONDS).callTimeout(15,TimeUnit.SECONDS).build()
    private var store:AvatarStore?=null
    private var pinned:String?=null
    private var loader:AvatarLoader?=null
    val changes=MutableStateFlow(0)
    private val cleared=mutableSetOf<String>()
    @Synchronized fun isCleared(owner:String)=owner in cleared
    @Synchronized fun clear(owner:String){store?.remove(avatarKey(owner,""));cleared.add(owner);changes.value++}
    private val decoded=object:android.util.LruCache<String,Bitmap>(8*1024*1024){override fun sizeOf(key:String,value:Bitmap)=value.allocationByteCount}
    private fun bitmap(bytes:ByteArray):Bitmap? {
        val key=avatarHash(bytes)
        synchronized(decoded){return decoded.get(key)?:decodeAvatar(bytes)?.also{decoded.put(key,it)}}
    }
    @Volatile var networkReads=0;private set
    @Synchronized fun initialize(directory:File,clock:()->Long=System::currentTimeMillis){if(store==null){
        store=AvatarStore(File(directory,"public-avatars-v1"),{bytes->bitmap(bytes)!=null},clock).also{it.pin(pinned)}
        loader=AvatarLoader(store!!,::download,clock)
    }}
    @Synchronized fun pin(owner:String){pinned=avatarKey(owner,"");store?.pin(pinned)}
    fun prefetch(owner:String,url:String){if(safeProfilePicture(url).isNotEmpty()){
        synchronized(this){if(cleared.remove(owner))changes.value++}
        scope.launch{observe(owner,url).collect()}
    }}
    fun observe(owner:String,url:String):Flow<Bitmap> = flow {
        val shared=synchronized(this@PublicAvatars){loader}?:return@flow
        // A stale screen cannot re-download a superseded own/profile URL.
        val latest=PublicProfiles.verifiedSnapshot(owner)
        val requested=if(latest?.has("picture")==true)latest.optString("picture")else url
        if(isCleared(owner))return@flow
        shared.observe(owner,requested).collect{bytes->bitmap(bytes)?.let{emit(it)}}
    }.flowOn(Dispatchers.IO)
    private suspend fun download(initial:String):ByteArray {
        var url=initial
        repeat(4){
            require(safeProfilePicture(url).isNotEmpty())
            val fetched=await(client.newCall(Request.Builder().url(url).build()))
            val redirect=fetched.first
            if(redirect!=null){url=redirect;require(safeProfilePicture(url).isNotEmpty())}else return fetched.second!!
            /* redirects are separately checked before every request */
            currentCoroutineContext().ensureActive()
        };error("Too many redirects")
    }
    private suspend fun await(call:Call):Pair<String?,ByteArray?> = suspendCancellableCoroutine { c->
        synchronized(this){networkReads++}
        c.invokeOnCancellation{call.cancel()}
        call.enqueue(object:Callback {
            override fun onFailure(call:Call,e:IOException){if(c.isActive)c.resumeWithException(e)}
            override fun onResponse(call:Call,response:Response){
                try {val fetched=response.use { r->
                    if(r.code in listOf(301,302,303,307,308)) {
                        val redirect=r.header("Location")?.let{r.request.url.resolve(it)?.toString()}?:error("Missing redirect")
                        require(safeProfilePicture(redirect).isNotEmpty());Pair(redirect,null)
                    }else {
                        check(r.isSuccessful);require(r.body.contentLength()<=3_000_000)
                        val bytes=r.body.byteStream().use{input->val bytes=input.readBounded(3_000_001);require(bytes.size<=3_000_000);bytes}
                        Pair(null,bytes)
                    }
                };if(c.isActive)c.resume(fetched)
                }catch(e:Exception){if(c.isActive)c.resumeWithException(e)}
            }
        })
    }
}
