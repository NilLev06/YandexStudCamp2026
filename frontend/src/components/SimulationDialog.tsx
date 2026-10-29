import {Dialog, Flex, NumberInput, Select, Text, TextInput, useToaster} from '@gravity-ui/uikit';
import {useState} from 'react';

import {api} from '../api/client';
import type {Scenario, Simulation} from '../api/types';
import {useMeta} from '../lib/meta';
import {SeedField, seedError} from './SeedField';

interface Props {
    open: boolean;
    scenarios: Scenario[];
    maxSpeed: number;
    onClose: () => void;
    onStarted: (sim: Simulation) => void;
}

export function SimulationDialog({open, scenarios, maxSpeed, onClose, onStarted}: Props) {
    const toaster = useToaster();
    const [scenario, setScenario] = useState('combined');
    const [seed, setSeed] = useState<number | null>(42);
    const [speed, setSpeed] = useState<number | null>(6);
    const [sensorId, setSensorId] = useState('');
    const [loading, setLoading] = useState(false);
    const meta = useMeta();
    const current = scenarios.find((s) => s.id === scenario);
    const invalid = Boolean(seedError(seed, meta.seed)) || speed === null || speed <= 0 || speed > maxSpeed;

    const start = async () => {
        setLoading(true);
        try {
            const sim = await api.startSimulation({scenario, seed: seed as number, speed: speed as number, sensor_id: sensorId || undefined});
            onStarted(sim);
            onClose();
        } catch (e) {
            toaster.add({name: 'sim-error', theme: 'danger', title: 'Не удалось запустить', content: (e as Error).message});
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog open={open} onClose={onClose} size="s">
            <Dialog.Header caption="Запустить симуляцию" />
            <Dialog.Body>
                <Flex direction="column" gap={3}>
                    <Select
                        label="Сценарий"
                        width="max"
                        value={[scenario]}
                        onUpdate={([v]) => setScenario(v)}
                        options={scenarios.map((s) => ({value: s.id, content: s.name}))}
                    />
                    {current && <Text color="secondary">{current.description}</Text>}
                    <Flex gap={2}>
                        <SeedField value={seed} onUpdate={setSeed} />
                        <NumberInput label="Скорость, ×" value={speed} onUpdate={setSpeed} min={0.5} max={maxSpeed} step={0.5} allowDecimal />
                    </Flex>
                    <Text color="secondary">Окно 3 с. Открытие — одно плохое окно, восстановление — два нормальных подряд. Для уровня также нужен порог CUSUM.</Text>
                    <TextInput label="ID сенсора" placeholder="по умолчанию sim-сценарий-seed" value={sensorId} onUpdate={setSensorId} />
                </Flex>
            </Dialog.Body>
            <Dialog.Footer
                onClickButtonApply={start}
                onClickButtonCancel={onClose}
                textButtonApply="Запустить"
                textButtonCancel="Отмена"
                loading={loading}
                propsButtonApply={{disabled: invalid}}
            />
        </Dialog>
    );
}
