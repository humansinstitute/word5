package ai.otherstuff.word5

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.launch
import org.json.JSONObject

private const val Lightning="skilledopinion918@walletofsatoshi.com"
fun copyText(context:Context,text:String) { (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Word5",text)) }
@Composable fun DonateModal(close:()->Unit) {
    val context=LocalContext.current
    WebModal(close,cardMaxWidth=360.dp,cardPadding=25.dp,cardRadius=12.dp,darkness=.72f) {
        ModalHeading("Support WORD5 ⚡",close)
        Copy("Send a tip via Lightning to keep WORD5 running",13,Muted,modifier=Modifier.padding(bottom=16.dp))
        val qr=remember { val bits=QRCodeWriter().encode("LIGHTNING:${Lightning.uppercase()}",BarcodeFormat.QR_CODE,220,220);android.graphics.Bitmap.createBitmap(220,220,android.graphics.Bitmap.Config.ARGB_8888).apply { for(x in 0..219)for(y in 0..219)setPixel(x,y,if(bits[x,y])android.graphics.Color.rgb(18,18,19) else android.graphics.Color.WHITE) }.asImageBitmap() }
        Image(qr,"Open Lightning wallet",Modifier.align(Alignment.CenterHorizontally).background(Color.White,RoundedCornerShape(8.dp)).clickable { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW,Uri.parse("lightning:$Lightning"))) }.onFailure { copyText(context,Lightning);android.widget.Toast.makeText(context,"No wallet found. Lightning address copied.",android.widget.Toast.LENGTH_SHORT).show() } }.padding(12.dp).size(220.dp))
        Copy("Lightning Address",12,Muted,modifier=Modifier.align(Alignment.CenterHorizontally).padding(top=16.dp,bottom=6.dp))
        Box(Modifier.fillMaxWidth().background(Color(0xFF2A2A2B),RoundedCornerShape(8.dp)).border(1.dp,Border,RoundedCornerShape(8.dp)).clickable { copyText(context,Lightning);android.widget.Toast.makeText(context,"Lightning address copied",android.widget.Toast.LENGTH_SHORT).show() }.padding(12.dp)) { Copy(Lightning,14,Orange) }
        Copy("Tap address to copy · Tap QR to open wallet",11,Muted,modifier=Modifier.padding(top=8.dp))
    }
}
@Composable fun WebField(label:String,value:String,onChange:(String)->Unit, multiline:Boolean=false,multilineHeight:Int=72) {
    Text(label,fontSize=11.sp,color=Muted,letterSpacing=if(label==label.uppercase()) .88.sp else 0.sp,modifier=Modifier.padding(top=10.dp,bottom=6.dp))
    BasicTextField(value,onChange,Modifier.fillMaxWidth().heightIn(min=if(multiline)multilineHeight.dp else 36.dp).background(Background,RoundedCornerShape(6.dp)).border(1.dp,Border,RoundedCornerShape(6.dp)).padding(10.dp),textStyle=TextStyle(color=Color.White,fontSize=12.sp,fontFamily=WebFont),singleLine=!multiline,cursorBrush=androidx.compose.ui.graphics.SolidColor(Purple))
}
@Composable fun ProfileModal(m:GameModel,close:()->Unit) {
    val context=LocalContext.current;var name by remember(m.owner){mutableStateOf(m.profileName)};var about by remember(m.owner){mutableStateOf("")};var picture by remember(m.owner){mutableStateOf(m.profilePicture)};var status by remember(m.owner){mutableStateOf(if(m.profileName.isNotBlank()||m.profilePicture.isNotBlank())"Publishes a kind 0 profile for the active Amber account."else"Loading…")};var loaded by remember(m.owner){mutableStateOf(false)};var original by remember(m.owner){mutableStateOf(JSONObject())}
    var imageUri by remember(m.owner) { mutableStateOf<Uri?>(null) }
    var reload by remember{mutableIntStateOf(0)}
    val totals=statistics(m.state,m.rules)
    var current by remember(m.owner,totals.streak){mutableStateOf(totals.streak.toString())}
    var best by remember(m.owner,totals.best){mutableStateOf(totals.best.toString())}
    var correctionConfirm by remember{mutableStateOf(false)}
    BackHandler(correctionConfirm){correctionConfirm=false}
    val picker=rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { imageUri=it }
    LaunchedEffect(m.owner,reload) {
        if(m.owner.isNotEmpty()) {
            fun show(p:JSONObject,verified:Boolean=true){original=p;name=p.optString("name",p.optString("display_name"));about=p.optString("about");picture=p.optString("picture");loaded=verified;status="Publishes a kind 0 profile for the active Amber account."}
            PublicProfiles.snapshot(m.owner)?.let{show(it,false)}
            PublicProfiles.verifiedSnapshot(m.owner)?.let{show(it)}
            try { PublicProfiles.observe(m.owner).collect{u->
                u.event?.let{e->if(!loaded)show(JSONObject(e.content))}
                if(u.complete && u.event==null && !loaded && name.isBlank() && picture.isBlank()) {
                    if(u.allRelaysCompleted){loaded=true;status="Create your public Nostr profile."}
                    else status="Could not load profile. Retry before editing."
                }
            } }
            catch(e:kotlinx.coroutines.CancellationException){throw e}
            catch(_:Exception){if(!loaded && name.isBlank() && picture.isBlank())status="Could not load profile. Retry before editing."}
        }
    }
    WebModal(close,cardMaxWidth=420.dp,cardPadding=19.dp,cardRadius=12.dp,heightFraction=.8f,darkness=.72f) {
        ModalHeading("My Profile",close)
        if(m.owner.isEmpty()) { Copy("Sign in with Amber to view and update your Nostr profile.",13,Muted);WebButton("Login with Amber",Modifier.fillMaxWidth().padding(top=12.dp),primary=true) { close();m.login() } }
        else {
            Copy(encodeNpub(m.owner).take(10)+"…"+encodeNpub(m.owner).takeLast(6),12,Muted)
            Box(Modifier.align(Alignment.CenterHorizontally).padding(top=4.dp,bottom=14.dp).size(96.dp).border(2.dp,Border,RoundedCornerShape(50))) { Avatar(imageUri?.toString()?:picture,name,Modifier.fillMaxSize(),profileFallback=true,owner=m.owner) }
            WebField("DISPLAY NAME",name,{name=it.take(64)});WebField("DESCRIPTION",about,{about=it.take(280)},true,multilineHeight=92)
            Copy("PROFILE PICTURE",11,Muted,modifier=Modifier.padding(top=10.dp));Copy(imageUri?.lastPathSegment ?: picture.ifEmpty { "No profile picture yet" },12,Muted)
            WebButton("Choose image",Modifier.fillMaxWidth().padding(top=8.dp)) { picker.launch("image/*") }
            Row(Modifier.padding(top=8.dp),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                WebButton("Clear picture",Modifier.weight(1f)) { imageUri=null;picture="" }
                WebButton("Save profile",Modifier.weight(1f),color=Purple) {
                    if(!loaded)m.notify("Load your existing profile before saving") else m.publicAction { owner ->
                        val chosen=imageUri;val url=if(chosen==null)picture else { val bytes=kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { context.contentResolver.openInputStream(chosen)!!.use { input->val b=input.readNBytesBounded(10000001);require(b.size<=10000000);b } };PublicNostr.upload(bytes,context.contentResolver.getType(chosen)?:"image/jpeg",owner,m.amber) }
                        val data=JSONObject(original.toString()).put("name",name).put("display_name",name).put("about",about).put("picture",url)
                        val signed=m.amber.sign(Event(owner,PublicProfiles.nextCreated(owner),0,emptyList(),data.toString()));m.chatProfilePublished(signed);PublicNostr.publish(signed);"Profile published"
                    }
                }
            }
            Copy(status,12,Muted,modifier=Modifier.padding(top=10.dp));Copy(m.publicStatus,12,Muted)
            if(!loaded)WebButton("Retry loading profile",Modifier.fillMaxWidth().padding(top=8.dp)){reload++}
            Spacer(Modifier.height(14.dp));RuleLine();Copy("Stats",11,Muted,modifier=Modifier.padding(top=12.dp))
            WebButton("Repair streak from Nostr",Modifier.fillMaxWidth().padding(top=8.dp),color=Orange) { m.sync(true) }
            Copy("Restores your encrypted save and verified web history. Native private games are kept private.",12,Muted,modifier=Modifier.padding(top=8.dp))
            Copy("Lower your current or best streak and publish a signed baseline. Complete game records and played/won totals are retained in your encrypted save.",12,Muted,modifier=Modifier.padding(top=12.dp))
            Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                Column(Modifier.weight(1f)){WebField("Current",current,{current=it.filter(Char::isDigit).take(6)})}
                Column(Modifier.weight(1f)){WebField("Best",best,{best=it.filter(Char::isDigit).take(6)})}
            }
            WebButton("Apply stats correction",Modifier.fillMaxWidth().padding(top=10.dp),color=Orange){
                runCatching { Corrections.validateLowering(totals,current.toInt(),best.toInt()) }.onSuccess{correctionConfirm=true}.onFailure{m.notify(it.message?:"Enter a lower streak")}
            }
            if(m.correctionPublicationPending)WebButton("Retry pending correction post",Modifier.fillMaxWidth().padding(top=8.dp)){m.retryCorrectionPublication()}
            Spacer(Modifier.height(14.dp));RuleLine()
            WebButton("Copy npub (public key)",Modifier.fillMaxWidth().padding(top=12.dp)) { copyText(context,encodeNpub(m.owner));m.notify("Copied npub") }
        }
    }
    if(correctionConfirm)WebModal({correctionConfirm=false},result=true){
        Copy("Publish stats correction?",20,bold=true)
        Copy("Current streak: ${totals.streak} → $current\nBest streak: ${totals.best} → $best",14,modifier=Modifier.padding(top=16.dp))
        Copy("Amber will sign this public correction. Your native streak will also change and the correction will be included in automatic encrypted backup. Complete outcomes and played/won totals stay intact.",12,Muted,modifier=Modifier.padding(top=12.dp))
        Row(Modifier.padding(top=16.dp),horizontalArrangement=Arrangement.spacedBy(10.dp)){WebButton("Cancel",Modifier.weight(1f)){correctionConfirm=false};WebButton("Publish",Modifier.weight(1f),primary=true){correctionConfirm=false;m.correctStats(current.toInt(),best.toInt())}}
    }
}
private fun java.io.InputStream.readNBytesBounded(limit:Int):ByteArray { val out=java.io.ByteArrayOutputStream();val buffer=ByteArray(8192);while(out.size()<limit){val n=read(buffer,0,minOf(buffer.size,limit-out.size()));if(n<0)break;out.write(buffer,0,n)};return out.toByteArray() }

@Composable fun Avatar(url:String,label:String,modifier:Modifier=Modifier,profileFallback:Boolean=false,owner:String="") {
    val context=LocalContext.current
    // Key by identity, so a changed URL never clears a successful on-screen avatar.
    var bitmap by remember(owner.ifEmpty{url}){mutableStateOf<android.graphics.Bitmap?>(null)}
    val avatarChanges by PublicAvatars.changes.collectAsState()
    val profileChanges by PublicProfiles.changes.collectAsState()
    LaunchedEffect(owner,url,avatarChanges,profileChanges){
        PublicProfiles.initialize(context.filesDir)
        if(PublicAvatars.isCleared(owner))bitmap=null
        if(url.startsWith("content://")) {
            bitmap=kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO){runCatching{context.contentResolver.openInputStream(Uri.parse(url))!!.use{decodeAvatar(it.readBounded(3_000_000))}}.getOrNull()}
        }else PublicAvatars.observe(owner,url).collect{bitmap=it}
    }
    Box(modifier.clip(RoundedCornerShape(50)).background(Color(0xFF2A2A2B)),contentAlignment=Alignment.Center){val image=bitmap;if(image!=null)Image(image.asImageBitmap(),"Profile photo for $label",Modifier.fillMaxSize(),contentScale=androidx.compose.ui.layout.ContentScale.Crop) else Copy(if(profileFallback)label.take(1).uppercase().ifEmpty{"?"} else "👤",if(profileFallback)34 else 20,if(profileFallback)Purple else Muted,bold=profileFallback)}
}
