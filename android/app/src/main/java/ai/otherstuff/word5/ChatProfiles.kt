package ai.otherstuff.word5

import org.json.JSONObject
import kotlin.math.pow

/** Main-thread, memory-only cache. Tickets prevent cancelled reads from replacing newer data. */
class ChatProfiles(private val clock:()->Long=System::currentTimeMillis, private val random:()->Double={Math.random()}) {
    data class Value(val profile:JSONObject?=null,val state:String="loading",val attempts:Int=0,val due:Long=0,val ticket:Long=0)
    data class Read(val key:String,val ticket:Long)
    private val values=linkedMapOf<String,Value>()
    private var serial=0L
    fun value(key:String)=values[key]?:Value()
    fun clear(){values.clear();serial++}
    fun cancel(){values.replaceAll{_,v->if(v.ticket!=0L)v.copy(ticket=0,due=0)else v};serial++}
    fun put(key:String,profile:JSONObject){values[key]=Value(profile,"ready",due=clock()+600000);trim()}
    private fun trim(){while(values.size>256)values.remove(values.keys.first())}
    fun begin(keys:List<String>,online:Boolean):List<Read> {
        val reads=mutableListOf<Read>()
        for(key in keys.distinct().take(200)) {
            var v=value(key)
            if(v.ticket!=0L)continue
            if(!online){if(clock()>=v.due)values[key]=v.copy(state="offline");continue}
            if(clock()<v.due)continue
            if(values.values.count{it.ticket!=0L}>=3)break
            val id=++serial;v=v.copy(state="loading",ticket=id);values[key]=v;reads+=Read(key,id)
        }
        trim();return reads
    }
    fun finish(read:Read,profile:JSONObject?,failed:Boolean):Boolean {
        val old=values[read.key]?:return false
        if(old.ticket!=read.ticket)return false
        values[read.key]=when {
            failed->{val n=old.attempts+1;old.copy(state="retry",attempts=n,due=clock()+backoff(n,random()),ticket=0)}
            profile==null->old.copy(state="missing",attempts=0,due=clock()+60000,ticket=0)
            else->Value(profile,"ready",due=clock()+600000)
        }
        return true
    }
    companion object {
        fun backoff(attempt:Int,jitter:Double):Long=(minOf(120000.0,2000.0*2.0.pow((attempt-1).coerceIn(0,16)))*(0.75+jitter.coerceIn(0.0,1.0)*0.5)).toLong()
    }
}
fun safeProfilePicture(value:String):String = value.takeIf { it.length<=2048 && runCatching { java.net.URI(it).let{u->u.scheme=="https"&&!u.host.isNullOrBlank()&&u.userInfo==null&&u.port in listOf(-1,443)} }.getOrDefault(false) }.orEmpty()
fun profileStatus(state:String)=when(state){"loading"->"Loading profile…";"retry"->"Profile unavailable · retrying later";"offline"->"Offline · profile retries when connected";"missing"->"No public profile · checking again later";else->""}

fun parseChatProfile(content:String):JSONObject? = runCatching{JSONObject(content)}.getOrNull()?.takeIf{p->
    listOf("name","display_name","about").any{(p.opt(it) as? String)?.isNotBlank()==true} || safeProfilePicture((p.opt("picture") as? String).orEmpty()).isNotEmpty()
}
