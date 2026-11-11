package ai.otherstuff.word5

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

private val socialImages=OkHttpClient.Builder().connectTimeout(10,TimeUnit.SECONDS).readTimeout(15,TimeUnit.SECONDS).build()
/** Decode bounded public images off the UI thread; no image request is an upload. */
suspend fun socialBitmap(url:String):Bitmap? = withContext(Dispatchers.IO) {
    if(!url.startsWith("https://"))return@withContext null
    runCatching {
        socialImages.newCall(Request.Builder().url(url).build()).execute().use { r->
            check(r.isSuccessful);val bytes=r.body.byteStream().use{it.readBounded(5000000)}
            val bounds=BitmapFactory.Options().apply{inJustDecodeBounds=true};BitmapFactory.decodeByteArray(bytes,0,bytes.size,bounds)
            require(bounds.outWidth in 1..16000 && bounds.outHeight in 1..16000)
            val options=BitmapFactory.Options().apply{inSampleSize=maxOf(1,maxOf(bounds.outWidth,bounds.outHeight)/1200)}
            BitmapFactory.decodeByteArray(bytes,0,bytes.size,options)
        }
    }.getOrNull()
}
@Composable fun SocialImage(url:String,description:String,modifier:Modifier=Modifier,onClick:(()->Unit)?=null) {
    var bitmap by remember(url){mutableStateOf<Bitmap?>(null)}
    LaunchedEffect(url){bitmap=socialBitmap(url)}
    Box(modifier.clip(RoundedCornerShape(8.dp)).then(if(onClick==null)Modifier else Modifier.clickable(onClick=onClick))){bitmap?.let{Image(it.asImageBitmap(),description,Modifier.fillMaxSize(),contentScale=ContentScale.Crop)}}
}
fun postMedia(e:Event):List<String> {
    val tagged=e.tags.filter{it.firstOrNull()=="imeta"}.flatMap{it.drop(1)}.filter{it.startsWith("url https://")}.map{it.removePrefix("url ")}
    val urls=Regex("https://[^\\s<>]+",RegexOption.IGNORE_CASE).findAll(e.content).map{it.value.trimEnd(')',',','.')}.filter{Regex("\\.(png|jpe?g|gif|webp)(\\?.*)?$",RegexOption.IGNORE_CASE).containsMatchIn(it)}.toList()
    return (tagged+urls).distinct().take(6)
}

/** Native equivalent of the web's 1200×675 canvas, uploaded only after the Share tap. */
suspend fun renderDuelCard(left:SocialIdentity,right:SocialIdentity,leftScore:Int,rightScore:Int):ByteArray = withContext(Dispatchers.Default) {
    val avatars=listOf(socialBitmap(left.avatar),socialBitmap(right.avatar))
    val bitmap=Bitmap.createBitmap(1200,675,Bitmap.Config.ARGB_8888);val c=Canvas(bitmap)
    val p=Paint(Paint.ANTI_ALIAS_FLAG);val white=android.graphics.Color.WHITE
    p.shader=android.graphics.LinearGradient(0f,0f,1200f,675f,android.graphics.Color.rgb(15,16,18),android.graphics.Color.rgb(27,27,31),android.graphics.Shader.TileMode.CLAMP)
    c.drawRect(0f,0f,1200f,675f,p);p.shader=null
    fun text(value:String,x:Float,y:Float,size:Float,color:Int=white,bold:Boolean=false,align:Paint.Align=Paint.Align.CENTER) {p.color=color;p.textSize=size;p.textAlign=align;p.typeface=Typeface.create("sans-serif",if(bold)Typeface.BOLD else Typeface.NORMAL);c.drawText(value,x,y,p)}
    fun fitted(value:String,width:Float,size:Float):String { var out=value;while(out.length>1&&p.measureText(out)>width)out=out.dropLast(1);return if(out==value)out else out.dropLast(1)+"…" }
    text("WORD5 DUEL",72f,70f,28f,0xD9FFFFFF.toInt(),true,Paint.Align.LEFT)
    text("LAST 21 DAYS",1128f,68f,24f,0x3DFFFFFF, true,Paint.Align.RIGHT)
    val identities=listOf(left,right);val scores=listOf(leftScore,rightScore)
    for(i in 0..1) {
        val x=if(i==0)72f else 718f;val center=x+205f
        p.color=android.graphics.Color.rgb(24,24,27);p.style=Paint.Style.FILL;c.drawRoundRect(RectF(x,84f,x+410f,552f),28f,28f,p)
        p.color=0x14FFFFFF;p.style=Paint.Style.STROKE;p.strokeWidth=3f;c.drawRoundRect(RectF(x,84f,x+410f,552f),28f,28f,p);p.style=Paint.Style.FILL
        val avatar=avatars[i];val target=RectF(center-75f,140f,center+75f,290f)
        c.save();val path=android.graphics.Path().apply{addOval(target,android.graphics.Path.Direction.CW)};c.clipPath(path)
        p.color=white
        if(avatar!=null)c.drawBitmap(avatar,null,target,p) else {p.color=android.graphics.Color.rgb(42,42,43);c.drawOval(target,p);text(identities[i].name.take(1).uppercase(),center,230f,42f,bold=true)};c.restore()
        var nameSize=58f;p.typeface=Typeface.create("sans-serif",Typeface.BOLD)
        while(nameSize>34f){p.textSize=nameSize;if(p.measureText(identities[i].name)<=338f)break;nameSize-=2f}
        p.textSize=nameSize;val name=fitted(identities[i].name,338f,nameSize)
        text(name,center,398f,nameSize,bold=true)
        p.textSize=26f;p.typeface=Typeface.create("sans-serif",Typeface.NORMAL);val handle=fitted(identities[i].handle,338f,26f)
        text(handle,center,444f,26f,0x7AFFFFFF)
        val winner=if(i==0)leftScore>rightScore else rightScore>leftScore
        if(winner)text("🏆",center,488f,34f,0xFFFBBF24.toInt())
        text(scores[i].toString(),center,574f,108f,android.graphics.Color.rgb(147,51,234),true)
        text("POINTS",center,602f,20f,0x38FFFFFF,true)
    }
    text("VS",600f,320f,54f,0x59FFFFFF)
    p.color=0x14FFFFFF;p.strokeWidth=2f;c.drawLine(72f,586f,1128f,586f,p)
    text("${left.name} vs ${right.name}",600f,630f,34f,0xD1FFFFFF.toInt(),true)
    text("${java.time.LocalDate.now(java.time.ZoneOffset.UTC).format(java.time.format.DateTimeFormatter.ofPattern("d MMM yyyy"))} · otherstuff.ai/word5",600f,660f,22f,0x6BFFFFFF)
    ByteArrayOutputStream().use{out->bitmap.compress(Bitmap.CompressFormat.PNG,100,out);bitmap.recycle();out.toByteArray()}
}
