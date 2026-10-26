const {test} = require('node:test');
const assert = require('node:assert/strict');
let api = {};
try { api = require('./engine.js'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
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
