import {Play} from '@gravity-ui/icons';
import {Alert, Button, Flex, Icon, Label, Loader, Progress, Table, Text} from '@gravity-ui/uikit';
import {useMemo, useState} from 'react';
import {useNavigate} from 'react-router-dom';

import {api} from '../api/client';
import type {SensorSummary, StreamMessage} from '../api/types';
import {StatusLabels} from '../components/StatusLabels';
import {DonutChart, GroupedBarChart} from '../components/charts';
import {Page, Panel, Stat} from '../components/Page';
import {SimulationDialog} from '../components/SimulationDialog';
import {useAsync} from '../hooks/useAsync';
import {useStream} from '../hooks/useStream';
import {AVAILABILITY, INCIDENT, QUALITY, formatDuration, formatNumber} from '../lib/format';
import {useMeta} from '../lib/meta';

export function applyStream(list: SensorSummary[], message: StreamMessage): SensorSummary[] {
    if (message.type === 'sensor_removed') return list.filter((s) => s.sensor_id !== message.sensor_id);
    const index = list.findIndex((s) => s.sensor_id === message.sensor_id);
    if (index === -1) return [...list, message.summary];
    const next = [...list];
    next[index] = message.summary;
    return next;
}

const QUALITY_COLORS = {normal: '#30a46c', suspect: '#f5a524', alarm: '#e5484d', unknown: '#b9bbc6'};
const AVAILABILITY_COLORS = {fresh: '#30a46c', stale: '#e5484d', unknown: '#b9bbc6'};

export function OverviewPage() {
    const meta = useMeta();
    const navigate = useNavigate();
    const [dialog, setDialog] = useState(false);
    const {data: sensors, setData, error, loading} = useAsync(api.sensors, []);
    const stream = useStream((m) => setData((prev) => applyStream(prev ?? [], m)));

    const stats = useMemo(() => {
        const list = sensors ?? [];
        const count = <K extends string>(keys: K[], get: (s: SensorSummary) => K) =>
            Object.fromEntries(keys.map((k) => [k, list.filter((s) => get(s) === k).length])) as Record<K, number>;
        return {
            quality: count(['normal', 'suspect', 'alarm', 'unknown'], (s) => s.status?.quality ?? 'unknown'),
            availability: count(['fresh', 'stale', 'unknown'], (s) => s.status?.availability ?? 'unknown'),
            open: list.flatMap((s) => s.open_incidents),
            running: list.filter((s) => s.simulation?.state === 'running').length,
        };
    }, [sensors]);

    const columns = [
        {id: 'sensor_id', name: 'Сенсор', template: (s: SensorSummary) => <Text variant="subheader-1">{s.sensor_id}</Text>},
        {
            id: 'source',
            name: 'Источник',
            template: (s: SensorSummary) =>
                s.source === 'simulation' ? <Label theme="info">Симуляция · {s.simulation?.scenario}</Label> : <Label>Телеметрия</Label>,
        },
        {id: 'status', name: 'Статус', template: (s: SensorSummary) => <StatusLabels frame={s.status} />},
        {id: 'mode', name: 'Режим', template: (s: SensorSummary) => s.status?.mode ?? '—'},
        {id: 'cusum', name: 'CUSUM', align: 'end' as const, template: (s: SensorSummary) => formatNumber(s.status?.s)},
        {id: 'age', name: 'Возраст данных', align: 'end' as const, template: (s: SensorSummary) => formatDuration(s.status?.age)},
        {
            id: 'incidents',
            name: 'Открытые инциденты',
            template: (s: SensorSummary) =>
                s.open_incidents.length ? (
                    <Flex gap={1} wrap>
                        {s.open_incidents.map((i) => (
                            <Label key={i.id} theme={INCIDENT[i.type].theme}>
                                {INCIDENT[i.type].text}
                            </Label>
                        ))}
                    </Flex>
                ) : (
                    <Text color="secondary">нет</Text>
                ),
        },
        {
            id: 'progress',
            name: 'Прогресс',
            width: 140,
            template: (s: SensorSummary) =>
                s.simulation ? <Progress value={s.simulation.progress * 100} size="s" theme={s.simulation.state === 'running' ? 'info' : 'success'} /> : '—',
        },
    ];

    return (
        <Page
            title="Обзор сенсоров"
            subtitle={stream === 'open' ? 'Живые обновления подключены' : 'Подключаемся к потоку обновлений…'}
            actions={
                <Button view="action" onClick={() => setDialog(true)}>
                    <Icon data={Play} />
                    Запустить симуляцию
                </Button>
            }
        >
            {error && <Alert theme="danger" title="Gateway недоступен" message={error.message} />}
            <div className="grid grid_stats">
                <Stat label="Сенсоров" value={sensors?.length ?? '—'} hint={`симуляций идёт: ${stats.running}`} />
                <Stat label="Деградация качества" value={stats.quality.alarm} tone={stats.quality.alarm ? 'danger' : undefined} hint={`подозрение: ${stats.quality.suspect}`} />
                <Stat label="Нет свежих данных" value={stats.availability.stale} tone={stats.availability.stale ? 'danger' : undefined} />
                <Stat label="Открытых инцидентов" value={stats.open.length} tone={stats.open.length ? 'warning' : 'success'} />
            </div>
            <div className="grid grid_charts">
                <Panel title="Качество">
                    <DonutChart items={(Object.keys(QUALITY) as (keyof typeof QUALITY)[]).map((k) => ({name: QUALITY[k].text, value: stats.quality[k], color: QUALITY_COLORS[k]}))} />
                </Panel>
                <Panel title="Свежесть данных">
                    <DonutChart
                        items={(Object.keys(AVAILABILITY) as (keyof typeof AVAILABILITY)[]).map((k) => ({name: AVAILABILITY[k].text, value: stats.availability[k], color: AVAILABILITY_COLORS[k]}))}
                    />
                </Panel>
                <Panel title="Открытые инциденты по типам">
                    <GroupedBarChart
                        height={220}
                        categories={Object.values(INCIDENT).map((i) => i.short)}
                        series={[{name: 'Открыто', color: '#4d7cfe', values: (Object.keys(INCIDENT) as (keyof typeof INCIDENT)[]).map((t) => stats.open.filter((i) => i.type === t).length)}]}
                    />
                </Panel>
            </div>
            <Panel title="Сенсоры">
                {loading && !sensors ? (
                    <Loader />
                ) : (
                    <Table
                        data={sensors ?? []}
                        columns={columns}
                        width="max"
                        onRowClick={(s) => navigate('/sensors/' + encodeURIComponent(s.sensor_id))}
                        emptyMessage="Сенсоров нет. Запустите симуляцию или отправьте измерения в POST /api/v1/telemetry."
                    />
                )}
            </Panel>
            <SimulationDialog
                open={dialog}
                scenarios={meta.scenarios}
                maxSpeed={meta.limits.max_simulation_speed}
                onClose={() => setDialog(false)}
                onStarted={(sim) => navigate('/sensors/' + encodeURIComponent(sim.sensor_id))}
            />
        </Page>
    );
}
