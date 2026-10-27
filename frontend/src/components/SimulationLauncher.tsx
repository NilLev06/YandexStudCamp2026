// Запуск сценария как «живого» датчика: данные идут через шлюз в модельном времени с ускорением
import {useEffect, useState} from 'react';
import {Button, Flex, Select, TextInput} from '@gravity-ui/uikit';
import {Play} from '@gravity-ui/icons';
import {Icon} from '@gravity-ui/uikit';
import {useNavigate} from 'react-router-dom';

import {api} from '../api/client';
import {live} from '../api/live';
import type {Scenario} from '../api/types';

export function SimulationLauncher({compact = false}: {compact?: boolean}) {
    const [scenarios, setScenarios] = useState<Scenario[]>([]);
    const [scenario, setScenario] = useState('combined');
    const [seed, setSeed] = useState('42');
    const [speed, setSpeed] = useState('6');
    const [busy, setBusy] = useState(false);
    const navigate = useNavigate();

    useEffect(() => {
        api.scenarios().then(setScenarios).catch(() => setScenarios([]));
    }, []);

    const start = async () => {
        setBusy(true);
        try {
            const s = await api.simulate(scenario, Number(seed) || 0, Number(speed) || 1);
            live.upsert(s);
            navigate(`/sensors/${encodeURIComponent(s.id)}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Flex gap={2} wrap alignItems="flex-end">
            <Select
                label="Сценарий"
                width={compact ? 260 : 300}
                value={[scenario]}
                onUpdate={(v) => setScenario(v[0])}
                options={scenarios.map((s) => ({value: s.id, content: s.extended ? `${s.name} (расширение)` : s.name}))}
            />
            <TextInput label="seed" value={seed} onUpdate={setSeed} type="number" style={{width: 110}} />
            <Select
                label="Скорость"
                width={140}
                value={[speed]}
                onUpdate={(v) => setSpeed(v[0])}
                options={['1', '3', '6', '12', '30'].map((v) => ({value: v, content: `${v}×`}))}
            />
            <Button view="action" loading={busy} onClick={start}>
                <Icon data={Play} size={14} />
                Запустить поток
            </Button>
        </Flex>
    );
}
