/* UWE Arbeitszeitkonto – TEST: Separate -100h pro NRW-Schuljahr.
   Beginn: erster Schultag nach Sommerferien. Ende: letzter Schultag
   vor den nächsten Sommerferien. Historische Jahreskonten bleiben bestehen.
   NRW Ferienquelle: https://bass.schule.nrw/191.htm
*/
(function(){
"use strict";
const VERSION=2,START_MONTH="2026-09",START_MINUTES=-6000,KEY_PREFIX="uwe_arbeitszeitkonto_v1_";
const FUTURE_KEY="uwe_nrw_sommerferien_v2";
const MONTH=/^(20\d{2})-(0[1-9]|1[0-2])$/;
const OFFICIAL=Object.freeze({
  2026:{start:"2026-07-20",end:"2026-09-01"},
  2027:{start:"2027-07-19",end:"2027-08-31"},
  2028:{start:"2028-07-10",end:"2028-08-22"},
  2029:{start:"2029-07-02",end:"2029-08-14"},
  2030:{start:"2030-06-24",end:"2030-08-06"}
});
const hasOwn=(obj,key)=>Object.prototype.hasOwnProperty.call(obj,key);
function monthOK(v){return typeof v==="string"&&MONTH.test(v);}
function checkId(v){if(typeof v!=="string"||!/^[A-Za-z0-9_-]{1,30}$/.test(v))throw Error("Personalnummer ungültig.");}
function hours(minutes){return (Number(minutes)/60).toFixed(2).replace(".",",");}
function parseHours(raw){
 const v=String(raw??"").trim().replace(",",".");
 if(!/^\d{1,5}(?:\.\d{1,2})?$/.test(v))throw Error("Stunden bitte als Zahl eingeben (z. B. 20 oder 12,5).");
 const n=Number(v);
 if(!Number.isFinite(n)||n<0||n>10000)throw Error("Ungültiger Stundenwert.");
 return Math.round(n*60);
}
function iso(date){return date.toISOString().slice(0,10);}
function addDays(value,count){
 const d=new Date(value+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+count);return iso(d);
}
function isRealISO(value,year){
 if(typeof value!=="string"||!/^20\d{2}-\d{2}-\d{2}$/.test(value))return false;
 const [y,m,d]=value.split("-").map(Number);
 const dt=new Date(Date.UTC(y,m-1,d));
 return y===year&&dt.getUTCFullYear()===y&&dt.getUTCMonth()===m-1&&dt.getUTCDate()===d;
}
function formatDate(value){return /^20\d{2}-\d{2}-\d{2}$/.test(value)?value.slice(8,10)+"."+value.slice(5,7)+"."+value.slice(0,4):value;}
function daysUntil(value,reference=new Date()){
 const day=Date.UTC(reference.getFullYear(),reference.getMonth(),reference.getDate());
 const target=Date.UTC(Number(value.slice(0,4)),Number(value.slice(5,7))-1,Number(value.slice(8,10)));
 return Math.round((target-day)/86400000);
}
function cacheRead(store){
 try{const o=JSON.parse(store.getItem(FUTURE_KEY)||"{}");return o&&typeof o==="object"&&!Array.isArray(o)?o:{};}
 catch{return{};}
}
function holiday(year,store=localStorage){
 const y=Number(year);
 if(!Number.isInteger(y)||y<2026||y>2100)return null;
 if(OFFICIAL[y])return{year:y,date:OFFICIAL[y].start,start:OFFICIAL[y].start,
   end:OFFICIAL[y].end,source:"Offizieller NRW-Ferienkalender"};
 const row=cacheRead(store)[String(y)];
 if(row&&isRealISO(row.start,y)&&isRealISO(row.end,y)&&row.end>row.start&&
    row.start.slice(5,7)>="05"&&row.start.slice(5,7)<="09")
   return{year:y,date:row.start,start:row.start,end:row.end,source:"OpenHolidays Online-Ferienkalender"};
 return null;
}
function lastSchoolday(summerStart){
 let day=addDays(summerStart,-1);
 for(let j=0;j<7;j++){
  const dow=new Date(day+"T12:00:00Z").getUTCDay();
  if(dow!==0&&dow!==6)return day;
  day=addDays(day,-1);
 }
 return day;
}
function cycle(year,store=localStorage){
 const y=Number(year),previous=holiday(y,store),next=holiday(y+1,store);
 if(!previous||!next)return null;
 const start=addDays(previous.end,1);
 const end=lastSchoolday(next.start);
 if(start>=next.start||end<start)return null;
 return{year:y,id:String(y),label:String(y)+"/"+String(y+1).slice(2),
   start,lastSchoolDay:end,summerStart:next.start,summerEnd:next.end,
   afterSummerStart:addDays(next.end,1),source:next.source};
}
function schoolYearForDate(date,store=localStorage){
 if(typeof date!=="string"||!/^20\d{2}-\d{2}-\d{2}$/.test(date))return null;
 const y=Number(date.slice(0,4));
 for(const candidate of [y-1,y]){
  if(candidate<2026)continue;
  const school=cycle(candidate,store);
  if(school&&date>=school.start&&date<=school.lastSchoolDay)return school;
 }
 return null;
}
function calendarForMonth(month,store=localStorage){
 if(!monthOK(month))throw Error("Bitte gültigen Monat wählen.");
 const start=month+"-01",end=addDays(month+"-01",new Date(Number(month.slice(0,4)),Number(month.slice(5,7)),0).getDate()-1);
 for(let d=start;d<=end;d=addDays(d,1)){
  const found=schoolYearForDate(d,store);
  if(found)return{...found,status:"active"};
 }
 const year=Number(month.slice(0,4));
 for(const candidate of [year-1,year]){
  const h=holiday(candidate,store);
  if(h&&start<=h.end&&end>=h.start){
   const prev=cycle(candidate-1,store),next=cycle(candidate,store);
   return{status:"vacation",year:prev?.year??null,label:prev?.label||"Sommerferien",
     previous:prev,next:next,summerStart:h.start,summerEnd:h.end,afterSummerStart:addDays(h.end,1)};
  }
 }
 return{status:month<START_MONTH?"before":"unknown",year:null,label:"Termin offen"};
}
function gross(record){
 if(!record)return NaN;
 const a=String(record.start||""),b=String(record.end||"");
 if(!/^\d{2}:\d{2}$/.test(a)||!/^\d{2}:\d{2}$/.test(b))return NaN;
 const val=t=>Number(t.slice(0,2))*60+Number(t.slice(3,5));
 let span=val(b)-val(a);if(span<0)span+=1440;
 const pause=Number(record.pause||0);
 return Number.isFinite(pause)?span-pause:NaN;
}
function worked(records,month){let total=0;
 for(const r of records||[]){
  if(!r?.date||r.date.slice(0,7)!==month)continue;
  const m=gross(r);if(!Number.isFinite(m)||m<0)throw Error("Ungültige Monatsarbeitszeit.");
  total+=m;
 }
 return total;
}
function eligibleWorked(records,month,store=localStorage){
 const info=calendarForMonth(month,store);if(info.status!=="active")return 0;
 let total=0;
 for(const r of records||[]){
  if(!r?.date||r.date.slice(0,7)!==month)continue;
  if(schoolYearForDate(r.date,store)?.year!==info.year)continue;
  const minutes=gross(r);
  if(!Number.isFinite(minutes)||minutes<0)throw Error("Ungültige Einsatzzeit.");
  total+=minutes;
 }
 return total;
}
function initial(eid){checkId(eid);return{version:VERSION,eid,openingMinutes:START_MINUTES,startMonth:START_MONTH,allocations:{}};}
function validate(data,eid){
 checkId(eid);
 if(!data||data.eid!==eid||![1,2].includes(data.version)||data.openingMinutes!==START_MINUTES||
   !data.allocations||typeof data.allocations!=="object"||Array.isArray(data.allocations))
   throw Error("Arbeitszeitkonto beschädigt oder einem anderen Mitarbeiter zugeordnet. Bitte Daten sichern.");
 const cleaned=initial(eid);
 for(const [month,amount] of Object.entries(data.allocations)){
  if(!monthOK(month)||month<"2026-09"||!Number.isSafeInteger(amount)||amount<0||amount>600000)
   throw Error("Ungültiger gespeicherter Arbeitszeitkontoeintrag.");
  if(amount>0)cleaned.allocations[month]=amount;
 }
 return cleaned;
}
function key(eid){checkId(eid);return KEY_PREFIX+eid;}
function load(eid,store=localStorage){
 const raw=store.getItem(key(eid));
 return raw===null?initial(eid):validate(JSON.parse(raw),eid);
}
function persist(state,store=localStorage){
 const cleaned=validate(state,state.eid);
 store.setItem(key(state.eid),JSON.stringify(cleaned));
 return cleaned;
}
function allocation(state,month){return monthOK(month)?state.allocations[month]||0:0;}
function balanceForCycle(state,year,store=localStorage,throughMonth=null){
 let total=START_MINUTES;
 for(const [month,minutes] of Object.entries(state.allocations)){
  if(throughMonth&&month>throughMonth)continue;
  const info=calendarForMonth(month,store);
  if(info.status==="active"&&info.year===year)total+=minutes;
 }
 return total;
}
function invalidAllocations(state,records,endMonth=null,store=localStorage){
 const problems=[];
 for(const [month,minutes] of Object.entries(state.allocations)){
  if(endMonth&&month>endMonth)continue;
  const available=eligibleWorked(records,month,store);
  if(minutes>available)problems.push({month,allocated:minutes,worked:available});
 }
 return problems.sort((a,b)=>a.month.localeCompare(b.month));
}
function summary(state,records,month,store=localStorage){
 if(!monthOK(month))throw Error("Bitte gültigen Monat wählen.");
 const school=calendarForMonth(month,store);
 const total=worked(records,month);
 const eligible=school.status==="active"?eligibleWorked(records,month,store):0;
 const allocated=allocation(state,month);
 const year=school.status==="active"?school.year:school.previous?.year;
 const balance=year!=null?balanceForCycle(state,year,store,month):START_MINUTES;
 const overallBalance=year!=null?balanceForCycle(state,year,store):START_MINUTES;
 return{month,schoolYear:school,eligible:school.status==="active",total,
  eligibleWorked:eligible,allocated,available:Math.max(0,total-allocated),
  balance,overallBalance,invalid:invalidAllocations(state,records,month,store),
  remainingToZero:Math.max(0,-overallBalance),
  progressPct:Math.max(0,Math.min(100,(overallBalance-START_MINUTES)/(-START_MINUTES)*100))};
}
function update(state,records,month,minutes,store=localStorage){
 const cleaned=validate(state,state.eid);
 const school=calendarForMonth(month,store);
 if(school.status!=="active")throw Error(school.status==="vacation"?
  "In den Sommerferien ist das Schuljahreskonto geschlossen. Für das neue Schuljahr beginnt ein neuer Stand von –100 Stunden.":
  "Für diesen Monat ist noch kein bestätigtes Schuljahr vorhanden. Bitte Ferienkalender online aktualisieren.");
 if(!Number.isSafeInteger(minutes)||minutes<0)throw Error("Ungültige Stundenanzahl.");
 const available=eligibleWorked(records,month,store);
 if(minutes>available)throw Error("Du kannst höchstens "+hours(available)+" Stunden aus der Schulzeit dieses Monats übertragen.");
 if(minutes)cleaned.allocations[month]=minutes;else delete cleaned.allocations[month];
 return cleaned;
}
function cyclesWithBalances(state,store=localStorage){
 const years=new Set([2026]);
 const now=new Date();
 for(let y=2026;y<=now.getFullYear();y++)if(cycle(y,store))years.add(y);
 for(const month of Object.keys(state.allocations)){
  const info=calendarForMonth(month,store);
  if(info.status==="active")years.add(info.year);
 }
 return [...years].sort((a,b)=>a-b).map(year=>({cycle:cycle(year,store),balance:balanceForCycle(state,year,store)})).filter(x=>x.cycle);
}
async function findHolidayOnline(year,store=localStorage){
 const confirmed=holiday(year,store);
 if(confirmed)return confirmed;
 const y=Number(year);
 if(!Number.isInteger(y)||y<2031||y>2100)return null;
 const url="https://openholidaysapi.org/SchoolHolidays?countryIsoCode=DE&subdivisionCode=DE-NW"+
   "&validFrom="+y+"-01-01&validTo="+y+"-12-31&languageIsoCode=DE";
 let list;
 try{const response=await fetch(url,{method:"GET",cache:"no-store",mode:"cors"});
  if(!response.ok)return null;list=await response.json();
 }catch{return null;}
 if(!Array.isArray(list))return null;
 const matching=list.filter(x=>{
  const name=Array.isArray(x.name)?x.name.map(t=>t?.text||"").join(" "):String(x.name||"");
  return /sommer|summer/i.test(name)&&isRealISO(x.startDate,y)&&isRealISO(x.endDate,y)&&x.endDate>x.startDate;
 }).sort((a,b)=>a.startDate.localeCompare(b.startDate));
 if(!matching.length)return null;
 const item=matching[0],data=cacheRead(store);
 data[String(y)]={start:item.startDate,end:item.endDate};
 try{store.setItem(FUTURE_KEY,JSON.stringify(data));}catch{}
 return holiday(y,store);
}
function nextSummer(reference=new Date(),store=localStorage){
 const now=iso(new Date(reference.getFullYear(),reference.getMonth(),reference.getDate()));
 for(let y=Math.max(reference.getFullYear(),2026);y<=Math.max(reference.getFullYear(),2026)+2;y++){
  const h=holiday(y,store);
  if(h&&h.start>=now)return h;
 }
 return null;
}
window.UweWorkAccount={VERSION,START_MONTH,START_MINUTES,OFFICIAL,initial,validate,load,persist,
  parseHours,hours,worked,eligibleWorked,allocation,summary,update,invalidAllocations,
  calendarForMonth,schoolYearForDate,cycle,balanceForCycle,cyclesWithBalances,
  formatDate,daysUntil,holiday,nextSummer,findHolidayOnline};
})();