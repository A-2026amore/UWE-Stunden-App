(()=>{
"use strict";
const $=id=>document.getElementById(id);
const ENC=new TextEncoder(), DEC=new TextDecoder();
const STORAGE_KEY="uwe_staff_directory_encrypted_v1";
const SALT_KEY="uwe_staff_directory_salt_v1";
const API="https://api.github.com/repos/A-2026amore/UWE-Stunden-App/contents/uwe-access-control.json";
let encryptionKey=null;
let employees=[];
let remote=null;
let readError="";
let unlocked=false;
let demo=false;
let publishing=false;
function b64(buf){
  const data=new Uint8Array(buf);
  let raw="";
  for(const value of data)raw+=String.fromCharCode(value);
  return btoa(raw);
}
function un64(value){
  const str=atob(String(value).replace(/\s/g,""));
  return Uint8Array.from(str,ch=>ch.charCodeAt(0));
}
function isoToday(){
  const d=new Date();
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
function note(message,error=false){
  $("staffNotice").textContent=message;
  $("staffNotice").className=error?"notice bad":"notice";
}
function checkId(id){
  if(typeof id!=="string"||!/^[A-Za-z0-9_-]{1,30}$/.test(id))
    throw Error("Ungültige Personalnummer. Erlaubt sind Buchstaben, Zahlen, Bindestrich und Unterstrich.");
}
function validateList(data){
  if(!data||data.version!==1||!Array.isArray(data.revoked)||data.revoked.length>10000||
      !data.revoked.every(id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,30}$/.test(id)))
    throw Error("Die zentrale UWE-Sperrliste enthält ungültige Daten.");
  return {version:1,updatedAt:data.updatedAt||null,revoked:[...new Set(data.revoked)]};
}
function validateEmployees(items){
  if(!Array.isArray(items)||items.length>1000)throw Error("Das Mitarbeiterverzeichnis ist ungültig.");
  const map=new Map();
  for(const item of items){
    if(!item||typeof item.name!=="string"||!item.name.trim()||item.name.length>80)throw Error("Ungültiger Mitarbeitername im Verzeichnis.");
    checkId(item.eid);
    if(item.exp!=null&&typeof item.exp!=="string")throw Error("Ungültiges Ablaufdatum im Verzeichnis.");
    if(item.exp&&!/^\d{4}-\d{2}-\d{2}$/.test(item.exp))throw Error("Ungültiges Ablaufdatum.");
    map.set(item.eid.toUpperCase(),{name:item.name.trim(),eid:item.eid,exp:item.exp||null,issuedAt:item.issuedAt||null});
  }
  return [...map.values()];
}
async function getKey(password){
  if(!password)throw Error("Chef-Passwort fehlt.");
  let saltValue=localStorage.getItem(SALT_KEY);
  if(!saltValue){
    saltValue=b64(crypto.getRandomValues(new Uint8Array(16)));
    localStorage.setItem(SALT_KEY,saltValue);
  }
  const base=await crypto.subtle.importKey("raw",ENC.encode(password),"PBKDF2",false,["deriveKey"]);
  return crypto.subtle.deriveKey(
    {name:"PBKDF2",salt:un64(saltValue),iterations:250000,hash:"SHA-256"},
    base,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
async function loadEncryptedRoster(){
  const data=localStorage.getItem(STORAGE_KEY);
  if(!data){employees=[];return;}
  try{
    const envelope=JSON.parse(data);
    if(envelope.version!==1||!envelope.iv||!envelope.data)throw Error("Format");
    const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:un64(envelope.iv)},encryptionKey,un64(envelope.data));
    employees=validateEmployees(JSON.parse(DEC.decode(plain)));
  }catch{
    throw Error("Das Mitarbeiterverzeichnis konnte nicht entschlüsselt werden. Bitte die Chef-Sicherung bzw. das ursprüngliche Chef-Passwort prüfen. Es wurden keine bestehenden Daten überschrieben.");
  }
}
async function persist(){
  if(!unlocked||!encryptionKey)throw Error("Bitte zuerst die Chef-Verwaltung entsperren.");
  employees=validateEmployees(employees);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv},encryptionKey,ENC.encode(JSON.stringify(employees)));
  localStorage.setItem(STORAGE_KEY,JSON.stringify({version:1,iv:b64(iv),data:b64(encrypted)}));
}
async function latestRemote(token=""){
  const headers={"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"};
  if(token)headers.Authorization="Bearer "+token;
  const url=API+"?ref=main&nocache="+Date.now();
  const response=await fetch(url,{method:"GET",headers,cache:"no-store"});
  if(!response.ok){
    if(response.status===403)throw Error("GitHub-Zugriff derzeit begrenzt oder nicht berechtigt (HTTP 403).");
    throw Error("Die Sperrliste konnte nicht geladen werden (HTTP "+response.status+").");
  }
  const file=await response.json();
  if(!file||typeof file.content!=="string"||typeof file.sha!=="string")throw Error("Die GitHub-Sperrdatei hat ein unerwartetes Format.");
  const data=validateList(JSON.parse(DEC.decode(un64(file.content))));
  return {data,sha:file.sha};
}
async function refreshStatus(){
  if(!unlocked)return;
  $("staffRefresh").disabled=true;
  try{
    const latest=await latestRemote();
    remote=latest.data;
    readError="";
    note("Sperrliste von GitHub geprüft. Gesperrte Personalnummern werden zentral geprüft.");
  }catch(e){
    readError=e.message||"Zentrale Sperrliste nicht erreichbar.";
    note(readError,true);
  }finally{
    $("staffRefresh").disabled=false;
    render();
  }
}
function status(entry){
  if(remote===null)return {text:"Online-Status noch nicht bestätigt",className:"staff-uncertain"};
  if(remote.revoked.includes(entry.eid))return {text:"Gesperrt",className:"staff-blocked"};
  if(entry.exp&&entry.exp<isoToday())return {text:"Abgelaufen",className:"staff-uncertain"};
  if(!entry.exp)return {text:"Erfasst · Ablaufdatum unbekannt",className:"staff-uncertain"};
  return {text:"Aktiv (laut erfassten Zugangsdaten)",className:"staff-active"};
}
function element(tag,klass,text){
  const node=document.createElement(tag);
  if(klass)node.className=klass;
  if(text!=null)node.textContent=text;
  return node;
}
function render(){
  const node=$("staffList");
  node.replaceChildren();
  if(!unlocked){
    $("staffSummary").textContent=demo?"Vorschau: keine echten Daten geladen.":"Mitarbeiterliste ist gesperrt.";
    return;
  }
  const ordered=[...employees].sort((a,b)=>a.name.localeCompare(b.name,"de"));
  const active=ordered.filter(x=>status(x).className==="staff-active").length;
  const locked=ordered.filter(x=>status(x).className==="staff-blocked").length;
  $("staffSummary").textContent=ordered.length+" Mitarbeiter erfasst · "+active+" aktiv · "+locked+" gesperrt";
  if(!ordered.length){
    node.append(element("p","empty","Noch keine Mitarbeiter in dieser Übersicht. Bereits früher erstellte Zugänge bitte unten mit ihrer tatsächlichen Personalnummer ergänzen."));
    return;
  }
  for(const item of ordered){
    const row=element("div","staff-row");
    const info=element("div","staff-info");
    info.append(element("div","staff-name",item.name));
    info.append(element("div","staff-meta","Personalnummer: "+item.eid+" · Gültig bis: "+(item.exp||"unbekannt")));
    const st=status(item);
    info.append(element("div","staff-status "+st.className,st.text));
    row.append(info);
    if(st.className!=="staff-blocked"&&st.text!=="Abgelaufen"){
      const action=element("button","revoke","Zugang sperren");
      action.type="button";
      action.disabled=publishing;
      action.addEventListener("click",()=>publishRevocation(item.eid,item.name).catch(e=>note(e.message||"Sperren fehlgeschlagen.",true)));
      row.append(action);
    }
    node.append(row);
  }
}
async function addIssued(invitations){
  if(!unlocked||demo)throw Error("Keine Chef-Freigabe für das Mitarbeiterverzeichnis.");
  for(const invite of invitations){
    if(!invite||!invite.name)continue;
    checkId(invite.eid);
  }
  const backup=[...employees];
  try{
    for(const inv of invitations){
      if(!inv||!inv.name)continue;
      const key=inv.eid.toUpperCase();
      employees=employees.filter(e=>e.eid.toUpperCase()!==key);
      employees.push({name:inv.name.trim(),eid:inv.eid,exp:inv.exp||null,issuedAt:new Date().toISOString()});
    }
    await persist();
  }catch(e){employees=backup;throw e;}
  render();
}
async function importExisting(){
  if(!unlocked||demo)throw Error("Bitte Chef-Verwaltung entsperren.");
  const text=$("staffImport").value.trim();
  if(!text)throw Error("Bitte bestehende Mitarbeiter in das Textfeld eingeben.");
  const rows=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(rows.length>200)throw Error("Maximal 200 Mitarbeiter auf einmal ergänzen.");
  const batch=[];
  for(const [index,row] of rows.entries()){
    const parts=row.split(";").map(v=>v.trim());
    if(parts.length<2||parts.length>3)throw Error("Zeile "+(index+1)+": Name;Personalnummer;Gültig bis.");
    const [name,eid,exp=""]=parts;
    if(!name||name.length>80)throw Error("Zeile "+(index+1)+": ungültiger Name.");
    checkId(eid);
    if(exp&&!/^\d{4}-\d{2}-\d{2}$/.test(exp))throw Error("Zeile "+(index+1)+": Ablaufdatum als JJJJ-MM-TT.");
    batch.push({name,eid,exp:exp||null});
  }
  await addIssued(batch);
  $("staffImport").value="";
  note(batch.length+" bestehende Mitarbeiter in die verschlüsselte Übersicht übernommen. Ihre Zugangsdaten und PINs wurden nicht verändert.");
}
async function publishRevocation(eid,name){
  if(!unlocked||demo)throw Error("Bitte zuerst als Chef anmelden.");
  if(publishing)return;
  checkId(eid);
  if(!confirm("Zugang für "+name+" ("+eid+") zentral sperren?\n\nAlle mit dieser Personalnummer ausgestellten Zugänge werden bei der nächsten Online-Prüfung abgewiesen. Die Sperrung lässt sich nicht direkt in diesem Menü aufheben."))return;
  const token=$("githubPat").value.trim();
  if(!token){
    $("githubPat").focus();
    throw Error("Zum wirksamen Sperren bitte ein GitHub Fine-grained Token (Contents: Read and write, nur UWE-Stunden-App) eingeben. Ohne Veröffentlichung ist der Zugang weiterhin gültig.");
  }
  publishing=true;
  render();
  note("Sperrung wird sicher an GitHub übertragen …");
  try{
    const current=await latestRemote(token);
    const revoked=new Set(current.data.revoked);
    if(revoked.has(eid)){
      remote=current.data;
      note("Die Personalnummer "+eid+" ist bereits zentral gesperrt.");
      return;
    }
    revoked.add(eid);
    const next={version:1,updatedAt:new Date().toISOString(),revoked:[...revoked].sort()};
    const payload={message:"UWE Stunden: Zugang für Personalnummer "+eid+" zentral sperren",
                   content:b64(ENC.encode(JSON.stringify(next,null,2)+"\n")),sha:current.sha,branch:"main"};
    const response=await fetch(API,{
      method:"PUT",cache:"no-store",
      headers:{"Accept":"application/vnd.github+json",
               "Authorization":"Bearer "+token,
               "Content-Type":"application/json",
               "X-GitHub-Api-Version":"2022-11-28"},
      body:JSON.stringify(payload)
    });
    if(!response.ok){
      if(response.status===401||response.status===403)
        throw Error("GitHub-Zugriff verweigert. Bitte Token, Repository und Berechtigung Contents: Read and write prüfen.");
      if(response.status===409)
        throw Error("Die Sperrliste wurde inzwischen geändert. Bitte erneut versuchen.");
      throw Error("Die zentrale Sperrung wurde nicht veröffentlicht (HTTP "+response.status+").");
    }
    remote=next;
    readError="";
    $("githubPat").value="";
    note("Zugang "+eid+" auf GitHub gesperrt. Die Website benötigt möglicherweise einige Minuten für die Veröffentlichung. Online-Apps prüfen anschließend die Sperrliste.");
  }finally{
    publishing=false;
    render();
  }
}
async function unlock(password){
  encryptionKey=await getKey(password);
  try{await loadEncryptedRoster();}
  catch(e){encryptionKey=null;employees=[];throw e;}
  unlocked=true;
  demo=false;
  $("staffArea").hidden=true;
  $("issueArea").hidden=false;
  showTab("issue");
  render();
  await refreshStatus();
}
function lock(){
  encryptionKey=null;employees=[];remote=null;unlocked=false;demo=false;
  $("githubPat").value="";
  $("staffImport").value="";
  $("staffArea").hidden=true;
  $("issueArea").hidden=false;
  render();
}
function preview(){
  lock();
  demo=true;
  $("staffArea").hidden=true;
  render();
}
function showTab(which){
  const staff=which==="staff";
  $("staffArea").hidden=!staff;
  $("issueArea").hidden=staff;
  $("showIssue").className=staff?"chef-tab secondary":"chef-tab current";
  $("showStaff").className=staff?"chef-tab current":"chef-tab secondary";
  if(staff&&unlocked)refreshStatus();
  if(staff&&!unlocked)note("Nur Vorschau. Mitarbeiterdaten und echte Sperrungen sind ohne Chef-Sicherung nicht zugänglich.",true);
}
$("staffRefresh").addEventListener("click",()=>refreshStatus());
$("staffImportBtn").addEventListener("click",()=>importExisting().catch(e=>note(e.message||"Import fehlgeschlagen.",true)));
$("showIssue").addEventListener("click",()=>showTab("issue"));
$("showStaff").addEventListener("click",()=>showTab("staff"));
window.addEventListener("pagehide",lock);
window.UweStaffAdmin={unlock,lock,preview,addIssued,assertIssuable:eid=>{
  checkId(eid);
  if(remote?.revoked.includes(eid))throw Error("Personalnummer "+eid+" ist gesperrt. Bitte eine andere Personalnummer verwenden.");
},refreshStatus};
})();
