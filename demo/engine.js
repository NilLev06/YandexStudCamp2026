(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SensorDemo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const CONFIG = Object.freeze({bucket:3, lateness:2, staleAfter:6, freshConfirm:3, freshAgeThreshold:2, k:0.35, h:7, clip:3, baselineSigma:4.5});
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
  class Monitor {
    constructor() {
      this.mode=null;this.s=0;this.recent=[];this.buckets=new Map();this.lastBucket=-1;this.seen=new Set();
      this.newest=null;this.lastReceipt=null;this.incidents=[];this.events=[];this.qualityIncident=null;this.availabilityIncident=null;
      this.freshRun=0;this.lateCount=0;this.accepted=0;this.z=0;this.aggregate=null;this.aggregateTime=null;
      this.badFlagCount=0;this.badBuckets=new Map();
    }
    open(type, now, reason) {
      const incident={type,start:now,end:null,reason};this.incidents.push(incident);
      this.events.push({time:now,kind:'open',type,text:reason});return incident;
    }
    close(incident, now, reason) {
      incident.end=now;this.events.push({time:now,kind:'close',type:incident.type,text:reason});
    }
    tick(now, incoming) {
      for(const m of incoming) {
        if(this.seen.has(m.id)) continue;
        this.seen.add(m.id);this.lastReceipt=now;this.accepted++;
        if(!valid(m)){const b=Math.floor(m.event_time/CONFIG.bucket);this.badBuckets.set(b,(this.badBuckets.get(b)||0)+1);this.badFlagCount++;continue;}
        this.newest=Math.max(this.newest??-Infinity,m.event_time);
        const bucket=Math.floor(m.event_time/CONFIG.bucket);
        if(now-m.event_time>CONFIG.lateness+CONFIG.bucket || bucket<=this.lastBucket) {this.lateCount++;continue;}
        if(!PROFILES[m.mode]) continue;
        if(this.mode!==m.mode) {
          if(this.mode!==null) this.events.push({time:now,kind:'mode',type:'info',text:'Режим '+this.mode+' → '+m.mode+'; применён отдельный эталон'});
          if(this.qualityIncident) {this.close(this.qualityIncident,now,'Оценка предыдущего режима завершена при переключении');this.qualityIncident=null;}
          this.mode=m.mode;this.s=0;this.recent=[];this.buckets.clear();this.badBuckets.clear();this.z=0;this.aggregate=null;this.aggregateTime=null;
        }
        if(!this.buckets.has(bucket)) this.buckets.set(bucket,[]);
        this.buckets.get(bucket).push(m.value);
      }
      const finalized=Math.floor((now-CONFIG.lateness)/CONFIG.bucket)-1;
      for(let b=this.lastBucket+1;b<=finalized;b++) {
        const values=this.buckets.get(b)||[];this.buckets.delete(b);
        if(values.length<2 || !this.mode) continue;
        const profile=PROFILES[this.mode];this.aggregate=median(values);this.aggregateTime=(b+1)*CONFIG.bucket-1;
        this.z=(profile.mean-this.aggregate)/profile.sigma;
        const badCount=this.badBuckets.get(b)||0;
        const totalCount=values.length+badCount;
        if(totalCount>=2 && badCount/totalCount>=0.5 && this.mode) {
          this.events.push({time:now,kind:'degraded_flags',type:'info',text:'Более 50% флагов в окне невалидны: '+badCount+'/'+totalCount});
        }
        this.badBuckets.delete(b);
        this.s=Math.max(0,this.s+Math.max(-CONFIG.clip,Math.min(CONFIG.clip,this.z))-CONFIG.k);
        this.recent.push(this.z);if(this.recent.length>5)this.recent.shift();
        if(!this.qualityIncident && this.s>=CONFIG.h && this.recent.slice(-3).filter(z=>z>0.8).length>=2) {
          this.qualityIncident=this.open('quality',now,'Устойчивое снижение качества: CUSUM ≥ 7 и подтверждение по последним окнам');
        }
        if(this.qualityIncident && this.recent.length===5 && this.recent.every(z=>Math.abs(z)<0.9)) {
          this.close(this.qualityIncident,now,'Пять последовательных окон вернулись в нормальный диапазон');this.qualityIncident=null;this.s=0;this.recent=[];this.aggregate=null;this.aggregateTime=null;
        }
      }
      this.lastBucket=Math.max(this.lastBucket,finalized);
      const age=this.newest===null?Infinity:now-this.newest;
      const stale=age===null || age>CONFIG.staleAfter;
      if(stale) {
        this.freshRun=0;
        if(!this.availabilityIncident && now>CONFIG.staleAfter) this.availabilityIncident=this.open('availability',now,'Нет пригодных свежих измерений более 6 секунд');
      } else if(this.availabilityIncident) {
        const hasFresh=incoming.some(m=>valid(m) && now-m.event_time<=CONFIG.freshAgeThreshold);
        this.freshRun=hasFresh?this.freshRun+1:0;
        if(this.freshRun>=CONFIG.freshConfirm) {this.close(this.availabilityIncident,now,'Получены три последовательных свежих измерения');this.availabilityIncident=null;this.freshRun=0;this.s=0;this.recent=[];}
      }
      const unavailable=this.aggregateTime===null || now-this.aggregateTime>CONFIG.bucket*2+CONFIG.lateness || stale || !!this.availabilityIncident;
      return {now,mode:this.mode||'—',s:this.s,z:this.z,aggregate:this.aggregate,aggregateTime:this.aggregateTime,
        quality:this.qualityIncident?'alarm':unavailable?'unknown':this.s>3?'suspect':'normal',
        availability:this.availabilityIncident?'stale':age===null?'unknown':'fresh',
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
    function score(incidents) {
      const matched=new Set(),delays=[];let falseAlarms=0,repeats=0;
      for(const i of incidents) {
        const j=result.truth.findIndex(t=>t.type===i.type && i.start>=t.start && i.start<t.end);
        if(j===-1)falseAlarms++;
        else if(matched.has(j))repeats++;
        else {matched.add(j);delays.push(i.start-result.truth[j].start);}
      }
      return {detected:matched.size,total:result.truth.length,falseAlarms,repeats,delay:delays.length?delays.reduce((a,b)=>a+b,0)/delays.length:null};
    }
    return {monitor:score(result.incidents),baseline:score(result.baseline)};
  }
  return {CONFIG,PROFILES,SCENARIOS,generate,Monitor,replay,evaluate};
});
