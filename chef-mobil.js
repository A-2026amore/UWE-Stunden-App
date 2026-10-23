(()=>{
"use strict";
const $ = id => document.getElementById(id);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let signingKey = null;
let publicKey = null;
let codeForSharing = "";
let linkForSharing = "";
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
  signingKey=null;
  publicKey=null;
  codeForSharing="";
  linkForSharing="";
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
  publicKey=info.publicJwk;
  $("password").value="";
  $("backup").value="";
  $("login").hidden=true;
  $("dashboard").hidden=false;
  $("appAddress").textContent=appUrl();
  setMessage("Chef-Verwaltung entsperrt. Du kannst jetzt Mitarbeiter-Zugänge erstellen.");
}
async function createInvite(){
  if(!signingKey)throw Error("Bitte zuerst die Chef-Verwaltung entsperren.");
  const name=$("name").value.trim();
  const eid=$("eid").value.trim();
  const pin=$("pin").value.trim();
  const exp=$("expiry").value;
  if(!name||name.length>80)throw Error("Bitte einen Mitarbeiternamen angeben.");
  if(!/^[A-Za-z0-9_-]{1,30}$/.test(eid))throw Error("Personalnummer: nur Buchstaben, Ziffern, - und _.");
  if(!/^\d{6,12}$/.test(pin))throw Error("Die PIN muss aus 6 bis 12 Ziffern bestehen.");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(exp)||exp<todayLocal())throw Error("Bitte ein gültiges zukünftiges Ablaufdatum wählen.");
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const k=await crypto.subtle.importKey("raw",encoder.encode(pin),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:100000,hash:"SHA-256"},k,256);
  const pinHash=Array.from(new Uint8Array(bits),b=>b.toString(16).padStart(2,"0")).join("");
  const payload={v:1,eid,name,exp,salt:b64bytes(salt),pinHash};
  const body=b64bytes(encoder.encode(JSON.stringify(payload)));
  const signature=await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},signingKey,encoder.encode(body));
  codeForSharing=body+"."+b64bytes(signature);
  linkForSharing=appUrl()+"?code="+encodeURIComponent(codeForSharing);
  $("link").value=linkForSharing;
  $("code").value=codeForSharing;
  $("pin").value="";
  $("result").hidden=false;
  $("result").scrollIntoView({behavior:"smooth",block:"start"});
  setMessage("Zugang für "+name+" erstellt. Den Link und die PIN getrennt versenden.");
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
$("unlock").addEventListener("click",()=>perform(openBackup));
$("issue").addEventListener("click",()=>perform(createInvite));
$("share").addEventListener("click",()=>perform(share));
$("copyLink").addEventListener("click",()=>perform(()=>copy(linkForSharing,"Einladungslink")));
$("copyCode").addEventListener("click",()=>perform(()=>copy(codeForSharing,"Zugangscode")));
$("lock").addEventListener("click",lock);
$("password").addEventListener("keydown",e=>{if(e.key==="Enter")perform(openBackup);});
const exp=new Date();exp.setFullYear(exp.getFullYear()+1);
$("expiry").value=exp.getFullYear()+"-"+String(exp.getMonth()+1).padStart(2,"0")+"-"+String(exp.getDate()).padStart(2,"0");
$("appAddress").textContent=appUrl();
window.addEventListener("pagehide",()=>{signingKey=null;publicKey=null;});
})();
