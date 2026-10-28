import {Alert, Button, Flex, NumberInput, Select, Text} from '@gravity-ui/uikit';
import {useState} from 'react';

import {api} from '../api/client';
import type {BenchmarkResult, Metrics, ReplayResult} from '../api/types';
import {EventLog} from '../components/EventLog';
import {MetricsTable} from '../components/MetricsTable';
import {Page, Panel} from '../components/Page';
import {CusumChart, GroupedBarChart, MeasurementsChart} from '../components/charts';
import {useMeta} from '../lib/meta';

const BARS: [string, (m: Metrics) => number][] = [
    ['Обнаружено', (m) => m.detected],
    ['Пропущено', (m) => m.total - m.detected],
    ['Ложные', (m) => m.false_alarms],
    ['Повторы', (m) => m.repeats],
    ['Не закрыты', (m) => m.unclosed],
];

export function AnalysisPage() {
    const meta = useMeta();
    const [scenario, setScenario] = useState('combined');
    const [seed, setSeed] = useState<number | null>(42);
    const [replay, setReplay] = useState<ReplayResult | null>(null);
    const [scenarios, setScenarios] = useState<string[]>(meta.scenarios.map((s) => s.id));
    const [range, setRange] = useState<[number | null, number | null]>([1, 50]);
    const [bench, setBench] = useState<BenchmarkResult | null>(null);
    const [busy, setBusy] = useState<'replay' | 'bench' | null>(null);
    const [error, setError] = useState<string | null>(null);

    const run = async <T,>(kind: 'replay' | 'bench', action: () => Promise<T>, save: (v: T) => void) => {
        setBusy(kind);
        setError(null);
        try {
            save(await action());
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(null);
        }
    };

    const runs = scenarios.length * Math.max(0, (range[1] ?? 0) - (range[0] ?? 0) + 1);

    return (
        <Page title="Анализ сценариев" subtitle="Детерминированное воспроизведение и пакетная проверка на gateway">
            {error && <Alert theme="danger" title="Ошибка запроса" message={error} />}
            <Panel title="Воспроизведение">
                <Flex gap={2} alignItems="flex-end" wrap>
                    <Select label="Сценарий" width={300} value={[scenario]} onUpdate={([v]) => setScenario(v)} options={meta.scenarios.map((s) => ({value: s.id, content: s.name}))} />
                    <NumberInput label="Seed" value={seed} onUpdate={setSeed} min={1} max={999999} style={{width: 140}} />
                    <Button view="action" loading={busy === 'replay'} onClick={() => run('replay', () => api.replay({scenario, seed: seed ?? 42}), setReplay)}>
                        Воспроизвести
                    </Button>
                </Flex>
                <Text color="secondary">{meta.scenarios.find((s) => s.id === scenario)?.description}</Text>
            </Panel>
            {replay && (
                <>
                    <Panel title={`Результат · ${meta.scenarios.find((s) => s.id === replay.scenario)?.name} · seed ${replay.seed}`}>
                        <MetricsTable metrics={replay.metrics} />
                    </Panel>
                    <Panel title="Измерения, инциденты монитора и разметка">
                        <MeasurementsChart
                            measurements={replay.messages}
                            clock="virtual"
                            profiles={meta.profiles}
                            incidents={replay.incidents}
                            truth={replay.truth}
                            baselineSigma={meta.config.baselineSigma}
                            baseline={replay.baseline.filter((b) => b.type === 'quality')}
                        />
                    </Panel>
                    <div className="grid grid_two">
                        <Panel title="CUSUM">
                            <CusumChart frames={replay.frames} clock="virtual" h={meta.config.h} suspect={meta.config.suspect} />
                        </Panel>
                        <Panel title="Журнал монитора">
                            <EventLog events={replay.events} clock="virtual" limit={12} />
                        </Panel>
                    </div>
                </>
            )}
            <Panel title="Пакетная проверка">
                <Flex gap={2} alignItems="flex-end" wrap>
                    <Select
                        label="Сценарии"
                        multiple
                        width={360}
                        value={scenarios}
                        onUpdate={setScenarios}
                        options={meta.scenarios.map((s) => ({value: s.id, content: s.name}))}
                    />
                    <NumberInput label="Seed с" value={range[0]} onUpdate={(v) => setRange([v, range[1]])} min={1} style={{width: 130}} />
                    <NumberInput label="по" value={range[1]} onUpdate={(v) => setRange([range[0], v])} min={1} style={{width: 120}} />
                    <Button
                        view="action"
                        loading={busy === 'bench'}
                        disabled={!scenarios.length || runs < 1 || runs > meta.limits.max_benchmark_runs}
                        onClick={() => run('bench', () => api.benchmark({scenarios, seed_from: range[0] ?? 1, seed_to: range[1] ?? 1}), setBench)}
                    >
                        Проверить {runs} прогонов
                    </Button>
                </Flex>
                <Text color="secondary">
                    Параметры детектора фиксированы; это проверка устойчивости к шуму на синтетике. Порог сравнения не выровнен по бюджету ложных тревог.
                </Text>
                {bench && (
                    <Flex direction="column" gap={3}>
                        <Text>
                            {bench.runs} прогонов · seed {bench.seed_from}…{bench.seed_to} · {Math.round(bench.elapsed_ms)} мс
                        </Text>
                        <MetricsTable metrics={bench} />
                        <GroupedBarChart
                            categories={BARS.map(([name]) => name)}
                            series={[
                                {name: 'Монитор (CUSUM)', color: '#4d7cfe', values: BARS.map(([, get]) => get(bench.monitor))},
                                {name: 'Простой порог', color: '#f5a524', values: BARS.map(([, get]) => get(bench.baseline))},
                            ]}
                        />
                    </Flex>
                )}
            </Panel>
        </Page>
    );
}
