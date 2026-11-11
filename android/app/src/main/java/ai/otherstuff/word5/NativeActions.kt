package ai.otherstuff.word5

import org.json.JSONObject

fun currentResult(state:State,rules:Rules):String {
    val game=state.current()
    return if(rules.completed(game)) (game.outcome ?: if(rules.won(game))game.guesses.size else 7).let{if(it in 1..6)it.toString() else "X"}
    else if(state.baseline?.through==game.period)state.baseline.todayResult?:"–" else "–"
}
fun resultShareText(state:State,rules:Rules):String {
    val game=state.current()
    return "WORD5 #${game.period%1000} ${currentResult(state,rules)}/6${if(game.hard)"* (Hard Mode)" else ""}\n\n"+
        game.guesses.joinToString("\n"){guess->Rules.evaluate(guess,rules.answer(game.period)).joinToString(""){listOf("⬛","🟧","🟪")[it]}}+"\n\nhttps://otherstuff.ai/word5/"
}
fun resultPostDraft(state:State,rules:Rules,owner:String,now:Long=System.currentTimeMillis()/1000):Event {
    val game=state.current();val result=currentResult(state,rules);require(result!="–"){"Finish today's game first"}
    val stats=statistics(state,rules)
    val tags=listOf(listOf("t","word5"),listOf("t","wordle"),listOf("game","word5"),listOf("puzzle",(game.period%1000).toString()),listOf("period",game.period.toString()),listOf("date",java.time.LocalDate.ofEpochDay(game.period).toString()),listOf("result",result),listOf("schema","word5.score.v1"),listOf("streak",stats.streak.toString()),listOf("maxStreak",stats.best.toString()),listOf("played",stats.played.toString()),listOf("won",stats.won.toString()))+if(game.hard)listOf(listOf("hardMode","true"))else emptyList()
    return Event(owner,now,1,tags,resultShareText(state,rules))
}
fun completionDraft(game:Game,rules:Rules,owner:String,now:Long=System.currentTimeMillis()/1000):Event {
    rules.validate(game);require(rules.completed(game) && game.guesses.isNotEmpty()){"Restored result has no guesses; cannot newly record it"}
    val data=JSONObject().put("game","word5").put("periodId",game.period).put("puzzle",game.period%1000).put("date",java.time.LocalDate.ofEpochDay(game.period).toString()).put("result",if(rules.won(game))game.guesses.size.toString()else"X").put("guesses",array(game.guesses)).put("hardMode",game.hard)
    return Event(owner,now,30078,listOf(listOf("schema","word5.completion.v1")),data.toString())
}
fun completionStatusDraft(owner:String,period:Long,now:Long=System.currentTimeMillis()/1000)=Event(owner,now,30078,listOf(listOf("schema","word5.sync-status.v1")),JSONObject().put("periodId",period).toString())
/** An encrypted backup, HTTP authentication or server completion event can never enter this relay transport. */
fun isPublicRelayPayload(event:Event):Boolean = when(event.kind) {
    0,1,3->true
    5555->event.tag("schema")=="word5.stats.v1" && event.tag("type")=="stats-correction"
    30078->event.tags.any{it.size>1&&it[0]=="t"&&it[1] in listOf("word5league","word5league-leave","word5league-rejoin")} && event.tag("schema").isEmpty() && !event.tag("d").startsWith("word5:backup")
    else->false
}
