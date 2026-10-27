// Выгрузка результатов demo/engine.js для сверки с Python-ядром
const path = require('path');
const api = require(path.join(__dirname, '..', '..', '..', 'demo', 'engine.js'));
const [scenarios, seeds] = [process.argv[2].split(','), process.argv[3].split(',').map(Number)];
const out = {};
for (const sc of scenarios) for (const seed of seeds) {
  const r = api.replay(sc, seed);
  out[sc + ':' + seed] = {
    messages: r.messages.map(m => [m.event_time, m.received_at, m.value, m.mode]),
    incidents: r.incidents.map(i => [i.type, i.start, i.end]),
    events: r.events.map(e => [e.time, e.kind, e.type]),
    s: r.frames.map(f => f.s), quality: r.frames.map(f => f.quality), availability: r.frames.map(f => f.availability),
    baseline: r.baseline.map(i => [i.type, i.start, i.end]),
    metrics: api.evaluate(r),
  };
}
process.stdout.write(JSON.stringify(out));
