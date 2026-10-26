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
  function monthText(s) {return /^\d{4}-\d{2}$/.test(s)?s.slice(5,7)+"-"+s.slice(0,4):s;}

  // Original UWE logo and wing shapes, traced from the supplied brand artwork.
  const LOGO_TURQUOISE="606 195 m 527 209 l 438 231 l 337 261 l 238 296 l 161 329 l 101 360 l 46 395 l 1 433 l 112 402 l 214 382 l 342 362 l 390 350 l 422 339 l 467 318 l 522 281 l 573 235 l h 749 1 m 682 17 l 587 47 l 515 75 l 432 113 l 357 153 l 286 196 l 214 246 l 139 307 l 258 262 l 376 224 l 481 196 l 632 164 l 693 88 l h\n";
  const LOGO_BLACK="1755 366 m 1755 433 l 1803 433 l 1803 425 l 1765 424 l 1766 403 l 1799 403 l 1798 395 l 1766 395 l 1765 376 l 1803 375 l 1804 366 l h 1687 366 m 1687 375 l 1712 376 l 1712 433 l 1721 433 l 1721 376 l 1745 375 l 1745 366 l h 1625 366 m 1625 433 l 1635 433 l 1636 408 l 1652 408 l 1669 433 l 1680 433 l 1663 408 l 1675 400 l 1679 391 l 1679 383 l 1674 373 l 1662 366 l h 1635 376 m 1661 375 l 1669 383 l 1669 392 l 1661 399 l 1636 400 l h 1520 367 m 1481 366 l 1481 433 l 1491 433 l 1492 411 l 1519 410 l 1531 401 l 1534 394 l 1534 384 l 1531 376 l h 1491 376 m 1518 376 l 1525 386 l 1523 396 l 1515 402 l 1492 402 l h 1343 366 m 1343 433 l 1353 433 l 1354 385 l 1390 432 l 1400 433 l 1400 366 l 1390 366 l 1389 415 l 1352 366 l h 1294 366 m 1267 433 l 1278 433 l 1285 417 l 1316 417 l 1323 433 l 1333 433 l 1307 366 l h 1301 376 m 1313 407 l 1289 408 l 1288 405 l h 1206 366 m 1206 433 l 1216 433 l 1217 408 l 1233 408 l 1250 433 l 1261 433 l 1244 408 l 1252 404 l 1259 394 l 1260 384 l 1255 373 l 1242 366 l h 1216 376 m 1242 375 l 1250 382 l 1250 392 l 1242 399 l 1217 400 l 1215 398 l h 1138 366 m 1138 375 l 1162 376 l 1162 433 l 1172 433 l 1172 376 l 1196 375 l 1196 366 l h 1071 366 m 1071 433 l 1081 433 l 1082 385 l 1118 432 l 1128 433 l 1128 366 l 1118 366 l 1117 415 l 1080 366 l h 1010 366 m 1010 433 l 1058 433 l 1058 425 l 1019 424 l 1020 403 l 1053 403 l 1053 395 l 1020 395 l 1019 376 l 1058 375 l 1058 366 l h 941 366 m 941 433 l 951 433 l 951 416 l 963 403 l 987 433 l 999 433 l 970 397 l 997 366 l 984 366 l 952 402 l 951 366 l h 869 366 m 869 433 l 879 433 l 880 384 l 916 432 l 926 433 l 926 366 l 916 366 l 915 415 l 878 366 l h 820 366 m 794 433 l 804 433 l 811 417 l 843 417 l 849 433 l 860 433 l 833 366 l h 827 376 m 839 407 l 815 408 l 815 403 l h 732 366 m 732 433 l 742 433 l 743 408 l 759 408 l 776 433 l 787 433 l 770 408 l 782 400 l 786 391 l 786 383 l 781 373 l 769 366 l h 742 376 m 768 375 l 776 382 l 776 392 l 768 399 l 743 400 l h 664 366 m 664 433 l 673 433 l 673 417 l 685 403 l 709 433 l 721 433 l 692 396 l 719 366 l 707 366 l 674 402 l 673 366 l h 1571 365 m 1561 368 l 1549 378 l 1543 390 l 1542 404 l 1545 415 l 1553 426 l 1568 434 l 1581 435 l 1596 430 l 1606 421 l 1612 408 l 1612 392 l 1605 377 l 1597 370 l 1584 365 l h 1571 374 m 1589 376 l 1598 384 l 1602 392 l 1602 408 l 1598 416 l 1586 425 l 1573 426 l 1563 422 l 1555 413 l 1552 405 l 1552 394 l 1555 386 l 1561 379 l h 1428 366 m 1416 376 l 1416 390 l 1423 397 l 1453 407 l 1458 413 l 1458 418 l 1448 426 l 1436 426 l 1428 422 l 1420 412 l 1411 415 l 1417 425 l 1429 433 l 1438 435 l 1454 433 l 1461 429 l 1467 421 l 1468 411 l 1466 406 l 1455 398 l 1428 389 l 1425 386 l 1425 380 l 1432 374 l 1442 373 l 1450 376 l 1457 384 l 1466 381 l 1452 367 l 1445 365 l h 1480 0 m 1479 277 l 1683 277 l 1683 227 l 1539 227 l 1537 225 l 1537 164 l 1539 160 l 1663 160 l 1663 111 l 1539 111 l 1537 109 l 1538 51 l 1680 50 l 1680 1 l h 1051 1 m 1134 275 l 1196 274 l 1250 86 l 1305 275 l 1368 275 l 1449 1 l 1390 1 l 1336 198 l 1279 0 l 1224 1 l 1167 196 l 1113 0 l h 785 0 m 785 182 l 791 212 l 806 239 l 820 253 l 841 266 l 863 273 l 892 277 l 920 276 l 940 272 l 959 265 l 978 253 l 999 229 l 1012 193 l 1014 1 l 957 0 l 957 175 l 955 186 l 947 203 l 931 218 l 912 225 l 893 226 l 876 222 l 863 215 l 848 198 l 843 184 l 842 1 l h\n";
  const UWE_WING="505 163 m 433 176 l 354 196 l 287 216 l 196 248 l 131 276 l 83 301 l 32 334 l 1 361 l 104 333 l 177 319 l 271 305 l 315 295 l 349 284 l 388 266 l 429 239 l 456 217 l 487 186 l h 624 1 m 577 12 l 493 38 l 426 64 l 349 100 l 285 135 l 224 173 l 164 216 l 116 256 l 219 217 l 313 187 l 416 160 l 525 138 l 581 69 l h\n";
  function drawOriginalLogo(x,top,width){
    const scale=width/1805;
    return "q "+scale+" 0 0 -"+scale+" "+x+" "+top+" cm\n"+
      "0.000 0.663 0.620 rg\n"+LOGO_TURQUOISE+"f*\n"+
      "0 0 0 rg\n"+LOGO_BLACK+"f*\nQ\n";
  }
  function drawWingWatermark(){
    const scale=0.74;
    const x=(W-627*scale)/2;
    const top=(H+363*scale)/2;
    return "q /GSWatermark gs "+scale+" 0 0 -"+scale+" "+x.toFixed(2)+" "+top.toFixed(2)+" cm\n"+
      "0.000 0.663 0.620 rg\n"+UWE_WING+"f*\nQ\n";
  }
  function firstPageHeader(employee,month,test) {
    let s=drawWingWatermark();
    s+=drawOriginalLogo(M,H-15,250);
    s+=txt(W-171,H-45,"STUNDEN",19,true,"0.03 0.50 0.54");
    s+=txt(W-169,H-62,"Arbeitszeitnachweis",9,false,"0.12 0.35 0.37");
    s+=rect(M,H-86,WIDTH,2,"0.000 0.663 0.620");
    if(test) {
      s+=rect(M,H-123,WIDTH,27,"1 0.92 0.73");
      s+=txt(M+10,H-114,"TESTDATEN - NICHT FUER LOHNABRECHNUNG",13,true,"0.68 0.13 0.10");
    }
    s+=txt(M,H-(test?155:116),"STUNDENNACHWEIS",16,true);
    s+=txt(M,H-(test?178:139),"Mitarbeiter: "+employee.name,10,true);
    s+=txt(M,H-(test?195:156),"Personalnummer: "+employee.eid,9);
    s+=txt(M,H-(test?212:173),"Monat: "+monthText(month),9);
    s+=line(M,H-(test?225:186),W-M,H-(test?225:186));
    return s;
  }
  function createBlob({employee,month,records,test=false,account=null}){
    if(!employee||!employee.name||!employee.eid||!/^\d{4}-\d{2}$/.test(month)||!Array.isArray(records)||!records.length)
      throw new Error("Für diesen Monat sind keine gültigen Arbeitszeiten zum Export vorhanden.");
    const entries=records.slice().sort((a,b)=>String(a.date).localeCompare(String(b.date))||String(a.start).localeCompare(String(b.start))||String(a.end).localeCompare(String(b.end)));

    // Optional, explicitly test-only account figures: never replace the actual worked hours.
    let acc=null;
    if(account&&account.test===true&&month>="2026-11"){
      const fields=["workedMinutes","eligibleMinutes","allocatedMinutes","billingMinutes","balanceMinutes","initialMinutes"];
      if(fields.some(key=>!Number.isSafeInteger(account[key]))||
         account.initialMinutes!==-6000||
         account.allocatedMinutes<0||
         account.billingMinutes<0||
         account.billingMinutes+account.allocatedMinutes!==account.workedMinutes||
         account.allocatedMinutes>account.eligibleMinutes||
         account.eligibleMinutes>account.workedMinutes||
         !/^20\d{2}\/\d{2}$/.test(account.schoolYear||"")||
         !/^20\d{2}-\d{2}-\d{2}$/.test(account.schoolStart||"")||
         !/^20\d{2}-\d{2}-\d{2}$/.test(account.schoolEnd||"")||
         !/^20\d{2}-\d{2}-\d{2}$/.test(account.summerStart||"")||
         account.schoolStart>account.schoolEnd||account.schoolEnd>=account.summerStart)
        throw new Error("Arbeitszeitkonto kann nicht korrekt in die PDF übernommen werden.");
      acc=account;
    }

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
    if(acc&&Math.abs(Math.round(sum*60)-acc.workedMinutes)>1)
      throw new Error("Die Monatsstunden im Arbeitszeitkonto stimmen nicht mit dem Stundennachweis überein.");
    if(y<(acc?225:133))openPage();
    y-=24;
    if(acc){
      // Work shifts stay in the original readable full-width table; yearly
      // balance appears only in a separate labeled TEST section.
      sections.push(rect(M,y-100,WIDTH,127,"0.88 0.95 0.95"));
      sections.push(txt(M+12,y+5,"GESAMT GELEISTET: "+totalText(sum)+" Stunden",14,true,"0.03 0.45 0.49"));
      sections.push(txt(M+12,y-16,"ARBEITSZEITKONTO - TEST | Schuljahr "+acc.schoolYear,9,true,"0.14 0.36 0.38"));
      sections.push(txt(M+12,y-34,"Ins Konto: "+totalText(acc.allocatedMinutes/60)+" Std.   |   Zur Abrechnung vorgemerkt: "+
        totalText(acc.billingMinutes/60)+" Std.",9,false,"0.12 0.23 0.25"));
      sections.push(txt(M+12,y-51,"Anrechenbare Schulzeit in diesem Monat: "+
        totalText(acc.eligibleMinutes/60)+" Std.",9,false,"0.12 0.23 0.25"));
      sections.push(txt(M+12,y-67,"Jahresstand nach diesem Monat: "+
        totalText(acc.balanceMinutes/60)+" Std.   |   Start je Schuljahr: -100,00 Std.",8.7,false,"0.12 0.23 0.25"));
      sections.push(txt(M+12,y-84,"Letzter Schultag: "+dateText(acc.schoolEnd)+
        "   |   NRW-Sommerferien ab "+dateText(acc.summerStart),8,false,"0.24 0.33 0.35"));
      sections.push(txt(M+12,y-95,"Neues Schuljahr: erneut -100 Std. | Vorjahr bleibt dokumentiert | Keine verbindliche Lohnverrechnung.",7,false,"0.35 0.36 0.36"));
    }else{
      sections.push(rect(M,y-8,WIDTH,35,"0.88 0.95 0.95"));
      sections.push(txt(M+12,y+4,"GESAMT: "+totalText(sum)+" Stunden",15,true,"0.03 0.45 0.49"));
    }
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
    objects[5]="<< /Type /ExtGState /ca 0.085 /CA 0.085 >>";
    const pageRefs=[];
    let n=6;
    for(const p of pages) {
      const pg=n++,streamId=n++,body=p.join("");
      pageRefs.push(pg+" 0 R");
      objects[pg]="<< /Type /Page /Parent 2 0 R /MediaBox [0 0 "+W+" "+H+"] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /ExtGState << /GSWatermark 5 0 R >> >> /Contents "+streamId+" 0 R >>";
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
