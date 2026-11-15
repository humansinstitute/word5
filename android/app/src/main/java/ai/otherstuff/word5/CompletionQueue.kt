package ai.otherstuff.word5

/** Durable private outbox. Draft and signature survive process death; publication is a separate action. */
class CompletionQueue(private val read:(String)->String?,private val write:(String,String)->Unit,private val remove:(String)->Unit,private val keys:()->Set<String>) {
    fun enqueue(event:Event,period:Long) {
        require(event.kind==30078 && event.tag("schema")=="word5.completion.v1")
        val key="completion-${event.pubkey}-$period"
        if(read(key)==null)write(key,event.json().toString())
    }
    suspend fun drain(owner:String,sign:suspend(Event)->Event,send:suspend(Event)->Unit) {
        for(key in keys().filter{it.startsWith("completion-$owner-")}.sorted()) {
            var e=Event.parse(org.json.JSONObject(read(key)?:continue));require(e.pubkey==owner)
            if(e.sig.isEmpty()){val signed=sign(e);require(e.samePayload(signed)&&signed.verified());e=signed;write(key,e.json().toString())}
            send(e);remove(key)
        }
    }
}
