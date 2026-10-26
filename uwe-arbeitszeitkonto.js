/* UWE Arbeitszeitkonto – private, employee-local test ledger.
   Initial -100h once from Nov 2026. No automatic deduction, no wages paid,
   no holiday zeroing, no central employee or payroll data stored here.
   Official NRW summer holiday dates:
   https://bass.schule.nrw/Stichwort/Ebene5?Ebene1=T&Ebene2=TE&Ebene3=Termine&Ebene4=Sommerferien+aller+Bundesl%C3%A4nder
*/
(function(){
"use strict";
const VERSION=1, START_MONTH="2026-11", START_MINUTES=-6000, FIRST_DEADLINE="2027-07-19";
const HOLIDAYS=Object.freeze({
  2026:"2026-07-20",2027:"2027-07-19",2028:"2028-07-10",
  2029:"2029-07-02",2030:"2030-06-24"
});
const KEY_PREFIX="uwe_arbeitszeitkonto_v1_";
const FUTURE_KEY="uwe_nrw_sommerferien_v1";
const MONTH=/^(20\d{2})-(0[1-9]|1[0-2])$/;
function monthOK(value){return typeof value==="string"&&MONTH.test(value)}
function hours(minutes){return (Number(minutes)/60).toFixed(2).replace(".",",")}
function parseHours(raw){
 const text=String(raw??"").trim().replace(",",".");
 if(!/^\d{1,5}(?:\.\d{1,2})?$/.test(text))throw Error("Bitte Stunden als Zahl eingeben, z. B. 20 oder 12,5.");
 const amount=Number(text);
 if(!Number.isFinite(amount)||amount<0||amount>10000)throw Error("Ungültige Stundenanzahl.");
 return Math.round(amount*60);
}
function gross(record){
 const start=String(record.start||""),end=String(record.end||"");
 if(!/^\d{2}:\d{2}$/.test(start)||!/^\d{2}:\d{2}$/.test(end))return NaN;
 const parts=value=>Number(value.slice(0,2))*60+Number(value.slice(3,5));
 let difference=parts(end)-parts(start);
 if(difference<0)difference+=1440;
 return difference-Number(record.pause||0);
}
function worked(records,month){
 if(!monthOK(month))return 0;
 let sum=0;
 for(const r of records||[]){
  if(!r||typeof r.date!=="string"||r.date.slice(0,7)!==month)continue;
  const m=gross(r);
  if(!Number.isFinite(m)||m<0)throw Error("Ungültige Arbeitszeit. Bitte die Einträge prüfen.");
  sum+=m;
 }
 return sum;
}
function initial(eid){
 checkId(eid);
 return {version:VERSION,eid,openingMinutes:START_MINUTES,startMonth:START_MONTH,
         initialDeadline:FIRST_DEADLINE,allocations:{}};
}
function checkId(eid){
 if(typeof eid!=="string"||!/^[A-Za-z0-9_-]{1,30}$/.test(eid))
  throw Error("Personalnummer des Arbeitszeitkontos ist ungültig.");
}
function validate(data,eid){
 checkId(eid);
 if(!data||data.version!==VERSION||data.eid!==eid||
    data.openingMinutes!==START_MINUTES||data.startMonth!==START_MONTH||
    data.initialDeadline!==FIRST_DEADLINE||
    !data.allocations||Array.isArray(data.allocations)||typeof data.allocations!=="object")
   throw Error("Die gespeicherten Kontodaten sind beschädigt oder gehören zu einem anderen Mitarbeiter. Bitte nicht löschen, sondern zunächst ein Backup sichern.");
 const cleaned=initial(eid);
 for(const [month,amount] of Object.entries(data.allocations)){
  if(!monthOK(month)||month<START_MONTH||
     !Number.isSafeInteger(amount)||amount<0||amount>600000)
   throw Error("Die gespeicherten Stundenübertragungen enthalten einen ungültigen Wert.");
  if(amount>0)cleaned.allocations[month]=amount;
 }
 return cleaned;
}
function key(eid){checkId(eid);return KEY_PREFIX+eid}
function load(eid,store=localStorage){
 const saved=store.getItem(key(eid));
 return saved===null?initial(eid):validate(JSON.parse(saved),eid);
}
function persist(state,store=localStorage){
 const cleaned=validate(state,state.eid);
 store.setItem(key(state.eid),JSON.stringify(cleaned));
 return cleaned;
}
function allocation(state,month){
 if(!state||!monthOK(month)||month<START_MONTH)return 0;
 return state.allocations[month]||0;
}
function balanceAt(state,month){
 if(!monthOK(month))throw Error("Ungültiger Monat.");
 let sum=START_MINUTES;
 for(const [m,v] of Object.entries(state.allocations)){
  if(m<=month)sum+=v;
 }
 return sum;
}
function balanceAll(state){
 return START_MINUTES+Object.values(state.allocations).reduce((a,b)=>a+b,0);
}
function invalidAllocations(state,records,endMonth){
 const found=[];
 for(const [month,value] of Object.entries(state.allocations)){
  if(endMonth&&month>endMonth)continue;
  const available=worked(records,month);
  if(value>available)found.push({month,allocated:value,worked:available});
 }
 return found.sort((a,b)=>a.month.localeCompare(b.month));
}
function summary(state,records,month){
 if(!monthOK(month))throw Error("Bitte einen gültigen Monat wählen.");
 const total=worked(records,month),allocated=allocation(state,month);
 const errors=invalidAllocations(state,records,month);
 return {month,eligible:month>=START_MONTH,total,allocated,
   available:Math.max(0,total-allocated),balance:balanceAt(state,month),
   overallBalance:balanceAll(state),invalid:errors,
   remainingToZero:Math.max(0,-balanceAt(state,month)),
   progressPct:Math.max(0,Math.min(100,(100+(balanceAt(state,month)/60))/100*100))};
}
function update(state,records,month,minutes){
 const clean=validate(state,state.eid);
 if(!monthOK(month)||month<START_MONTH)
  throw Error("Das Test-Arbeitszeitkonto beginnt erst im November 2026.");
 if(!Number.isSafeInteger(minutes)||minutes<0)
  throw Error("Bitte eine gültige Stundenanzahl eingeben.");
 const available=worked(records,month);
 if(minutes>available)throw Error("Du kannst höchstens "+hours(available)+" Stunden übertragen. Mehr Stunden wurden in diesem Monat nicht erfasst.");
 if(minutes===0)delete clean.allocations[month];
 else clean.allocations[month]=minutes;
 return clean;
}
function formatDate(iso){return /^20\d{2}-\d{2}-\d{2}$/.test(iso)?iso.slice(8,10)+"."+iso.slice(5,7)+"."+iso.slice(0,4):iso}
function daysUntil(iso,reference=new Date()){
 const day=Date.UTC(reference.getFullYear(),reference.getMonth(),reference.getDate());
 const then=Date.UTC(Number(iso.slice(0,4)),Number(iso.slice(5,7))-1,Number(iso.slice(8,10)));
 return Math.round((then-day)/86400000);
}
function isRealISO(iso,year){
 if(typeof iso!=="string"||!/^20\d{2}-\d{2}-\d{2}$/.test(iso))return false;
 const [y,m,d]=iso.split("-").map(Number);
 if(y!==year)return false;
 const candidate=new Date(Date.UTC(y,m-1,d));
 return candidate.getUTCFullYear()===y&&candidate.getUTCMonth()===m-1&&candidate.getUTCDate()===d&&m>=5&&m<=9;
}
function cachedYear(year,store=localStorage){
 try{
  const cache=JSON.parse(store.getItem(FUTURE_KEY)||"{}");
  const value=cache[String(year)];
  return isRealISO(value,year)?value:null;
 }catch{return null;}
}
function holiday(year,store=localStorage){
 const y=Number(year);
 if(!Number.isInteger(y)||y<2026||y>2100)return null;
 if(HOLIDAYS[y])return {year:y,date:HOLIDAYS[y],source:"Amtliche NRW-Termine (KMK)"};
 const fromCache=cachedYear(y,store);
 return fromCache?{year:y,date:fromCache,source:"Online-Ferienkalender (zwischengespeichert)"}:null;
}
async function findHolidayOnline(year,store=localStorage){
 const known=holiday(year,store);
 if(known)return known;
 const y=Number(year);
 if(!Number.isInteger(y)||y<2031||y>2100)return null;
 const api="https://openholidaysapi.org/SchoolHolidays?countryIsoCode=DE&subdivisionCode=DE-NW"+
   "&validFrom="+y+"-01-01&validTo="+y+"-12-31&languageIsoCode=DE";
 let data;
 try{
  const response=await fetch(api,{method:"GET",cache:"no-store",mode:"cors"});
  if(!response.ok)throw Error("Ferien-API nicht erreichbar");
  data=await response.json();
 }catch{return null;}
 if(!Array.isArray(data))return null;
 let found=null;
 for(const row of data){
  const names=Array.isArray(row.name)?row.name.map(x=>x&&x.text).join(" "):String(row.name||"");
  const label=(names+" "+String(row.type||"")).toLowerCase();
  if(!/sommer|summer/.test(label))continue;
  if(isRealISO(row.startDate,y)&&(!found||row.startDate<found))found=row.startDate;
 }
 if(!found)return null;
 try{
  const current=JSON.parse(store.getItem(FUTURE_KEY)||"{}");
  current[String(y)]=found;
  store.setItem(FUTURE_KEY,JSON.stringify(current));
 }catch{}
 return {year:y,date:found,source:"Online-Ferienkalender OpenHolidays"};
}
function nextSummer(reference=new Date(),store=localStorage){
 const start=reference.getFullYear();
 for(let y=Math.max(start,2026);y<=Math.max(start,2026)+1;y++){
  const item=holiday(y,store);
  if(item&&daysUntil(item.date,reference)>=0)return item;
 }
 return holiday(start+1,store);
}
window.UweWorkAccount={
 VERSION,START_MONTH,START_MINUTES,FIRST_DEADLINE,HOLIDAYS,initial,load,persist,validate,update,
 parseHours,hours,worked,allocation,balanceAt,balanceAll,summary,invalidAllocations,
 formatDate,daysUntil,holiday,nextSummer,findHolidayOnline
};
})();