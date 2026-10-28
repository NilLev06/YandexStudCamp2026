(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SensorDemo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const CONFIG = Object.freeze({bucket:3, lateness:2, staleAfter:6, freshConfirm:3, freshAgeThreshold:2, k:0.5, h:10, clip:4.5, suspect:4.5, confirmZ:1.2, recoverZ:1.35,
    badFlagShare:0.5, flagsRecover:3, dedupWindow:120, modeLogEvery:30, maxLog:10000, matchTolerance:3, baselineSigma:4.5});
  const PROFILES = {A:{mean:95, sigma:1.5}, B:{mean:80, sigma:1.5}};
  const valid = m => Number.isFinite(m.value) && (m.quality_flags === undefined || m.quality_flags === 'valid');
  const SCENARIOS = {
    combined:{name:'Полная демонстрация', duration:390, description:'Выброс → плавная деградация → восстановление → пропуск и старые сообщения → смена режима.'},
    spike:{name:'Одиночный выброс', duration:120, description:'Одно измерение резко падает. Устойчивую неисправность объявлять не нужно.'},
    drift:{name:'Плавная деградация', duration:220, description:'Качество плавно падает и затем восстанавливается. Сравниваем момент обнаружения.'},
    gap:{name:'Пропуск и поздняя пачка', duration:160, description:'Поток прерывается, затем приходят старые измерения. Свежие данные появляются позже.'},
    mode:{name:'Допустимая смена режима', duration:150, description:'Режим A сменяется режимом B. Ожидаемый уровень меняется с 95 на 80.'}
  };
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a += 0x6D2B79F5; let t = Math.imul(a ^ a >>> 15, 1 | a); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  const median = values => {const a=[...values].sort((x,y)=>x-y); return a.length % 2 ? a[(a.length-1)/2] : (a[a.length/2-1]+a[a.length/2])/2;};
  function generate(scenario='combined', seed=42) {
    if (!SCENARIOS[scenario]) throw new Error('Неизвестный сценарий');
    const random=rng(seed), cfg=SCENARIOS[scenario], messages=[], truth=[], annotations=[];
    const normal=()=>Math.sqrt(-2*Math.log(Math.max(random(),1e-9)))*Math.cos(2*Math.PI*random());
    const full=scenario==='combined';
    const driftStart=full?100:60, driftHold=full?160:110, recovery=full?180:150, driftEnd=recovery+20;
    const gapStart=full?240:60, batchTime=full?290:110, freshTime=full?300:120;
    if(full || scenario==='spike') annotations.push({start:60,end:61,label:'Выброс',kind:'spike'});
    if(full || scenario==='drift') {truth.push({start:driftStart,end:driftEnd,type:'quality',label:'Деградация'}); annotations.push({start:driftStart,end:driftEnd,label:'Деградация',kind:'quality'});}
    if(full || scenario==='gap') {truth.push({start:gapStart,end:freshTime,type:'availability',label:'Нет свежих данных'});annotations.push({start:gapStart,end:freshTime,label:'Нет свежих данных',kind:'availability'});annotations.push({start:batchTime,end:batchTime+1,label:'Старая пачка',kind:'batch'});}
    const modeTime=full?340:60;
    if(full || scenario==='mode') annotations.push({start:modeTime,end:cfg.duration,label:'Режим B',kind:'mode'});
    for(let t=0;t<=cfg.duration;t++) {
      const mode=(full || scenario==='mode') && t>=modeTime?'B':'A';
      let value=PROFILES[mode].mean+1.5*normal();
      if((full || scenario==='spike') && t===60) value=40;
      if(full || scenario==='drift') {
        if(t>=driftStart && t<recovery) value-=12*Math.min(1,(t-driftStart)/(driftHold-driftStart));
        if(t>=recovery && t<driftEnd) value-=12*(1-(t-recovery)/20);
      }
      let received=t;
      if((full || scenario==='gap') && t>=gapStart && t<freshTime) {
        if(t<batchTime-15) received=batchTime+(random()*0.5-0.25);
        else continue;
      }
      messages.push({id:t,sensor_id:'camera-01',event_time:t,received_at:received,value:Number(value.toFixed(3)),mode,quality_flags:'valid'});
    }
    messages.sort((a,b)=>a.received_at-b.received_at || a.event_time-b.event_time);
    return {scenario,seed,duration:cfg.duration,messages,truth,annotations};
  }
  const MEDIAN_SD=[1,1,0.7071,0.6702,0.5467,0.5352,0.4635,0.4588,0.4107];
  const medianSd = n => MEDIAN_SD[n] ?? Math.sqrt(Math.PI/(2*n));
  class Monitor {
    constructor() {
      this.mode=null;this.s=0;this.recent=[];this.buckets=new Map();this.lastBucket=-1;this.seen=new Map();
      this.newest=null;this.lastReceipt=null;this.incidents=[];this.events=[];this.qualityIncident=null;this.availabilityIncident=null;
      this.freshRun=0;this.lateCount=0;this.accepted=0;this.z=0;this.aggregate=null;this.aggregateTime=null;
      this.badFlagCount=0;this.badBuckets=new Map();this.lastBad=null;this.flagsIncident=null;this.flagsOkRun=0;
      this.lastModeLog=-Infinity;this.pendingSwitches=0;
    }
    log(list, item) {list.push(item);if(list.length>CONFIG.maxLog)list.shift();}
    open(type, now, reason) {
      const incident={type,start:now,end:null,reason};this.log(this.incidents,incident);
      this.log(this.events,{time:now,kind:'open',type,text:reason});return incident;
    }
    close(incident, now, reason) {
      incident.end=now;this.log(this.events,{time:now,kind:'close',type:incident.type,text:reason});
    }
    duplicate(m, now) {
      const horizon=Math.floor((now-CONFIG.dedupWindow)/CONFIG.bucket), b=Math.floor(m.event_time/CONFIG.bucket), key=m.id??m.event_time;
      if(b<horizon) return false;
      let ids=this.seen.get(b);
      if(ids?.has(key)) return true;
      if(!ids) this.seen.set(b,ids=new Set());
      ids.add(key);return false;
    }
    switchMode(mode, now) {
      const from=this.mode;this.mode=mode;
      if(!PROFILES[mode]) {this.log(this.events,{time:now,kind:'unknown_mode',type:'info',text:'Режим '+mode+' не описан: эталона нет, качество не оценивается'});return;}
      if(from===null) return;
      if(!PROFILES[from]) {this.log(this.events,{time:now,kind:'mode',type:'info',text:'Режим '+from+' → '+mode+'; оценка качества возобновлена'});return;}
      if(now-this.lastModeLog<CONFIG.modeLogEvery) {this.pendingSwitches++;return;}
      const extra=this.pendingSwitches?' (ещё '+this.pendingSwitches+' переключений с прошлой записи)':'';
      const keep=this.qualityIncident?'; инцидент качества остаётся открытым, восстановление проверяется по эталону '+mode:'';
      this.log(this.events,{time:now,kind:'mode',type:'info',text:'Режим '+from+' → '+mode+'; применён отдельный эталон'+keep+extra});
      this.lastModeLog=now;this.pendingSwitches=0;
    }
    tick(now, incoming) {
      for(const m of incoming) {
        if(this.duplicate(m,now)) continue;
        this.lastReceipt=now;this.accepted++;
        const ok=valid(m), bucket=Math.floor(m.event_time/CONFIG.bucket);
        if(ok) this.newest=Math.max(this.newest??-Infinity,m.event_time);
        if(now-m.event_time>CONFIG.lateness+CONFIG.bucket || bucket<=this.lastBucket) {this.lateCount++;continue;}
        if(!ok) {this.badBuckets.set(bucket,(this.badBuckets.get(bucket)||0)+1);this.badFlagCount++;this.lastBad=now;continue;}
        if(this.mode!==m.mode) this.switchMode(m.mode,now);
        const profile=PROFILES[m.mode];
        if(!profile) continue;
        if(!this.buckets.has(bucket)) this.buckets.set(bucket,{r:[],mode:m.mode});
        const slot=this.buckets.get(bucket);slot.r.push((profile.mean-m.value)/profile.sigma);slot.mode=m.mode;
      }
      const finalized=Math.floor((now-CONFIG.lateness)/CONFIG.bucket)-1;
      const due=[...new Set([...this.buckets.keys(),...this.badBuckets.keys()])].filter(b=>b>this.lastBucket&&b<=finalized).sort((a,b)=>a-b);
      for(const b of due) {
        const values=this.buckets.get(b)?.r||[], slotMode=this.buckets.get(b)?.mode, badCount=this.badBuckets.get(b)||0, totalCount=values.length+badCount;
        this.buckets.delete(b);this.badBuckets.delete(b);
        if(totalCount>=2) {
          const share=badCount/totalCount;
          if(share>=CONFIG.badFlagShare) {
            this.flagsOkRun=0;
            if(!this.flagsIncident) this.flagsIncident=this.open('flags',now,'Доля невалидных измерений в окне '+badCount+'/'+totalCount+' (порог '+Math.round(CONFIG.badFlagShare*100)+'%)');
          } else if(this.flagsIncident && ++this.flagsOkRun>=CONFIG.flagsRecover) {
            this.close(this.flagsIncident,now,'Доля невалидных измерений ниже порога в '+CONFIG.flagsRecover+' окнах подряд');this.flagsIncident=null;this.flagsOkRun=0;
          }
        }
        if(values.length<2) continue;
        const zMedian=median(values), profile=PROFILES[slotMode];
        this.aggregate=profile.mean-zMedian*profile.sigma;this.aggregateTime=(b+1)*CONFIG.bucket-1;
        this.z=zMedian/medianSd(values.length);
        this.s=Math.max(0,this.s+Math.max(-CONFIG.clip,Math.min(CONFIG.clip,this.z))-CONFIG.k);
        this.recent.push(this.z);if(this.recent.length>5)this.recent.shift();
        if(!this.qualityIncident && this.s>=CONFIG.h && this.recent.slice(-3).filter(z=>z>CONFIG.confirmZ).length>=2) {
          this.qualityIncident=this.open('quality',now,'Устойчивое снижение качества: CUSUM ≥ '+CONFIG.h+' и подтверждение по последним окнам');
        }
        if(this.qualityIncident && this.recent.length===5 && this.recent.every(z=>Math.abs(z)<CONFIG.recoverZ)) {
          this.close(this.qualityIncident,now,'Пять последовательных окон вернулись в нормальный диапазон');this.qualityIncident=null;this.s=0;this.recent=[];this.aggregate=null;this.aggregateTime=null;
        }
      }
      this.lastBucket=Math.max(this.lastBucket,finalized);
      const horizon=Math.floor((now-CONFIG.dedupWindow)/CONFIG.bucket);
      for(const b of this.seen.keys()) if(b<horizon) this.seen.delete(b);
      for(const b of this.badBuckets.keys()) if(b<=this.lastBucket) this.badBuckets.delete(b);
      const age=this.newest===null?null:now-this.newest;
      const stale=age===null || age>CONFIG.staleAfter;
      if(stale) {
        this.freshRun=0;
        if(!this.availabilityIncident && now>CONFIG.staleAfter) {
          const flagged=this.lastBad!==null && now-this.lastBad<=CONFIG.staleAfter;
          this.availabilityIncident=this.open('availability',now,flagged?'Измерения поступают, но более '+CONFIG.staleAfter+' секунд помечены невалидными':'Нет пригодных свежих измерений более '+CONFIG.staleAfter+' секунд');
        }
      } else if(this.availabilityIncident) {
        const hasFresh=incoming.some(m=>valid(m) && now-m.event_time<=CONFIG.freshAgeThreshold);
        this.freshRun=hasFresh?this.freshRun+1:0;
        if(this.freshRun>=CONFIG.freshConfirm) {this.close(this.availabilityIncident,now,'Получены три последовательных свежих измерения');this.availabilityIncident=null;this.freshRun=0;this.s=0;this.recent=[];}
      }
      const unavailable=this.aggregateTime===null || now-this.aggregateTime>CONFIG.bucket*2+CONFIG.lateness || stale || !!this.availabilityIncident;
      return {now,mode:this.mode||'—',modeKnown:!!PROFILES[this.mode],s:this.s,z:this.z,aggregate:this.aggregate,aggregateTime:this.aggregateTime,
        quality:this.qualityIncident?'alarm':unavailable?'unknown':this.s>CONFIG.suspect?'suspect':'normal',
        availability:this.availabilityIncident?'stale':age===null?'unknown':stale?'stale':'fresh',
        flags:this.flagsIncident?'degraded':'ok',
        age,sinceReceipt:this.lastReceipt===null?null:now-this.lastReceipt,
        lateCount:this.lateCount,accepted:this.accepted,events:this.events.length};
    }
  }
  function replay(scenario='combined',seed=42) {
    const data=generate(scenario,seed), monitor=new Monitor(),frames=[],baseline=[];
    let p=0,active=null;
    for(let now=0;now<=data.duration;now++) {
      const incoming=[];while(p<data.messages.length && data.messages[p].received_at<=now)incoming.push(data.messages[p++]);
      frames.push(monitor.tick(now,incoming));
      const fresh=incoming.filter(m=>now-m.event_time<=CONFIG.bucket+CONFIG.lateness);
      if(fresh.length) {
        const m=fresh[fresh.length-1], profile=PROFILES[m.mode];
        if(m.value<profile.mean-CONFIG.baselineSigma*profile.sigma) {
          if(!active) {active={type:'quality',start:now,end:null,reason:'Порог: значение ниже нормы на 4,5σ'};baseline.push(active);}
        } else if(active) {active.end=now;active=null;}
      }
    }
    baseline.push(...monitor.incidents.filter(i=>i.type==='availability').map(i=>({...i})));
    return {...data,frames,incidents:monitor.incidents,events:monitor.events,baseline};
  }
  function evaluate(result) {
    const scored=new Set(['quality','availability']);
    function score(incidents) {
      const matched=new Map(),delays=[],closeDelays=[];let falseAlarms=0,repeats=0,unclosed=0;
      for(const i of incidents.filter(i=>scored.has(i.type))) {
        const j=result.truth.findIndex(t=>t.type===i.type && i.start>=t.start-CONFIG.matchTolerance && i.start<t.end);
        if(j===-1) {falseAlarms++;if(i.end===null)unclosed++;}
        else if(matched.has(j)) {repeats++;if(i.end===null && result.truth[j].end<result.duration)unclosed++;}
        else {matched.set(j,i);delays.push(Math.max(0,i.start-result.truth[j].start));}
      }
      for(const [j,i] of matched) {
        const t=result.truth[j];
        if(i.end!==null) closeDelays.push(i.end-t.end);
        else if(t.end<result.duration) unclosed++;
      }
      const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
      return {detected:matched.size,total:result.truth.length,falseAlarms,repeats,unclosed,
        delay:mean(delays),closeDelay:mean(closeDelays),closed:closeDelays.length};
    }
    return {monitor:score(result.incidents),baseline:score(result.baseline)};
  }
  return {CONFIG,PROFILES,SCENARIOS,generate,Monitor,replay,evaluate,medianSd};
});
