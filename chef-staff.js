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
let view="staff";
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
    map.set(item.eid.toUpperCase(),{name:item.name.trim(),eid:item.eid,exp:item.exp||null,issuedAt:item.issuedAt||null,desiredActive:typeof item.desiredActive==="boolean"?item.desiredActive:null});
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
  const headers={"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2026-03-10"};
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
  $("staffRefreshChanges").disabled=true;
  try{
    let result;
    try{result=await latestRemote();}
    catch(apiError){
      // A public status file remains readable even if unauthenticated GitHub API is rate-limited.
      const url=new URL("./uwe-access-control.json",location.href);
      url.searchParams.set("_online",String(Date.now()));
      const response=await fetch(url.href,{cache:"no-store"});
      if(!response.ok)throw apiError;
      result={data:validateList(await response.json())};
    }
    remote=result.data;
    readError="";
    let reconciled=0;
    for(const entry of employees){
      if(entry.desiredActive===null)continue;
      const actual=centralActive(entry);
      if(entry.desiredActive===actual){
        entry.desiredActive=null;
        reconciled++;
      }
    }
    if(reconciled)await persist();
    note("Zugangsstatus online aktualisiert."+(reconciled?" "+reconciled+" veröffentlichte Änderungen bestätigt.":""));
  }catch(e){
    remote=null;
    readError=e.message||"Zentrale Sperrliste nicht erreichbar.";
    note("Die zentrale Sperrliste ist nicht erreichbar. Eine wirksame Sperre kann zurzeit nicht geprüft werden.",true);
  }finally{
    $("staffRefresh").disabled=false;
    $("staffRefreshChanges").disabled=false;
    render();
  }
}
function centralRevoked(entry){
  return !!remote?.revoked.some(id=>id.toUpperCase()===entry.eid.toUpperCase());
}
function centralActive(entry){
  return !!remote&&!centralRevoked(entry)&&(!entry.exp||entry.exp>=isoToday());
}
function pendingItems(){
  return employees.filter(e=>typeof e.desiredActive==="boolean"&&
    (remote===null||e.desiredActive!==centralActive(e)));
}
function status(entry){
  if(remote===null)return {text:"Zentralstatus momentan unbekannt",className:"staff-uncertain"};
  if(centralRevoked(entry))return {text:"Gesperrt – zentral bestätigt",className:"staff-blocked"};
  if(entry.exp&&entry.exp<isoToday())return {text:"Zugang abgelaufen",className:"staff-uncertain"};
  if(!entry.exp)return {text:"Nicht gesperrt · Ablauf unbekannt",className:"staff-uncertain"};
  return {text:"Aktiv – nicht gesperrt",className:"staff-active"};
}
function element(tag,klass,text){
  const node=document.createElement(tag);
  if(klass)node.className=klass;
  if(text!=null)node.textContent=text;
  return node;
}
async function queueToggle(item,enabled){
  if(!unlocked||demo)throw Error("Bitte die Chef-Verwaltung entsperren.");
  if(remote===null)throw Error("Bitte zuerst den zentralen Status online aktualisieren.");
  if(enabled&&item.exp&&item.exp<isoToday())throw Error("Der Zugang ist abgelaufen. Für diesen Mitarbeiter einen neuen Zugang ausstellen.");
  const current=centralActive(item);
  if(enabled!==current){
    const message=enabled?
      "Zugang für "+item.name+" ("+item.eid+") zur WIEDERFREIGABE vormerken?\n\nDafür muss die zentrale GitHub-Sperrliste geändert werden. Die vorhandene PIN bleibt gültig, sofern der Zugang nicht abgelaufen ist.":
      "Zugang für "+item.name+" ("+item.eid+") zur SPERRUNG vormerken?\n\nDies ist noch keine tatsächliche Sperre! Zuerst offene Stundennachweise anfordern. Sende danach den Auftrag an ChatGPT, damit die Sperrung zentral veröffentlicht wird.";
    if(!confirm(message))return;
  }
  const prior=item.desiredActive;
  item.desiredActive=enabled===current?null:enabled;
  try{await persist();}
  catch(e){item.desiredActive=prior;throw e;}
  render();
  note(item.desiredActive===null?"Vormerkung zurückgenommen.":"Änderung für "+item.name+" vorgemerkt – noch NICHT wirksam. Über „Änderungsauftrag für ChatGPT kopieren“ kannst du sie zur Veröffentlichung übergeben.");
}
function render(){
  const node=$("staffList");
  node.replaceChildren();
  if(!unlocked){
    $("staffSummary").textContent=demo?"Vorschau: keine echten Daten geladen.":"Mitarbeiterliste ist gesperrt.";
    $("staffPending").textContent="Keine Änderungen vorgemerkt.";
    $("staffCopyChanges").disabled=true;
    return;
  }
  const all=[...employees].sort((a,b)=>a.name.localeCompare(b.name,"de"));
  const visible=view==="active"?
    all.filter(x=>remote===null?!(x.exp&&x.exp<isoToday()):centralActive(x)):all;
  const active=all.filter(centralActive).length;
  const locked=all.filter(centralRevoked).length;
  const pending=pendingItems();
  $("staffSummary").textContent=all.length+" Mitarbeiter erfasst · "+(remote?active:"?")+" aktiv · "+(remote?locked:"?")+" gesperrt · "+pending.length+" Änderung(en) vorgemerkt";
  $("staffPending").textContent=pending.length?
    pending.length+" Änderung(en) noch nicht wirksam. Erst nach Bestätigung der Veröffentlichung durch ChatGPT ist der zentrale Zugang geändert.":
    "Keine Änderungen vorgemerkt. Der angezeigte Status entspricht der zentral veröffentlichten Liste.";
  $("staffPending").className=pending.length?"staff-pending-count":"small";
  $("staffCopyChanges").disabled=!pending.length;
  $("staffViewTitle").textContent=view==="active"?"4. Aktive Mitarbeiter":"4. Alle Mitarbeiter";
  $("staffViewText").textContent=view==="active"?
    "Hier erscheinen die erfassten Mitarbeiter, deren Zugang nach der zentralen Sperrliste derzeit nicht gesperrt und noch nicht abgelaufen ist. Ein erfolgreicher Login wird weiterhin nicht protokolliert.":
    "Hier siehst du alle lokal erfassten Mitarbeiter samt zentralem Zugangsstatus. Früher ausgestellte Links müssen einmalig importiert werden.";
  if(!visible.length){
    node.append(element("p","empty",view==="active"?
      "Zurzeit sind keine aktiven Mitarbeiter erfasst. Wenn du bereits Zugänge verschickt hast, übernimm unten zuerst deine bisherige Mitarbeiterliste.":
      "Noch keine Mitarbeiter in der Übersicht. Übernimm die fünf vorbereiteten Mitarbeiter unten mit einem Klick."));
    return;
  }
  for(const item of visible){
    const row=element("div","staff-row");
    const info=element("div","staff-info");
    info.append(element("div","staff-name",item.name));
    info.append(element("div","staff-meta","Personalnummer: "+item.eid+" · Gültig bis: "+(item.exp?item.exp.slice(8,10)+"."+item.exp.slice(5,7)+"."+item.exp.slice(0,4):"unbekannt")));
    const current=status(item);
    info.append(element("div","staff-status "+current.className,current.text));
    if(typeof item.desiredActive==="boolean"&&
       (remote===null||item.desiredActive!==centralActive(item)))
      info.append(element("div","staff-waiting","Änderung vorgemerkt: "+(item.desiredActive?"Freigabe":"Sperre")+" – NICHT wirksam"));
    row.append(info);
    const label=element("label","staff-toggle");
    const checkbox=element("input");
    checkbox.type="checkbox";
    checkbox.checked=typeof item.desiredActive==="boolean"?item.desiredActive:centralActive(item);
    checkbox.disabled=remote===null||!!(item.exp&&item.exp<isoToday());
    checkbox.setAttribute("aria-label","Zugang für "+item.name+" aktivieren oder sperren");
    checkbox.addEventListener("change",()=>queueToggle(item,checkbox.checked).catch(e=>{note(e.message||"Änderung fehlgeschlagen.",true);render();}));
    const pending=typeof item.desiredActive==="boolean"&&(remote===null||item.desiredActive!==centralActive(item));
    const labelText=pending?(item.desiredActive?"Aktivierung vorgemerkt":"Sperrung vorgemerkt"):
      remote===null?"Status unbekannt":checkbox.checked?"Aktiv":"Gesperrt";
    label.append(checkbox,element("span","",labelText));
    row.append(label);
    node.append(row);
  }
}
async function copyChanges(){
  if(!unlocked||demo)throw Error("Chef-Verwaltung ist gesperrt.");
  if(remote===null)throw Error("Der zentrale Status ist nicht überprüft. Bitte zuerst aktualisieren.");
  const pending=pendingItems();
  if(!pending.length)throw Error("Es sind keine Änderungen vorgemerkt.");
  const lines=pending.map(item=>"- "+item.eid+" ("+item.name+"): "+(item.desiredActive?"AKTIVIEREN – aus revoked entfernen":"SPERREN – zu revoked hinzufügen"));
  const message="UWE Stunden-App – Bitte ändere die zentrale Zugangs-Sperrliste in meinem verbundenen GitHub-Repository A-2026amore/UWE-Stunden-App, Datei uwe-access-control.json. Verwende den AKTUELLEN Stand der Datei und bewahre alle anderen Sperren unverändert. Setze diese Änderungen um:\n"+
    lines.join("\n")+
    "\nBitte bestätige die Sperren oder Freigaben erst, wenn die aktualisierte Datei erfolgreich nach GitHub geschrieben und anschließend überprüft wurde. Ändere keine PINs und keine gespeicherten Stunden.";
  if(!navigator.clipboard?.writeText)throw Error("Kopieren wird vom Browser nicht unterstützt. Bitte in Safari, Chrome oder Edge über HTTPS öffnen.");
  await navigator.clipboard.writeText(message);
  note("Änderungsauftrag kopiert. Bitte jetzt hier in unseren Chat einfügen und abschicken. Danach den zentralen Status aktualisieren.");
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
      const existing=employees.find(e=>e.eid.toUpperCase()===key);
      employees=employees.filter(e=>e.eid.toUpperCase()!==key);
      employees.push({name:inv.name.trim(),eid:inv.eid,exp:inv.exp||existing?.exp||null,
        issuedAt:existing?.issuedAt||new Date().toISOString(),
        desiredActive:existing?.desiredActive??null});
    }
    await persist();
  }catch(e){employees=backup;throw e;}
  render();
}
function normalizeExpiry(raw){
  const value=String(raw||"").trim();
  if(!value)return null;
  let iso=value;
  const german=value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if(german)iso=german[3]+"-"+german[2]+"-"+german[1];
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso))
    throw Error("Bitte ein Datum als 31.12.2027 oder 2027-12-31 eingeben.");
  const [year,month,day]=iso.split("-").map(Number);
  const date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)
    throw Error("Das Ablaufdatum "+value+" existiert nicht.");
  return iso;
}
async function importExisting(){
  if(!unlocked||demo)throw Error("Bitte die Chef-Verwaltung entsperren.");
  const raw=$("staffImport").value.trim();
  if(!raw)throw Error("Bitte Mitarbeiter in das Textfeld eingeben.");
  const rows=raw.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(rows.length>200)throw Error("Maximal 200 Mitarbeiter auf einmal ergänzen.");
  const batch=[];
  const known=new Set();
  for(const [index,row] of rows.entries()){
    const parts=row.split(";").map(v=>v.trim());
    if(parts.length<2||parts.length>3)throw Error("Zeile "+(index+1)+": Name;Personalnummer;Gültig bis.");
    const [name,eid,expiration=""]=parts;
    if(!name||name.length>80)throw Error("Zeile "+(index+1)+": ungültiger Name.");
    checkId(eid);
    if(known.has(eid.toUpperCase()))throw Error("Zeile "+(index+1)+": Personalnummer mehrfach vorhanden.");
    known.add(eid.toUpperCase());
    let exp;
    try{exp=normalizeExpiry(expiration);}
    catch(e){throw Error("Zeile "+(index+1)+": "+e.message);}
    batch.push({name,eid,exp});
  }
  await addIssued(batch);
  $("staffImport").value="";
  note(batch.length+" bestehende Mitarbeiter in die verschlüsselte Übersicht übernommen. PINs und Einladungslinks bleiben unverändert. Bitte prüfe die Namen und Personalnummern.");
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
  const isStaff=which!=="issue";
  view=which==="active"?"active":"staff";
  $("staffArea").hidden=!isStaff;
  $("issueArea").hidden=isStaff;
  $("showIssue").className=!isStaff?"chef-tab current":"chef-tab secondary";
  $("showStaff").className=isStaff&&view==="staff"?"chef-tab current":"chef-tab secondary";
  $("showActive").className=isStaff&&view==="active"?"chef-tab current":"chef-tab secondary";
  render();
  if(isStaff&&unlocked)refreshStatus();
  if(isStaff&&!unlocked)note("Nur Vorschau. Mitarbeiterdaten und echte Sperren sind ohne Chef-Sicherung nicht zugänglich.",true);
}
$("staffRefresh").addEventListener("click",()=>refreshStatus());
$("staffRefreshChanges").addEventListener("click",()=>refreshStatus());
$("staffCopyChanges").addEventListener("click",()=>copyChanges().catch(e=>note(e.message||"Kopieren fehlgeschlagen.",true)));
$("staffImportBtn").addEventListener("click",()=>importExisting().catch(e=>note(e.message||"Import fehlgeschlagen.",true)));
$("showIssue").addEventListener("click",()=>showTab("issue"));
$("showStaff").addEventListener("click",()=>showTab("staff"));
$("showActive").addEventListener("click",()=>showTab("active"));
window.addEventListener("pagehide",lock);
window.UweStaffAdmin={unlock,lock,preview,addIssued,assertIssuable:eid=>{
  checkId(eid);
  if(remote?.revoked.some(id=>id.toUpperCase()===eid.toUpperCase()))throw Error("Personalnummer "+eid+" ist gesperrt. Bitte eine andere Personalnummer verwenden.");
},refreshStatus};
})();
