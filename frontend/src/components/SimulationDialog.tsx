import {Dialog, Flex, NumberInput, Select, Text, TextInput, useToaster} from '@gravity-ui/uikit';
import {useState} from 'react';

import {api} from '../api/client';
import type {Scenario, Simulation} from '../api/types';

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
    const current = scenarios.find((s) => s.id === scenario);

    const start = async () => {
        setLoading(true);
        try {
            const sim = await api.startSimulation({scenario, seed: seed ?? 42, speed: speed ?? 6, sensor_id: sensorId || undefined});
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
                        <NumberInput label="Seed" value={seed} onUpdate={setSeed} min={1} max={999999} />
                        <NumberInput label="Скорость, ×" value={speed} onUpdate={setSpeed} min={0.5} max={maxSpeed} step={0.5} allowDecimal />
                    </Flex>
                    <TextInput label="ID сенсора" placeholder="по умолчанию sim-сценарий-seed" value={sensorId} onUpdate={setSensorId} />
                </Flex>
            </Dialog.Body>
            <Dialog.Footer
                onClickButtonApply={start}
                onClickButtonCancel={onClose}
                textButtonApply="Запустить"
                textButtonCancel="Отмена"
                loading={loading}
            />
        </Dialog>
    );
}
