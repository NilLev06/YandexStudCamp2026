"""Вариации шума не должны превращать общую динамику или одиночный выброс в расхождение."""
import pytest

from app.engine.pair import replay_pair


@pytest.mark.parametrize('seed', [1, 7, 13, 42, 73, 1000, 999999])
@pytest.mark.parametrize('scenario', ['normal', 'drift', 'spike', 'gap'])
def test_pair_matrix(scenario, seed):
    result = replay_pair(scenario, seed)
    alarms = [i for i in result['incidents'] if i['type'] == 'disagreement']
    missing = [i for i in result['incidents'] if i['type'] == 'availability']
    if scenario == 'drift':
        assert len(alarms) == 1 and 65 <= alarms[0]['start'] < 100
        assert alarms[0]['end'] is not None and 120 <= alarms[0]['end'] < 155
    else:
        assert not alarms
    if scenario == 'gap':
        assert len(missing) == 1 and missing[0]['end'] >= 110
        assert result['frames'][100]['status'] == 'unavailable'
    else:
        assert not missing
