package ai.otherstuff.word5

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicInteger

class AvatarStoreTest {
    private val owner="a".repeat(64)
    private val other="b".repeat(64)
    private val url="https://example.com/avatar.png"
    // Disposable byte transport: decoder is injected here; Android probe exercises real decoding.
    private val image=byteArrayOf(1,2,3,4)
    private fun valid(bytes:ByteArray)=bytes.size==4&&bytes[0]==1.toByte()
    @Test fun restartWithin48hDoesNotCallHttpAndExpiryNeverDeletesSuccess()=runBlocking {
        val dir=Files.createTempDirectory("avatars").toFile();var now=1_000_000L;val calls=AtomicInteger()
        try {
            val store=AvatarStore(dir,::valid,{now});val cold=AvatarLoader(store,{calls.incrementAndGet();image},{now})
            assertArrayEquals(image,cold.observe(owner,url).last());assertEquals(1,calls.get())
            val restarted=AvatarLoader(AvatarStore(dir,::valid,{now}),{calls.incrementAndGet();error("offline")},{now})
            now+=PROFILE_TTL_MS-1
            assertArrayEquals(image,restarted.observe(owner,url).single());assertEquals(1,calls.get())
            now++
            assertArrayEquals(image,restarted.observe(owner,url).single());assertEquals(2,calls.get())
            assertArrayEquals(image,AvatarStore(dir,::valid,{now}).read(avatarKey(owner,url))!!.bytes)
            assertArrayEquals(image,restarted.observe(owner,url).single());assertEquals(2,calls.get())
            assertNull(store.read(avatarKey(other,url)))
        }finally{dir.deleteRecursively()}
    }
    @Test fun changedUrl404EmptyAndInvalidImageRetainOldUntilValidReplacement()=runBlocking {
        val dir=Files.createTempDirectory("avatars").toFile();var now=100L
        try {
            val store=AvatarStore(dir,::valid,{now});store.save(avatarKey(owner,url),url,image)
            for(response in listOf<ByteArray?>(null,byteArrayOf(),byteArrayOf(9,9,9,9))){
                val loader=AvatarLoader(store,{response?:error("404")},{now})
                assertArrayEquals(image,loader.observe(owner,url+"?new").single());assertEquals(url,store.read(avatarKey(owner,url))!!.url)
            }
            val replacement=byteArrayOf(1,8,8,8);val loader=AvatarLoader(store,{replacement},{now})
            val results=loader.observe(owner,url+"?new").toList();assertEquals(2,results.size);assertArrayEquals(image,results.first());assertArrayEquals(replacement,results.last())
            val read=AvatarStore(dir,::valid,{now}).read(avatarKey(owner,url))!!;assertEquals(url+"?new",read.url);assertArrayEquals(replacement,read.bytes)
        }finally{dir.deleteRecursively()}
    }
    @Test fun corruptUnsafeOversizedAndBoundedPinnedStorage(){
        val dir=Files.createTempDirectory("avatars").toFile();val store=AvatarStore(dir,::valid,{100},maxFile=4,maxEntries=2)
        try {
            val key=avatarKey(owner,url);assertTrue(store.save(key,url,image));assertFalse(store.save(key,url,ByteArray(5)))
            assertFalse(store.save(key,"http://example.com/a",image));assertTrue(runCatching{store.read("../outside")}.getOrNull()==null)
            assertTrue(runCatching{store.save("../outside",url,image)}.isFailure)
            store.pin(key);store.save(avatarKey(other,url),url,image);store.save(avatarKey("c".repeat(64),url),url,image)
            assertNotNull(store.read(key));assertNull(store.read(avatarKey(other,url)));assertEquals(2,dir.listFiles()!!.size)
            val file=File(dir,"$key.avatar");val bytes=file.readBytes();bytes[bytes.lastIndex]=9;file.writeBytes(bytes)
            assertNull(store.read(key));file.writeBytes(ByteArray(9000));assertNull(store.read(key))
        }finally{dir.deleteRecursively()}
    }
    @Test fun concurrentConsumersJoinAndCancellationDoesNotPoisonRetry()=runBlocking {
        val dir=Files.createTempDirectory("avatars").toFile();val calls=AtomicInteger();val store=AvatarStore(dir,::valid,{100})
        try {
            val loader=AvatarLoader(store,{calls.incrementAndGet();delay(100);image},{100})
            awaitAll(*(1..12).map{async{loader.observe(owner,url).last()}}.toTypedArray()).forEach{assertArrayEquals(image,it)};assertEquals(1,calls.get())
            val started=CompletableDeferred<Unit>();val cancel=AvatarLoader(store,{started.complete(Unit);awaitCancellation()},{100})
            val job=launch{cancel.observe(other,url).collect()};started.await();job.cancelAndJoin();assertNull(store.read(avatarKey(other,url)))
            var fetched=false
            AvatarLoader(store,{fetched=true;image},{100}).observe(other,url).collect();assertTrue(fetched)
            assertFalse(dir.listFiles()!!.any{it.name.endsWith(".new")})
        }finally{dir.deleteRecursively()}
    }
    @Test fun explicitClearWinsOverSuspendedOlderDownloadAndSurvivesRestart()=runBlocking {
        val dir=Files.createTempDirectory("avatars-clear").toFile();val store=AvatarStore(dir,::valid,{100})
        try {
            val started=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>()
            val loader=AvatarLoader(store,{started.complete(Unit);release.await();image},{100})
            val pending=async{loader.observe(owner,url).toList()};started.await()
            store.remove(avatarKey(owner,url));release.complete(Unit)
            assertTrue(pending.await().isEmpty());assertNull(AvatarStore(dir,::valid,{100}).read(avatarKey(owner,url)))
        }finally{dir.deleteRecursively()}
    }

}
