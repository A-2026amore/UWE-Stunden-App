(()=>{
"use strict";
// Network-only status check. A cached PWA must not accept stale access-control data.
const STATUS="./uwe-access-control.json";
const GOOD_FOR_MS=45000;
let latest={eid:null,checkedAt:0,revoked:false};
function denied(message,code){
  const e=new Error(message);
  e.code=code;
  return e;
}
function validate(data){
  if(!data||data.version!==1||!Array.isArray(data.revoked)||data.revoked.length>10000||
      !data.revoked.every(id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,30}$/.test(id)))
    throw denied("Die UWE-Zugangssperrliste ist ungültig. Bitte die Geschäftsleitung informieren.","CHECK_ERROR");
  return data;
}
async function check(eid,force=false){
  if(typeof eid!=="string"||!/^[A-Za-z0-9_-]{1,30}$/.test(eid))
    throw denied("Ungültige Personalnummer.","CHECK_ERROR");
  if(latest.eid===eid&&!force&&Date.now()-latest.checkedAt<GOOD_FOR_MS){
    if(latest.revoked)throw denied("Dieser Mitarbeiterzugang wurde von UWE gesperrt. Bitte die Geschäftsleitung kontaktieren.","UWE_REVOKED");
    return true;
  }
  // Important: never use localStorage or service-worker cache for a revocation check.
  // Old employee entries themselves remain stored locally even when access is denied.
  const url=new URL(STATUS,location.href);
  url.searchParams.set("_check",String(Date.now()));
  let res;
  try{
    res=await fetch(url.href,{cache:"no-store",credentials:"omit"});
  }catch{
    throw denied("Zur Prüfung deines Mitarbeiterzugangs wird eine Internetverbindung benötigt. Bitte online erneut versuchen.","CHECK_OFFLINE");
  }
  if(!res.ok)throw denied("Die UWE-Zugangsprüfung ist derzeit nicht erreichbar (HTTP "+res.status+"). Bitte erneut versuchen.","CHECK_OFFLINE");
  let data;
  try{data=validate(await res.json());}
  catch(e){throw e?.code?e:denied("Zugangssperrliste konnte nicht gelesen werden. Bitte erneut versuchen.","CHECK_ERROR");}
  latest={eid,checkedAt:Date.now(),revoked:data.revoked.includes(eid)};
  if(latest.revoked)
    throw denied("Dieser Mitarbeiterzugang wurde von UWE gesperrt. Bitte die Geschäftsleitung kontaktieren.","UWE_REVOKED");
  return true;
}
function clear(){latest={eid:null,checkedAt:0,revoked:false};}
function isFresh(eid){return latest.eid===eid&&!latest.revoked&&Date.now()-latest.checkedAt<GOOD_FOR_MS;}
window.UweAccessControl={check,clear,isFresh};
})();
