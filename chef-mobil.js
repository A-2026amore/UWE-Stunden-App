(()=>{
"use strict";
const $ = id => document.getElementById(id);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let signingKey = null;
let previewMode = false;
let publicKey = null;
let codeForSharing = "";
let linkForSharing = "";
let bulkResults = [];
let singleInvite = null;
const appId = "UWE Stunden Chef";
function setMessage(message, bad=false){
  $("notice").textContent=message;
  $("notice").className=bad?"notice bad":"notice";
}
function bytes64(s){
  const padded=s.replace(/-/g,"+").replace(/_/g,"/");
  const raw=atob(padded);
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
function b64bytes(buf){
  const bytes=new Uint8Array(buf);
  let str="";
  for(const byte of bytes)str+=String.fromCharCode(byte);
  return btoa(str).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
}
function todayLocal(){
  const d=new Date();
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
function appUrl(){
  const url=new URL("./index.html",location.href);
  return url.href;
}
function lock(){
  previewMode=false;
  $("modeLabel").textContent="Chef-Verwaltung entsperrt";
  $("previewWarning").hidden=true;
  $("issueHint").hidden=true;
  $("issue").disabled=false;
  signingKey=null;
  publicKey=null;
  codeForSharing="";
  linkForSharing="";
  singleInvite=null;
  $("singlePinArea").hidden=true;
  $("whatsappPhone").value="";
  clearBulkResults();
  $("bulkInput").value="";
  $("backup").value="";
  $("password").value="";
  $("pin").value="";
  $("link").value="";
  $("code").value="";
  $("result").hidden=true;
  $("dashboard").hidden=true;
  $("login").hidden=false;
  $("backup").disabled=false;
  $("password").disabled=false;
  setMessage("Verwaltung gesperrt. Für einen neuen Zugang bitte Sicherung erneut auswählen.");
}
async function openBackup(){
  const f=$("backup").files?.[0];
  const password=$("password").value;
  if(!f)throw Error("Bitte zuerst deine verschlüsselte Chef-Sicherung (.json) auswählen.");
  if(!password)throw Error("Bitte dein Chef-Passwort eingeben.");
  if(f.size>100000)throw Error("Sicherungsdatei ist unerwartet groß.");
  let info;
  try{info=JSON.parse(await f.text());}
  catch{throw Error("Die Sicherungsdatei ist keine gültige JSON-Datei.");}
  if(info.app!==appId||info.version!==1||!info.publicJwk||!info.salt||!info.iv||!info.secret)
    throw Error("Diese Datei ist keine passende UWE-Chef-Sicherung.");
  const published=window.UWE_ACCESS_PUBLIC_KEY;
  if(!published||info.publicJwk.x!==published.x||info.publicJwk.y!==published.y)
    throw Error("Diese Sicherung passt NICHT zum öffentlichen Schlüssel der UWE Stunden-App. Es wurden keine Mitarbeiterdaten verändert.");
  const base=await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveKey"]);
  const aes=await crypto.subtle.deriveKey({name:"PBKDF2",salt:bytes64(info.salt),iterations:250000,hash:"SHA-256"},base,{name:"AES-GCM",length:256},false,["decrypt"]);
  let raw;
  try{raw=await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes64(info.iv)},aes,bytes64(info.secret));}
  catch{throw Error("Chef-Passwort falsch oder Sicherungsdatei beschädigt.");}
  let jwk;
  try{jwk=JSON.parse(decoder.decode(raw));}
  catch{throw Error("Sicherung konnte nicht gelesen werden.");}
  if(jwk.x!==published.x||jwk.y!==published.y)
    throw Error("Der private Schlüssel stimmt nicht mit der veröffentlichten Mitarbeiter-App überein.");
  signingKey=await crypto.subtle.importKey("jwk",jwk,{name:"ECDSA",namedCurve:"P-256"},false,["sign"]);
  previewMode=false;
  $("modeLabel").textContent="Chef-Verwaltung entsperrt";
  $("previewWarning").hidden=true;
  $("issueHint").hidden=true;
  $("issue").disabled=false;
  $("bulkIssue").disabled=false;
  $("bulkPreviewHint").hidden=true;
  publicKey=info.publicJwk;
  $("password").value="";
  $("backup").value="";
  $("login").hidden=true;
  $("dashboard").hidden=false;
  $("appAddress").textContent=appUrl();
  setMessage("Chef-Verwaltung entsperrt. Du kannst jetzt Mitarbeiter-Zugänge erstellen.");
}
async function signCredential(name,eid,pin,exp){
  if(previewMode||!signingKey)throw Error("Echte Zugänge benötigen deine verschlüsselte Chef-Sicherung.");
  if(!name||name.length>80||/[<>\r\n]/.test(name))throw Error("Bitte einen gültigen vollständigen Namen eingeben.");
  if(!/^[A-Za-z0-9_-]{1,30}$/.test(eid))throw Error("Personalnummer: nur Buchstaben, Ziffern, - und _.");
  if(!/^\d{6,12}$/.test(pin))throw Error("Die PIN muss 6–12 Ziffern enthalten.");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(exp)||exp<todayLocal())throw Error("Bitte ein gültiges zukünftiges Ablaufdatum wählen.");
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const k=await crypto.subtle.importKey("raw",encoder.encode(pin),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:100000,hash:"SHA-256"},k,256);
  const pinHash=Array.from(new Uint8Array(bits),b=>b.toString(16).padStart(2,"0")).join("");
  const payload={v:1,eid,name,exp,salt:b64bytes(salt),pinHash};
  const body=b64bytes(encoder.encode(JSON.stringify(payload)));
  const signature=await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},signingKey,encoder.encode(body));
  const code=body+"."+b64bytes(signature);
  return {name,eid,pin,exp,code,link:appUrl()+"?code="+encodeURIComponent(code)};
}
async function createInvite(){
  if(previewMode||!signingKey)throw Error("Bitte zuerst die Chef-Verwaltung mit der Sicherung entsperren.");
  const name=$("name").value.trim();
  const eid=$("eid").value.trim();
  const pin=$("pin").value.trim()||securePin();
  const exp=$("expiry").value;
  const phone=normalizeWhatsAppPhone($("whatsappPhone").value);
  const invite=await signCredential(name,eid,pin,exp);
  singleInvite={name:invite.name,link:invite.link,phone,pin};
  codeForSharing=invite.code;
  linkForSharing=invite.link;
  $("link").value=linkForSharing;
  $("code").value=codeForSharing;
  $("pin").value="";
  $("singlePinArea").hidden=false;
  $("result").hidden=false;
  $("result").scrollIntoView({behavior:"smooth",block:"start"});
  setMessage("Zugang für "+name+" erstellt. Den Link und die PIN getrennt versenden.");
}
function securePin(){
  const bytes=crypto.getRandomValues(new Uint32Array(1));
  return String(100000000+Math.floor(bytes[0]/4294967296*900000000));
}
function clearBulkResults(){
  bulkResults=[];
  $("bulkResultList").replaceChildren();
  $("bulkResults").hidden=true;
}
function makeCopyButton(label,value){
  const b=document.createElement("button");
  b.type="button";
  b.className="secondary";
  b.textContent=label;
  b.addEventListener("click",()=>perform(()=>copy(value,label)));
  return b;
}
function showBulkResults(){
  $("bulkResultList").replaceChildren();
  bulkResults.forEach(invite=>{
    const card=document.createElement("div");card.className="bulk-result";
    const title=document.createElement("div");title.className="bulk-result-title";
    title.textContent=invite.name;card.append(title);
    const detail=document.createElement("div");detail.className="bulk-detail";
    detail.textContent="Personalnummer: "+invite.eid+" · gültig bis: "+invite.exp+(invite.phone?" · WhatsApp: +"+invite.phone:"");
    card.append(detail);
    const pinRow=document.createElement("div");pinRow.className="bulk-detail";
    pinRow.textContent="PIN (vertraulich): "+invite.pin;
    card.append(pinRow);
    const actions=document.createElement("div");actions.className="bulk-actions";
    const shareBtn=document.createElement("button");
    shareBtn.type="button";shareBtn.textContent="Link teilen";
    shareBtn.addEventListener("click",()=>perform(async()=>{
      if(navigator.share){
        try{
          await navigator.share({title:"UWE Stunden – Mitarbeiterzugang",text:"Persönlicher Link für "+invite.name+". Die PIN kommt separat.",url:invite.link});
          return;
        }catch(e){if(e.name==="AbortError")return;}
      }
      await copy(invite.link,"Einladungslink");
    }));
    actions.append(shareBtn);
    const whatsappBtn=document.createElement("button");
    whatsappBtn.type="button";
    whatsappBtn.className="whatsapp-action";
    whatsappBtn.textContent="WhatsApp einladen";
    whatsappBtn.addEventListener("click",()=>perform(()=>openWhatsAppInvite(invite)));
    actions.append(whatsappBtn);
    actions.append(makeCopyButton("Link kopieren",invite.link));
    actions.append(makeCopyButton("PIN kopieren",invite.pin));
    card.append(actions);
    $("bulkResultList").append(card);
  });
  $("bulkResults").hidden=false;
}
async function createBulk(){
  if(previewMode||!signingKey)throw Error("Bitte die Chef-Verwaltung zuerst mit dem privaten Chef-Schlüssel entsperren.");
  const lines=$("bulkInput").value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
  if(!lines.length)throw Error("Bitte Mitarbeiterzeilen eingeben.");
  if(lines.length>100)throw Error("Bitte maximal 100 Mitarbeiter auf einmal erstellen.");
  const exp=$("bulkExpiry").value;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(exp)||exp<todayLocal())throw Error("Bitte ein gültiges Ablaufdatum wählen.");
  const ids=new Set(),pins=new Set(),items=[];
  lines.forEach((line,i)=>{
    const fields=line.split(";").map(x=>x.trim());
    if(fields.length<2||fields.length>4)throw Error("Zeile "+(i+1)+": Format Name;Personalnummer;PIN;WhatsApp-Nummer.");
    const [name,eid,pinGiven="",phoneGiven=""]=fields;
    const phone=normalizeWhatsAppPhone(phoneGiven);
    if(!name||name.length>80||/[<>\r\n]/.test(name))throw Error("Zeile "+(i+1)+": Name fehlt oder ist ungültig.");
    if(!/^[A-Za-z0-9_-]{1,30}$/.test(eid))throw Error("Zeile "+(i+1)+": ungültige Personalnummer.");
    if(ids.has(eid.toLowerCase()))throw Error("Personalnummer "+eid+" wurde mehrfach vergeben.");
    ids.add(eid.toLowerCase());
    let pin=pinGiven;
    if(pin&&!/^\d{6,12}$/.test(pin))throw Error("Zeile "+(i+1)+": PIN muss 6–12 Ziffern haben.");
    if(!pin){let attempts=0;do{pin=securePin();if(++attempts>30)throw Error("Sichere PIN-Erzeugung fehlgeschlagen. Bitte erneut versuchen.");}while(pins.has(pin));}
    if(pins.has(pin))throw Error("Zeile "+(i+1)+": PIN darf nicht bei mehreren Mitarbeitern gleich sein.");
    pins.add(pin);
    items.push({name,eid,pin,phone});
  });
  // Sign only after validating the entire list; keep data only in this open session.
  $("bulkIssue").disabled=true;
  try{
    const invitations=[];
    for(const item of items){
      const invite=await signCredential(item.name,item.eid,item.pin,exp);
      invitations.push({...invite,phone:item.phone});
    }
    clearBulkResults();
    bulkResults=invitations;
    showBulkResults();
    $("bulkResults").scrollIntoView({behavior:"smooth",block:"start"});
    setMessage(invitations.length+" Mitarbeiterzugänge erstellt. Bitte jeden Link und die zugehörige PIN getrennt verschicken.");
    $("bulkInput").value="";
  }finally{
    $("bulkIssue").disabled=false;
  }
}
function normalizeWhatsAppPhone(raw){
  const value=String(raw||"").trim();
  if(!value)return "";
  const compact=value.replace(/[\s()./-]/g,"");
  if(!/^\+?\d+$/.test(compact))throw Error("WhatsApp-Nummer bitte als 0176... oder +49... eingeben.");
  let digits=compact;
  if(digits.startsWith("+"))digits=digits.slice(1);
  else if(digits.startsWith("00"))digits=digits.slice(2);
  else if(digits.startsWith("0"))digits="49"+digits.slice(1);
  if(!/^[1-9]\d{7,14}$/.test(digits))throw Error("Bitte eine gültige WhatsApp-Nummer mit Vorwahl eingeben.");
  return digits;
}
function whatsAppText(invite){
  return "Hallo "+invite.name+",\n\nhier ist dein persönlicher Zugang zur UWE Stunden-App:\n"+
    invite.link+"\n\nBitte öffne den Link auf deinem Handy. Deine persönliche PIN erhältst du separat.\n\n"+
    "Viele Grüße\n\nTeam UWE - Krankentransporte GmbH";
}
function whatsAppUrl(invite){
  if(!invite||!invite.link)throw Error("Bitte zuerst einen Mitarbeiterzugang erstellen.");
  return "https://wa.me/"+(invite.phone||"")+"?text="+encodeURIComponent(whatsAppText(invite));
}
function openWhatsAppInvite(invite){
  const url=whatsAppUrl(invite);
  const popup=window.open(url,"_blank");
  if(!popup)window.location.assign(url);
  setMessage("WhatsApp geöffnet. Bitte den Empfänger überprüfen und dort auf Senden klicken. PIN getrennt mitteilen.");
}

async function copy(value,description){
  if(!value)throw Error("Bitte zuerst einen Mitarbeiterzugang erstellen.");
  await navigator.clipboard.writeText(value);
  setMessage(description+" kopiert.");
}
async function share(){
  if(!linkForSharing)throw Error("Bitte zuerst einen Mitarbeiterzugang erstellen.");
  if(navigator.share){
    try{await navigator.share({title:"UWE Stunden – Mitarbeiterzugang",text:"Hier ist dein persönlicher Zugang zur UWE Stunden-App. Deine PIN erhältst du separat.",url:linkForSharing});return;}
    catch(e){if(e.name==="AbortError")return;}
  }
  await copy(linkForSharing,"Einladungslink");
}
async function perform(fn){
  try{await fn();}catch(e){setMessage(e.message||"Aktion fehlgeschlagen.",true);}
}
function openPreview(){
  previewMode=true;
  signingKey=null;
  publicKey=null;
  codeForSharing="";
  linkForSharing="";
  $("pin").value="";
  $("login").hidden=true;
  $("dashboard").hidden=false;
  $("result").hidden=true;
  singleInvite=null;
  $("singlePinArea").hidden=true;
  $("modeLabel").textContent="Nur Vorschau – kein Chef-Login";
  $("previewWarning").hidden=false;
  $("issueHint").hidden=false;
  $("issue").disabled=true;
  $("bulkIssue").disabled=true;
  $("bulkPreviewHint").hidden=false;
  clearBulkResults();
  setMessage("Testmodus geöffnet. Die Verwaltung kann angesehen, aber nicht für echte Mitarbeiterzugänge genutzt werden.");
}
$("preview").addEventListener("click",openPreview);
$("unlock").addEventListener("click",()=>perform(openBackup));
$("issue").addEventListener("click",()=>perform(createInvite));
$("bulkIssue").addEventListener("click",()=>perform(createBulk));
$("share").addEventListener("click",()=>perform(share));
$("whatsappSingle").addEventListener("click",()=>perform(()=>openWhatsAppInvite(singleInvite)));
$("copySinglePin").addEventListener("click",()=>perform(()=>copy(singleInvite?.pin,"PIN")));
$("copyLink").addEventListener("click",()=>perform(()=>copy(linkForSharing,"Einladungslink")));
$("copyCode").addEventListener("click",()=>perform(()=>copy(codeForSharing,"Zugangscode")));
$("lock").addEventListener("click",lock);
$("password").addEventListener("keydown",e=>{if(e.key==="Enter")perform(openBackup);});
const exp=new Date();exp.setFullYear(exp.getFullYear()+1);
$("expiry").value=exp.getFullYear()+"-"+String(exp.getMonth()+1).padStart(2,"0")+"-"+String(exp.getDate()).padStart(2,"0");
$("bulkExpiry").value=$("expiry").value;
$("appAddress").textContent=appUrl();
window.addEventListener("pagehide",()=>{signingKey=null;publicKey=null;bulkResults=[];singleInvite=null;});
})();
