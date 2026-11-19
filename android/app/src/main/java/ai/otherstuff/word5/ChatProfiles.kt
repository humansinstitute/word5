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
    fun seed(key:String,profile:JSONObject){if(values[key]?.profile==null){values[key]=Value(profile,"ready");trim()}}
    fun put(key:String,profile:JSONObject,checkedAt:Long=clock()){values[key]=Value(profile,"ready",due=if(checkedAt>0)checkedAt+PROFILE_TTL_MS else 0);trim()}
    private fun trim(){while(values.size>256)values.remove(values.keys.first())}
    fun begin(keys:List<String>,online:Boolean):List<Read> {
        val reads=mutableListOf<Read>()
        for(key in keys.distinct().take(200)) {
            var v=value(key)
            if(v.ticket!=0L)continue
            if(!online){if(clock()>=v.due)values[key]=v.copy(state=if(v.profile!=null)"ready"else"offline");continue}
            if(clock()<v.due)continue
            if(values.values.count{it.ticket!=0L}>=200)break
            val id=++serial;v=v.copy(state=if(v.profile!=null)"ready"else"loading",ticket=id);values[key]=v;reads+=Read(key,id)
        }
        trim();return reads
    }
    fun progress(read:Read,profile:JSONObject):Boolean {
        val old=values[read.key]?:return false
        if(old.ticket!=read.ticket)return false
        values[read.key]=old.copy(profile=profile,state="ready");return true
    }
    fun finish(read:Read,profile:JSONObject?,failed:Boolean,checkedAt:Long=clock()):Boolean {
        val old=values[read.key]?:return false
        if(old.ticket!=read.ticket)return false
        values[read.key]=when {
            failed->{val n=old.attempts+1;old.copy(state=if(old.profile!=null)"ready"else"retry",attempts=n,due=clock()+backoff(n,random()),ticket=0)}
            profile==null->old.copy(state=if(old.profile!=null)"ready"else"missing",attempts=0,due=clock()+60000,ticket=0)
            else->Value(profile,"ready",due=if(clock()-checkedAt in 0 until PROFILE_TTL_MS)checkedAt+PROFILE_TTL_MS else clock()+60000)
        }
        return true
    }
    companion object {
        fun backoff(attempt:Int,jitter:Double):Long=(minOf(120000.0,2000.0*2.0.pow((attempt-1).coerceIn(0,16)))*(0.75+jitter.coerceIn(0.0,1.0)*0.5)).toLong()
    }
}
fun safeProfilePicture(value:String):String = value.takeIf { it.length<=2048 && runCatching { java.net.URI(it).let{u->u.scheme=="https"&&!u.host.isNullOrBlank()&&u.userInfo==null&&u.port in listOf(-1,443)} }.getOrDefault(false) }.orEmpty()
fun profileStatus(state:String)=when(state){"loading"->"Loading profile…";"retry"->"Profile unavailable · retrying later";"offline"->"Offline · profile retries when connected";"missing"->"No profile found on checked relays · retrying later";else->""}

fun parseChatProfile(content:String):JSONObject? = runCatching{JSONObject(content)}.getOrNull()?.takeIf{p->
    listOf("name","display_name","about").any{(p.opt(it) as? String)?.isNotBlank()==true} || safeProfilePicture((p.opt("picture") as? String).orEmpty()).isNotEmpty()
}

/** Preferences can seed display only; this never creates an Event or a signature. */
fun ownDisplaySnapshot(verified:JSONObject?,name:String,picture:String):JSONObject = JSONObject(verified?.toString()?:"{}").apply {
    if(optString("name").isBlank() && optString("display_name").isBlank() && name.isNotBlank())put("name",name)
    if(safeProfilePicture(optString("picture")).isEmpty() && safeProfilePicture(picture).isNotEmpty())put("picture",picture)
}
