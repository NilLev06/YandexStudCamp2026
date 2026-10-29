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

const SCENARIO_IDS = Object.keys(api.SCENARIOS);
const runs = new Map();
const run = (scenario, seed) => {
  const key = scenario + ':' + seed;
  if (!runs.has(key)) { const r = api.replay(scenario, seed); runs.set(key, {r, e: api.evaluate(r).monitor, peak: Math.max(...r.frames.map(f => f.s))}); }
  return runs.get(key);
};
const quality = r => r.incidents.filter(i => i.type === 'quality');
const availability = r => r.incidents.filter(i => i.type === 'availability');

test('граница seed: принимаются только целые 1…999999', () => {
  for (const seed of [api.SEED.min, 2, 42, api.SEED.max]) assert.doesNotThrow(() => api.generate('spike', seed), String(seed));
  for (const seed of [0, -1, api.SEED.max + 1, 1.5, NaN, Infinity, '42', null]) assert.throws(() => api.generate('spike', seed), RangeError, String(seed));
});

const INVARIANTS = {
  combined: ({r, e}) => {
    assert.equal(e.detected, 2); assert.equal(e.falseAlarms, 0); assert.equal(e.repeats, 0);
    assert.equal(quality(r).length, 1); assert.ok(quality(r)[0].start >= 100 && quality(r)[0].start <= 135);
  },
  spike: ({r, e}) => {
    assert.equal(quality(r).length, 0); assert.equal(e.falseAlarms, 0);
    assert.ok(r.baseline.some(i => i.type === 'quality' && i.start >= 60 && i.start <= 61), 'порог должен сработать на выбросе');
  },
  drift: ({r, e}) => {
    assert.equal(e.detected, 1); assert.equal(e.falseAlarms, 0); assert.equal(e.repeats, 0);
    const [q] = quality(r); assert.ok(q.start >= 60 && q.start <= 90, 'задержка ' + (q.start - 60));
    if (q.end !== null) assert.ok(q.end >= 150, 'закрытие до восстановления');
  },
  gap: ({r, e}) => {
    assert.equal(e.detected, 1); assert.equal(quality(r).length, 0);
    const [a] = availability(r); assert.ok(a.start >= 60 && a.start <= 67); assert.ok(a.end >= 120 && a.end <= 125, 'старая пачка не закрывает инцидент');
    assert.equal(r.frames[110].availability, 'stale');
  },
  mode: ({r}) => {
    assert.equal(quality(r).length, 0); assert.equal(r.events.filter(e => e.kind === 'mode').length, 1);
  },
};
const MATRIX_SEEDS = [...new Set([...Array.from({length: 100}, (_, i) => i + 1), api.SEED.max, ...Object.values(api.RECOMMENDED_SEEDS).flat().map(s => s.seed)])];
for (const scenario of SCENARIO_IDS) {
  test(`матрица: ${scenario} × ${MATRIX_SEEDS.length} seed — инварианты сценария`, () => {
    for (const seed of MATRIX_SEEDS) {
      const x = run(scenario, seed);
      assert.equal(x.r.frames.length, api.SCENARIOS[scenario].duration + 1);
      try { INVARIANTS[scenario](x); } catch (err) { err.message = `${scenario}, seed ${seed}: ${err.message}`; throw err; }
    }
  });
}

test('рекомендованные seed: есть для каждого сценария, эталон 42 и в границах', () => {
  assert.deepEqual(Object.keys(api.RECOMMENDED_SEEDS).sort(), [...SCENARIO_IDS].sort());
  for (const [scenario, list] of Object.entries(api.RECOMMENDED_SEEDS)) {
    assert.equal(list[0].seed, 42, scenario);
    for (const s of list) { assert.doesNotThrow(() => api.checkSeed(s.seed)); assert.ok(s.seed <= api.SEED.scan); assert.ok(s.label && s.note); }
    assert.equal(new Set(list.map(s => s.seed)).size, list.length, scenario + ': повтор seed');
  }
});

for (const [scenario, list] of Object.entries(api.RECOMMENDED_SEEDS)) {
  for (const rec of list.filter(s => s.kind !== 'reference')) {
    test(`рекомендация ${scenario}/${rec.seed} «${rec.label}» подтверждается на seed 1…${api.SEED.scan}`, () => {
      const scan = Array.from({length: api.SEED.scan}, (_, i) => run(scenario, i + 1));
      const own = run(scenario, rec.seed);
      if (rec.kind === 'fastest' || rec.kind === 'slowest') {
        const delays = scan.map(x => x.e.delay).filter(d => d !== null);
        assert.equal(own.e.delay, rec.value);
        assert.equal(rec.value, rec.kind === 'fastest' ? Math.min(...delays) : Math.max(...delays));
      } else if (rec.kind === 'unclosed') {
        assert.ok(own.e.unclosed > 0);
      } else if (rec.kind === 'near_miss') {
        assert.equal(quality(own.r).length, 0);
        assert.equal(Number(own.peak.toFixed(2)), rec.value);
        assert.equal(rec.value, Number(Math.max(...scan.map(x => x.peak)).toFixed(2)));
        assert.ok(rec.value < api.CONFIG.h);
      } else assert.fail('неизвестный вид рекомендации ' + rec.kind);
    });
  }
}

const step = (sigmas, seed, duration = 400, start = 100) => {
  const random = (() => { let a = seed >>> 0; return () => { a += 0x6D2B79F5; let t = Math.imul(a ^ a >>> 15, 1 | a); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })();
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-9))) * Math.cos(2 * Math.PI * random());
  const m = new api.Monitor();
  for (let t = 0; t <= duration; t++) m.tick(t, [msg(t, {value: 95 + 1.5 * normal() - (t >= start ? sigmas * 1.5 : 0)})]);
  return m.incidents.filter(i => i.type === 'quality');
};
for (const [sigmas, maxDelay] of [[1, 120], [2, 40], [3, 25], [5, 20]]) {
  test(`матрица: ступень −${sigmas}σ × seed 1…20 обнаруживается не позже ${maxDelay} с`, () => {
    for (let seed = 1; seed <= 20; seed++) {
      const q = step(sigmas, seed);
      assert.equal(q.filter(i => i.start < 100).length, 0, 'тревога до ступени, seed ' + seed);
      assert.ok(q.length >= 1 && q[0].start - 100 <= maxDelay, `seed ${seed}: задержка ${q[0] && q[0].start - 100}`);
    }
  });
}
test('матрица: здоровый поток 1 ч × seed 1…10 без ложных тревог качества', () => {
  for (let seed = 1; seed <= 10; seed++) assert.equal(step(0, seed, 3600).length, 0, 'seed ' + seed);
});

test('собранный index.html актуален и его скрипты компилируются', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
  const html = read('index.html');
  assert.equal(html, read('ui.html').replace('/* ENGINE_SLOT */', () => read('engine.js')), 'запустите node demo/build.cjs');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(scripts.length, 2);
  for (const code of scripts) assert.doesNotThrow(() => new vm.Script(code));
});
