/* UWE Arbeitszeit: betriebliche Pausenregel (ab 6h 30m, ab 9h 45m).
   Validiert den Arbeitstag inklusive mehrerer getrennter Einsätze.
   Bereits gespeicherte Stunden werden hier niemals automatisch verändert. */
(function(){
  "use strict";
  const MIN_DAY_30=360,MIN_DAY_45=540,MAX_SHIFT=720;
  function clock(value){
    if(typeof value!=="string"||!/^\d{2}:\d{2}$/.test(value))return NaN;
    const h=Number(value.slice(0,2)),m=Number(value.slice(3));
    return h<24&&m<60?h*60+m:NaN;
  }
  function gross(shift){
    if(!shift)return NaN;
    const start=clock(shift.start),end=clock(shift.end);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start===end)return NaN;
    return end>start?end-start:end+1440-start;
  }
  function necessary(grossMinutes){
    if(!Number.isFinite(grossMinutes)||grossMinutes<=0)return 0;
    // UWE policy intentionally also covers exactly 6:00 and exactly 9:00.
    return grossMinutes>=MIN_DAY_45?45:grossMinutes>=MIN_DAY_30?30:0;
  }
  function evaluateDay(items,date){
    const shifts=(items||[]).filter(s=>s&&s.date===date);
    let totalGross=0,totalEntered=0,recognized=0;
    const timeline=[];
    for(const s of shifts){
      const duration=gross(s);
      const pause=Number(s.pause);
      if(!Number.isFinite(duration)||!Number.isInteger(pause)||pause<0||pause>=duration){
        return {valid:false,reason:"Bitte Arbeitsbeginn, Ende und Pause korrigieren.",date};
      }
      if(duration>MAX_SHIFT){
        return {valid:false,reason:"Ein Einsatz darf höchstens 12 Stunden dauern. Bitte die Uhrzeiten prüfen.",date,tooLong:true};
      }
      totalGross+=duration;
      totalEntered+=pause;
      // Under §4 ArbZG, pieces shorter than 15 minutes do not satisfy
      // statutory pause requirements (though unpaid minutes still deduct).
      if(pause>=15)recognized+=pause;
      const start=clock(s.start);
      timeline.push({start,end:start+duration,overnight:start+duration>1440});
    }
    if(totalGross>MAX_SHIFT){
      return {valid:false,reason:"Die eingetragenen Einsätze ergeben zusammen mehr als 12 Stunden an diesem Tag. Bitte korrigieren.",date,tooLong:true,gross:totalGross};
    }
    timeline.sort((a,b)=>a.start-b.start);
    let gap=0;
    for(let i=1;i<timeline.length;i++){
      const previous=timeline[i-1],next=timeline[i];
      if(previous.end>next.start){
        return {valid:false,reason:"Zwei Einsätze überschneiden sich am selben Tag. Bitte die Zeiten korrigieren.",date,overlap:true};
      }
      // A gap between separate same-day blocks is already unpaid.
      // Count it as qualifying rest only when >=15 minutes, never deduct twice.
      if(!previous.overnight&&!next.overnight&&next.start-previous.end>=15)
        gap+=next.start-previous.end;
    }
    const required=necessary(totalGross),qualifying=recognized+gap;
    return {valid:true,date,required,qualifying,entered:totalEntered,recognized,gaps:gap,
      missing:Math.max(0,required-qualifying),gross:totalGross,net:totalGross-totalEntered,
      shiftCount:shifts.length};
  }
  function suggestedPause(candidate,saved){
    if(!candidate||!candidate.date||!Number.isFinite(gross(candidate)))return null;
    const others=(saved||[]).filter(x=>x&&x.date===candidate.date&&x.id!==candidate.id);
    const newShift={...candidate,pause:0};
    const day=evaluateDay([...others,newShift],candidate.date);
    if(!day.valid)return null;
    return day.missing===0?0:Math.max(15,day.missing);
  }
  function issueForDay(day){
    if(!day.valid)return day.reason;
    if(day.missing>0){
      const parts=day.gaps>0?
        " ("+day.gaps+" Minuten zwischen den Einsätzen zählen bereits als freie Zeit und werden nicht doppelt abgezogen)":"";
      return "Für diesen Arbeitstag mit "+(day.gross/60).toLocaleString("de-DE",{maximumFractionDigits:2})+
        " Stunden erfasster Einsatzzeit sind mindestens "+day.required+
        " Minuten Pause erforderlich. Es fehlen noch "+day.missing+
        " Minuten gültige Pause. Bitte die tatsächlich genommenen Pausen eintragen"+
        parts+". Pausenabschnitte müssen mindestens 15 Minuten dauern.";
    }
    return "";
  }
  function errorsForMonth(shifts,month){
    const dates=[...new Set((shifts||[]).filter(x=>x&&x.date&&x.date.slice(0,7)===month).map(x=>x.date))].sort();
    const issues=[];
    for(const date of dates){
      const problem=issueForDay(evaluateDay(shifts,date));
      if(problem)issues.push({date,message:problem});
    }
    return issues;
  }
  window.UweBreakRules={gross,necessary,evaluateDay,suggestedPause,issueForDay,errorsForMonth};
})();
