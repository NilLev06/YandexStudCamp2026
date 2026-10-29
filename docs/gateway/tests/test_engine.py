import json
import shutil
import subprocess
from pathlib import Path

import pytest

from app.engine import SCENARIOS, Monitor, evaluate, generate, replay

ENGINE_JS = Path(__file__).resolve().parents[2] / 'demo' / 'engine.js'
SEEDS = range(1, 6)

JS = '''
const api=require(process.argv[1]);const out={};
for(const s of Object.keys(api.SCENARIOS))for(let seed=1;seed<=5;seed++){const r=api.replay(s,seed);
out[s+':'+seed]={messages:r.messages.map(m=>[m.id,m.received_at,m.value,m.mode]),incidents:r.incidents.map(i=>[i.type,i.start,i.end,i.reason]),
baseline:r.baseline.map(i=>[i.type,i.start,i.end]),frames:r.frames.map(f=>[f.quality,f.availability,f.flags,f.mode,+f.s.toFixed(9),f.age]),
events:r.events.map(e=>[e.time,e.kind,e.type,e.text]),metrics:api.evaluate(r)};}
process.stdout.write(JSON.stringify(out));
'''


@pytest.fixture(scope='module')
def js_results():
    node = shutil.which('node')
    if not node or not ENGINE_JS.exists():
        pytest.skip('Нужен Node.js и demo/engine.js')
    return json.loads(subprocess.run([node, '-e', JS, str(ENGINE_JS)], capture_output=True, check=True, text=True).stdout)


@pytest.mark.parametrize('scenario', list(SCENARIOS))
@pytest.mark.parametrize('seed', SEEDS)
def test_python_port_matches_js_engine(js_results, scenario, seed):
    js = js_results[f'{scenario}:{seed}']
    r = replay(scenario, seed)
    assert [[m['id'], m['received_at'], m['value'], m['mode']] for m in r['messages']] == js['messages']
    assert [[i['type'], i['start'], i['end'], i['reason']] for i in r['incidents']] == js['incidents']
    assert [[i['type'], i['start'], i['end']] for i in r['baseline']] == js['baseline']
    assert [[f['quality'], f['availability'], f['flags'], f['mode'], round(f['s'], 9), f['age']] for f in r['frames']] == js['frames']
    assert [[e['time'], e['kind'], e['type'], e['text']] for e in r['events']] == js['events']
    assert evaluate(r) == js['metrics']


def test_same_seed_reproduces_stream():
    assert generate('combined', 13) == generate('combined', 13)
    assert generate('combined', 13)['messages'] != generate('combined', 14)['messages']


def test_monitor_needs_no_truth_and_opens_availability_without_data():
    m = Monitor()
    for t in range(11):
        m.tick(t, [])
    assert m.tick(15, []).availability == 'stale'
    assert [i.type for i in m.incidents] == ['availability']
