// Лаборатория: офлайн-прогон сценария с перемоткой и пакетная проверка «монитор против порога»
import {useEffect, useMemo, useRef, useState} from 'react';
import {Alert, Button, Card, Flex, Icon, Loader, Select, Slider, Tab, TabList, TabPanel, TabProvider, Table, Text, TextInput} from '@gravity-ui/uikit';
import {Pause, Play} from '@gravity-ui/icons';

import {api} from '../api/client';
import type {BenchmarkResult, Metrics, RunResult, Scenario} from '../api/types';
import {EventLog, MetricsTable} from '../components/common';
import {SensorCharts} from '../components/SensorCharts';
import {SimulationLauncher} from '../components/SimulationLauncher';
import {fmtDuration, fmtTime} from '../utils/format';

export function LabPage() {
    const [tab, setTab] = useState('run');
    return (
        <Flex direction="column" gap={4} className="sw-page">
            <Flex direction="column" gap={1}>
                <Text variant="header-2">Сценарии и проверка</Text>
                <Text color="secondary">
                    Синтетические потоки с отдельной разметкой: монитор видит только сообщения, оценщик сравнивает его решения с разметкой.
                </Text>
            </Flex>
            <TabProvider value={tab} onUpdate={setTab}>
                <TabList>
                    <Tab value="run">Прогон с перемоткой</Tab>
                    <Tab value="bench">Пакетная проверка</Tab>
                    <Tab value="live">Живой поток</Tab>
                </TabList>
                <div className="sw-tab-body">
                    <TabPanel value="run">
                        <RunTab />
                    </TabPanel>
                    <TabPanel value="bench">
                        <BenchTab />
                    </TabPanel>
                    <TabPanel value="live">
                        <Card view="filled" className="sw-panel">
                            <Flex direction="column" gap={2}>
                                <Text>Сценарий проигрывается через шлюз в модельном времени: так же, как поток от настоящего источника.</Text>
                                <SimulationLauncher />
                            </Flex>
                        </Card>
                    </TabPanel>
                </div>
            </TabProvider>
        </Flex>
    );
}

function useScenarios() {
    const [list, setList] = useState<Scenario[]>([]);
    useEffect(() => {
        api.scenarios().then(setList).catch(() => setList([]));
    }, []);
    return list;
}

function RunTab() {
    const scenarios = useScenarios();
    const [scenario, setScenario] = useState('combined');
    const [seed, setSeed] = useState('42');
    const [direction, setDirection] = useState('down');
    const [run, setRun] = useState<RunResult | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [t, setT] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState('6');
    const timer = useRef<number | null>(null);

    const start = async () => {
        setBusy(true);
        setError(null);
        try {
            const r = await api.run(scenario, Number(seed) || 0, direction === 'down' ? undefined : {direction});
            setRun(r);
            setT(r.duration);
            setPlaying(false);
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    useEffect(() => {
        start();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Воспроизведение: модельное время идёт с выбранной скоростью
    useEffect(() => {
        if (!playing || !run) return undefined;
        timer.current = window.setInterval(() => {
            setT((prev) => {
                const next = prev + Number(speed) / 10;
                if (next >= run.duration) {
                    setPlaying(false);
                    return run.duration;
                }
                return next;
            });
        }, 100);
        return () => {
            if (timer.current) window.clearInterval(timer.current);
        };
    }, [playing, run, speed]);

    const view = useMemo(() => {
        if (!run) return null;
        const now = Math.floor(t);
        return {
            messages: run.messages.filter((m) => m.received_at <= now),
            frames: run.frames.filter((f) => f.now <= now),
            incidents: run.incidents.filter((i) => i.start <= now).map((i) => ({...i, end: i.end !== null && i.end <= now ? i.end : null})),
            baseline: run.baseline.filter((i) => i.start <= now),
            events: run.events.filter((e) => e.time <= now),
        };
    }, [run, t]);

    const keyMoments = useMemo(() => {
        if (!run) return [];
        const pts = run.annotations.map((a) => ({t: a.start + 5, label: a.label}));
        run.incidents.forEach((i) => pts.push({t: i.start, label: `тревога: ${i.type}`}));
        return pts.sort((a, b) => a.t - b.t).slice(0, 8);
    }, [run]);

    return (
        <Flex direction="column" gap={3}>
            <Flex gap={2} wrap alignItems="flex-end">
                <Select
                    label="Сценарий"
                    width={300}
                    value={[scenario]}
                    onUpdate={(v) => setScenario(v[0])}
                    options={scenarios.map((s) => ({value: s.id, content: s.extended ? `${s.name} (расширение)` : s.name}))}
                />
                <TextInput label="seed" value={seed} onUpdate={setSeed} type="number" style={{width: 110}} />
                <Select
                    label="Деградация"
                    width={270}
                    value={[direction]}
                    onUpdate={(v) => setDirection(v[0])}
                    options={[
                        {value: 'down', content: 'вниз (как в кейсе)'},
                        {value: 'both', content: 'в обе стороны'},
                    ]}
                />
                <Button view="action" loading={busy} onClick={start}>
                    Прогнать
                </Button>
            </Flex>
            {error && <Alert theme="danger" message={error} />}
            {!run && busy && <Loader />}
            {run && view && (
                <>
                    <Text color="secondary">{scenarios.find((s) => s.id === run.scenario)?.description}</Text>
                    <Card view="outlined" className="sw-panel">
                        <Flex direction="column" gap={3}>
                            <Flex gap={2} alignItems="center" wrap>
                                <Button
                                    view="action"
                                    onClick={() => {
                                        if (t >= run.duration) setT(0);
                                        setPlaying((p) => !p);
                                    }}
                                >
                                    <Icon data={playing ? Pause : Play} size={14} />
                                    {playing ? 'Пауза' : 'Показ'}
                                </Button>
                                <Select
                                    width={90}
                                    value={[speed]}
                                    onUpdate={(v) => setSpeed(v[0])}
                                    options={['3', '6', '12', '30'].map((v) => ({value: v, content: `${v}×`}))}
                                />
                                <Text variant="code-2">
                                    {fmtTime(t, 'sim')} / {fmtTime(run.duration, 'sim')}
                                </Text>
                                {keyMoments.map((k, i) => (
                                    <Button
                                        key={i}
                                        size="s"
                                        view="flat-secondary"
                                        onClick={() => {
                                            setPlaying(false);
                                            setT(Math.min(run.duration, k.t));
                                        }}
                                    >
                                        {fmtTime(k.t, 'sim')} · {k.label}
                                    </Button>
                                ))}
                            </Flex>
                            <Slider
                                min={0}
                                max={run.duration}
                                step={1}
                                value={Math.floor(t)}
                                onUpdate={(v) => {
                                    setPlaying(false);
                                    setT(Array.isArray(v) ? v[0] : v);
                                }}
                            />
                            <SensorCharts
                                clock="sim"
                                messages={view.messages}
                                frames={view.frames}
                                incidents={view.incidents}
                                baseline={view.baseline}
                                labels={run.truth}
                                annotations={run.annotations}
                                unit="score"
                                h={Number(run.config.h)}
                                suspect={Number(run.config.suspect)}
                                baselineSigma={Number(run.config.baseline_sigma)}
                                showBaseline
                                showLabels
                                xMin={0}
                                xMax={run.duration}
                            />
                        </Flex>
                    </Card>
                    <Card view="outlined" className="sw-panel">
                        <Flex direction="column" gap={2}>
                            <Text variant="subheader-2">Итог по разметке (вся запись)</Text>
                            <MetricsTable monitor={run.metrics.monitor} baseline={run.metrics.baseline} />
                        </Flex>
                    </Card>
                    <Card view="outlined" className="sw-panel">
                        <Flex direction="column" gap={2}>
                            <Text variant="subheader-2">Журнал решений на {fmtTime(t, 'sim')}</Text>
                            <EventLog events={view.events} clock="sim" limit={10} />
                        </Flex>
                    </Card>
                </>
            )}
        </Flex>
    );
}

function BenchTab() {
    const [seeds, setSeeds] = useState('50');
    const [res, setRes] = useState<BenchmarkResult | null>(null);
    const [busy, setBusy] = useState(false);
    const scenarios = useScenarios();
    const name = (id: string) => scenarios.find((s) => s.id === id)?.name ?? id;

    const go = async () => {
        setBusy(true);
        try {
            setRes(await api.benchmark(Math.max(1, Math.min(500, Number(seeds) || 50))));
        } finally {
            setBusy(false);
        }
    };

    type Row = {id: string; method: string; m: Metrics; first: boolean};
    const rows: Row[] = res
        ? Object.entries(res.scenarios).flatMap(([id, v]) => [
              {id, method: 'Наш монитор', m: v.monitor, first: true},
              {id, method: 'Простой порог', m: v.baseline, first: false},
          ])
        : [];

    return (
        <Flex direction="column" gap={3}>
            <Flex gap={2} alignItems="flex-end">
                <TextInput label="seed на сценарий" value={seeds} onUpdate={setSeeds} type="number" style={{width: 230}} />
                <Button view="action" loading={busy} onClick={go}>
                    Запустить проверку
                </Button>
                {res && <Text color="secondary">{res.runs} прогонов</Text>}
            </Flex>
            {res && (
                <>
                    <Card view="outlined" className="sw-panel">
                        <Flex direction="column" gap={2}>
                            <Text variant="subheader-2">Итог по всем сценариям</Text>
                            <MetricsTable monitor={res.total.monitor} baseline={res.total.baseline} />
                        </Flex>
                    </Card>
                    <Card view="outlined" className="sw-panel">
                        <Table
                            width="max"
                            data={rows}
                            columns={[
                                {id: 'scenario', name: 'Сценарий', template: (r) => (r.first ? <Text variant="subheader-1">{name(r.id)}</Text> : <span />)},
                                {id: 'method', name: 'Метод'},
                                {id: 'det', name: 'Обнаружено', align: 'end', template: (r) => `${r.m.detected} / ${r.m.total}`},
                                {
                                    id: 'fa',
                                    name: 'Ложные',
                                    align: 'end',
                                    template: (r) => <Text color={r.m.false_alarms ? 'danger' : 'positive'}>{r.m.false_alarms}</Text>,
                                },
                                {id: 'rep', name: 'Повторы', align: 'end', template: (r) => String(r.m.repeats)},
                                {id: 'unc', name: 'Не закрыты', align: 'end', template: (r) => String(r.m.unclosed)},
                                {id: 'del', name: 'Задержка', align: 'end', template: (r) => fmtDuration(r.m.delay)},
                            ]}
                        />
                    </Card>
                    <Text color="secondary">
                        Порог не настроен на тот же бюджет ложных тревог - сравнение иллюстративное. «Не закрыты» в плавной деградации: запись
                        кончается раньше, чем монитор успевает подтвердить пять нормальных окон.
                    </Text>
                </>
            )}
        </Flex>
    );
}
