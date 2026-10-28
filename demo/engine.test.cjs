const {test} = require('node:test');
const assert = require('node:assert/strict');
const api = require('./engine.js');
test('генератор и воспроизведение доступны', () => {
  assert.equal(typeof api.generate, 'function');
  assert.equal(typeof api.replay, 'function');
});
test('выброс не открывает инцидент качества', () => {
  assert.equal(api.replay('spike', 42).incidents.filter(x => x.type === 'quality').length, 0);
});
test('дрейф обнаруживается и инцидент закрывается после восстановления', () => {
  const r = api.replay('drift', 42);
  const i = r.incidents.find(x => x.type === 'quality');
  assert.ok(i); assert.ok(i.start >= 60 && i.start < 150); assert.ok(i.end > 150 && i.end < r.duration);
});
test('таймер обнаруживает тишину; старые сообщения не закрывают потерю свежести', () => {
  const r = api.replay('gap', 42);
  const delayed = r.frames[110];
  assert.equal(delayed.sinceReceipt, 0);
  assert.ok(delayed.age >= 15);
  assert.equal(delayed.availability, 'stale');
  const i = r.incidents.find(x => x.type === 'availability');
  assert.ok(i.start < 110); assert.ok(i.end >= 120);
});
test('известная смена режима не открывает инцидент качества', () => {
  assert.equal(api.replay('mode', 42).incidents.filter(x => x.type === 'quality').length, 0);
});
test('одинаковый seed воспроизводит поток', () => {
  assert.deepEqual(api.generate('combined', 13), api.generate('combined', 13));
  assert.notDeepEqual(api.generate('combined', 13).messages, api.generate('combined', 14).messages);
});
test('метрики сопоставляют инциденты с разметкой отдельно от детектора', () => {
  const r = api.replay('drift', 42);
  const e = api.evaluate(r);
  assert.equal(e.monitor.detected, 1); assert.equal(e.monitor.total, 1); assert.equal(e.monitor.falseAlarms, 0);
});
test('входная разметка не нужна монитору', () => {
  const m = new api.Monitor();
  for (let t = 0; t <= 20; t++) m.tick(t, [{event_time:t, received_at:t, value:95, mode:'A', id:t}]);
  assert.equal(m.incidents.length, 0);
  const state = m.tick(40, []); assert.equal(state.availability, 'stale');
});
test('нет оценки до первого окна, в пропуске и до свежего окна после разрыва', () => {
  const r=api.replay('gap',42);
  assert.equal(r.frames[0].quality,'unknown');
  assert.equal(r.frames[66].quality,'unknown');
  assert.equal(r.frames[122].availability,'fresh');
  assert.equal(r.frames[122].quality,'unknown');
  assert.equal(r.frames[125].quality,'normal');
});
test('без единого измерения открывается инцидент доступности', () => {
  const m = new api.Monitor();
  for(let t=0;t<=10;t++) m.tick(t,[]);
  const last=m.tick(15,[]);
  assert.equal(last.availability,'stale');
  const avail=m.incidents.find(x=>x.type==='availability');
  assert.ok(avail,'Монитор должен открыть инцидент при отсутствии измерений');
  assert.ok(avail.start>=6,'Инцидент должен открыться после staleAfter=6');
});
const feed = (m, from, to, make) => { let last; for (let t = from; t <= to; t++) last = m.tick(t, make(t) ? [make(t)] : []); return last; };
const msg = (t, extra = {}) => ({id:t, event_time:t, received_at:t, value:95, mode:'A', quality_flags:'valid', ...extra});
test('баг 1: доля невалидных флагов открывает и закрывает инцидент даже без валидных значений в окне', () => {
  for (const bad of [t => t % 3 !== 0, () => true]) {
    const m = new api.Monitor();
    feed(m, 0, 99, t => msg(t));
    feed(m, 100, 160, t => msg(t, {quality_flags: bad(t) ? 'saturated' : 'valid'}));
    const flags = m.incidents.find(x => x.type === 'flags');
    assert.ok(flags && flags.start >= 100 && flags.start < 110);
    feed(m, 161, 200, t => msg(t));
    assert.ok(flags.end > 160);
  }
  const m = new api.Monitor();
  feed(m, 0, 30, t => msg(t, {quality_flags: t >= 10 ? 'saturated' : 'valid'}));
  assert.match(m.incidents.find(x => x.type === 'availability').reason, /невалидными/);
});
test('баг 2: до первого измерения доступность неизвестна, возраст не определён', () => {
  const m = new api.Monitor();
  for (let t = 0; t <= 5; t++) { const f = m.tick(t, []); assert.equal(f.availability, 'unknown'); assert.equal(f.age, null); }
  assert.equal(m.tick(7, []).availability, 'stale');
});
test('баг 3: деградация, продолжающаяся через смену режима, остаётся одним инцидентом', () => {
  const m = new api.Monitor();
  feed(m, 0, 300, t => msg(t, {mode: t >= 150 ? 'B' : 'A', value: (t >= 150 ? 80 : 95) - (t >= 60 ? 12 : 0)}));
  const q = m.incidents.filter(x => x.type === 'quality');
  assert.equal(q.length, 1); assert.equal(q[0].end, null);
  assert.match(m.events.find(e => e.kind === 'mode').text, /остаётся открытым/);
});
test('баг 4: частая смена режима не отключает детектор и не засоряет журнал', () => {
  const m = new api.Monitor();
  feed(m, 0, 300, t => msg(t, {mode: t % 2 ? 'B' : 'A', value: (t % 2 ? 80 : 95) - (t >= 100 ? 12 : 0)}));
  assert.equal(m.incidents.filter(x => x.type === 'quality').length, 1);
  assert.ok(m.events.filter(e => e.kind === 'mode').length <= 11);
});
test('баг 5: неизвестный режим явно отмечается, качество не оценивается', () => {
  const m = new api.Monitor();
  feed(m, 0, 30, t => msg(t));
  const f = feed(m, 31, 60, t => msg(t, {mode:'C', value:50}));
  assert.equal(f.modeKnown, false); assert.equal(f.quality, 'unknown'); assert.equal(f.availability, 'fresh');
  assert.ok(m.events.some(e => e.kind === 'unknown_mode'));
  assert.equal(m.incidents.length, 0);
});
test('баг 6: z медианы стандартизован по числу значений в окне', () => {
  const m = new api.Monitor(), sigma = api.PROFILES.A.sigma;
  feed(m, 0, 20, t => msg(t, {value: 95 - sigma}));
  assert.ok(Math.abs(m.z - 1 / api.medianSd(3)) < 1e-9);
  assert.ok(Math.abs(api.medianSd(3) - 0.6702) < 1e-3);
});
test('баг 7: память удаления дублей ограничена окном, дубли в окне отбрасываются', () => {
  const m = new api.Monitor();
  feed(m, 0, 20000, t => msg(t));
  assert.ok(m.seen.size <= api.CONFIG.dedupWindow / api.CONFIG.bucket + 2);
  const before = m.accepted; m.tick(20001, [msg(19995), msg(20001)]);
  assert.equal(m.accepted, before + 1);
});
test('баг 8: оценка учитывает задержку закрытия, незакрытые инциденты и допуск на начало', () => {
  const result = {duration:100, truth:[{start:10, end:40, type:'quality'}, {start:60, end:80, type:'quality'}], incidents:[], baseline:[]};
  result.incidents = [{type:'quality', start:8, end:45}, {type:'quality', start:70, end:null}];
  const e = api.evaluate(result).monitor;
  assert.equal(e.detected, 2); assert.equal(e.falseAlarms, 0); assert.equal(e.delay, 5);
  assert.equal(e.closeDelay, 5); assert.equal(e.unclosed, 1);
});
test('монитор работает со временем Unix без перебора пустых окон', () => {
  const m = new api.Monitor(), t0 = 1761600000;
  let f; for (let t = 0; t < 30; t++) f = m.tick(t0 + t, [msg(t0 + t)]);
  assert.equal(f.quality, 'normal'); assert.equal(f.availability, 'fresh');
});
