/*
 * UWE-Stunden PDF export – fully local, no external library or server.
 * PDF/WinAnsi (A4), normal employee and explicitly watermarked demo.
 */
(function () {
  "use strict";
  const W=595.28,H=841.89,M=40,WIDTH=W-2*M;
  const WIN1252={
    "€":128,"‚":130,"ƒ":131,"„":132,"…":133,"†":134,"‡":135,
    "ˆ":136,"‰":137,"Š":138,"‹":139,"Œ":140,"Ž":142,
    "‘":145,"’":146,"“":147,"”":148,"•":149,"–":150,
    "—":151,"˜":152,"™":153,"š":154,"›":155,"œ":156,"ž":158,"Ÿ":159
  };
  function latin(s) {
    let out="";
    for(const ch of String(s??"")) {
      const n=ch.codePointAt(0);
      if(n===10||n===13||n===9){out+=" ";continue;}
      const code=WIN1252[ch]??(n<=255?n:63);
      out+=String.fromCharCode(code);
    }
    return out;
  }
  function pdfStr(s) {
    return "("+latin(s).replace(/\\/g,"\\\\").replace(/\(/g,"\\(").replace(/\)/g,"\\)")+")";
  }
  function bytes(binary) {
    const out=new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++)out[i]=binary.charCodeAt(i)&255;
    return out;
  }
  function txt(x,y,s,size=10,bold=false,color="0.12 0.23 0.25") {
    return "BT "+color+" rg /F"+(bold?2:1)+" "+size+" Tf 1 0 0 1 "+x.toFixed(2)+" "+y.toFixed(2)+" Tm "+pdfStr(s)+" Tj ET\n";
  }
  function rect(x,y,w,h,color) {
    return color+" rg "+x+" "+y+" "+w+" "+h+" re f\n";
  }
  function line(x1,y1,x2,y2,c="0.82 0.87 0.87") {
    return c+" RG 0.7 w "+x1+" "+y1+" m "+x2+" "+y2+" l S\n";
  }
  function wrapWords(text,maxChars=48) {
    const words=String(text??"").replace(/\s+/g," ").trim().split(" ").filter(Boolean);
    if(!words.length)return [""];
    const result=[];
    let l="";
    for(let word of words) {
      if((l+" "+word).trim().length<=maxChars){l=l?(l+" "+word):word;continue;}
      if(l){result.push(l);l="";}
      while(word.length>maxChars){result.push(word.slice(0,maxChars));word=word.slice(maxChars);}
      l=word;
    }
    if(l)result.push(l);
    return result;
  }
  function hours(r) {
    const tm=t=>Number(t.slice(0,2))*60+Number(t.slice(3,5));
    let diff=tm(r.end)-tm(r.start);
    if(diff<0)diff+=1440;
    return (diff-Number(r.pause||0))/60;
  }
  function totalText(n) {return n.toFixed(2).replace(".",",");}
  function dateText(s) {return /^\d{4}-\d{2}-\d{2}$/.test(s)?s.slice(8,10)+"."+s.slice(5,7)+"."+s.slice(0,4):s;}
  function firstPageHeader(employee,month,test) {
    let s=rect(0,H-85,W,85,"0.03 0.50 0.54");
    s+=txt(M,H-44,"UWE  |  STUNDEN",22,true,"1 1 1");
    s+=txt(M,H-66,"KRANKENTRANSPORTE  -  Verantwortung, die bewegt.",9,false,"1 1 1");
    if(test) {
      s+=rect(M,H-123,WIDTH,27,"1 0.92 0.73");
      s+=txt(M+10,H-114,"TESTDATEN - NICHT FUER LOHNABRECHNUNG",13,true,"0.68 0.13 0.10");
    }
    s+=txt(M,H-(test?155:116),"STUNDENNACHWEIS",16,true);
    s+=txt(M,H-(test?178:139),"Mitarbeiter: "+employee.name,10,true);
    s+=txt(M,H-(test?195:156),"Personalnummer: "+employee.eid,9);
    s+=txt(M,H-(test?212:173),"Monat: "+month,9);
    s+=line(M,H-(test?225:186),W-M,H-(test?225:186));
    return s;
  }
  function createBlob({employee,month,records,test=false}){
    if(!employee||!employee.name||!employee.eid||!/^\d{4}-\d{2}$/.test(month)||!Array.isArray(records)||!records.length)
      throw new Error("Für diesen Monat sind keine gültigen Arbeitszeiten zum Export vorhanden.");
    const entries=records.slice().sort((a,b)=>String(a.date).localeCompare(String(b.date)));
    const widths=[77,58,58,58,59,205];
    const heads=["Datum","Beginn","Ende","Pause","Std.","Bemerkung"];
    const pages=[];
    let sections=[],y=0;
    function openPage(){
      sections=[];pages.push(sections);
      sections.push(firstPageHeader(employee,month,test));
      y=H-(test?251:212);
      sections.push(rect(M,y-4,WIDTH,23,"0.88 0.95 0.95"));
      let x=M+5;
      for(let j=0;j<heads.length;j++){sections.push(txt(x,y+4,heads[j],8,true));x+=widths[j];}
      y-=21;
    }
    openPage();
    let sum=0;
    for(const r of entries) {
      const hour=hours(r);
      if(!Number.isFinite(hour)||hour<=0||hour>24)throw Error("Ungültige Stundenangabe im Eintrag.");
      sum+=hour;
      const noteLines=wrapWords(r.note||"",47).slice(0,8);
      const height=Math.max(28,14+noteLines.length*11);
      if(y-height<124)openPage();
      let x=M+5;
      const cols=[dateText(r.date),r.start,r.end,String(r.pause)+" min",totalText(hour)];
      for(let j=0;j<cols.length;j++){sections.push(txt(x,y-14,cols[j],8.4));x+=widths[j];}
      for(let j=0;j<noteLines.length;j++)sections.push(txt(x,y-14-j*11,noteLines[j],8));
      sections.push(line(M,y-height,W-M,y-height));
      y-=height;
    }
    if(y<133)openPage();
    y-=24;
    sections.push(rect(M,y-8,WIDTH,35,"0.88 0.95 0.95"));
    sections.push(txt(M+12,y+4,"GESAMT: "+totalText(sum)+" Stunden",15,true,"0.03 0.45 0.49"));
    y-=57;
    sections.push(txt(M,y,"Unterschrift Mitarbeiter: ____________________________________",9));
    for(let p=0;p<pages.length;p++) {
      pages[p].push(line(M,62,W-M,62));
      pages[p].push(txt(M,46,"Erstellt: "+new Date().toLocaleDateString("de-DE"),8));
      pages[p].push(txt(W-116,46,"Seite "+(p+1)+" von "+pages.length,8));
      if(test)pages[p].push(txt(M,31,"TESTVERSION - kein offizieller Arbeitszeitnachweis",8,true,"0.64 0.13 0.10"));
    }
    const objects={};
    objects[1]="<< /Type /Catalog /Pages 2 0 R >>";
    objects[3]="<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    objects[4]="<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
    const pageRefs=[];
    let n=5;
    for(const p of pages) {
      const pg=n++,streamId=n++,body=p.join("");
      pageRefs.push(pg+" 0 R");
      objects[pg]="<< /Type /Page /Parent 2 0 R /MediaBox [0 0 "+W+" "+H+"] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents "+streamId+" 0 R >>";
      objects[streamId]="<< /Length "+bytes(body).length+" >>\nstream\n"+body+"\nendstream";
    }
    objects[2]="<< /Type /Pages /Kids ["+pageRefs.join(" ")+"] /Count "+pages.length+" >>";
    let output="%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
    const offsets=[0];
    for(let id=1;id<n;id++){
      offsets[id]=bytes(output).length;
      output+=id+" 0 obj\n"+objects[id]+"\nendobj\n";
    }
    const start=bytes(output).length;
    output+="xref\n0 "+n+"\n0000000000 65535 f \n";
    for(let id=1;id<n;id++)output+=String(offsets[id]).padStart(10,"0")+" 00000 n \n";
    output+="trailer\n<< /Size "+n+" /Root 1 0 R >>\nstartxref\n"+start+"\n%%EOF\n";
    return new Blob([bytes(output)],{type:"application/pdf"});
  }
  function fileFor(args){
    const clean=String(args.employee.eid).replace(/[^a-zA-Z0-9_-]/g,"");
    const filename="UWE-"+(args.test?"TEST-":"")+"Stundenzettel-"+clean+"-"+args.month+".pdf";
    return new File([createBlob(args)],filename,{type:"application/pdf"});
  }
  function download(file){
    const u=URL.createObjectURL(file),a=document.createElement("a");
    a.href=u;a.download=file.name;document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(u),5000);
  }
  window.UweTimesheetPdf={createBlob,fileFor,download};
})();
