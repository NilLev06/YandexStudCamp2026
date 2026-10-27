// Главный экран: сводка, датчики с живыми статусами, последние решения монитора
import {useEffect, useMemo, useState} from 'react';
import {Card, Flex, Label, Progress, Text} from '@gravity-ui/uikit';
import {Link} from 'react-router-dom';

import {api} from '../api/client';
import {useIncidentsVersion, useSensors} from '../api/live';
import type {MonitorEvent, SensorSummary} from '../api/types';
import {EventLog, IncidentLabel, StatusLabels} from '../components/common';
import {SimulationLauncher} from '../components/SimulationLauncher';
import {fmtNum, fmtTime} from '../utils/format';

function Stat({title, value, hint, theme}: {title: string; value: number | string; hint?: string; theme?: 'danger' | 'positive'}) {
    return (
        <Card view="outlined" className="sw-stat">
            <Text color="secondary">{title}</Text>
            <Text variant="display-2" color={theme}>{value}</Text>
            {hint && <Text color="secondary" variant="caption-2">{hint}</Text>}
        </Card>
    );
}

function SensorCard({s}: {s: SensorSummary}) {
    const st = s.status;
    const progress = s.duration && s.now !== null ? Math.min(100, (s.now / s.duration) * 100) : null;
    const border =
        st?.quality === 'alarm' || st?.availability === 'stale' ? 'sw-card_alarm' : st?.quality === 'suspect' ? 'sw-card_warn' : '';
    return (
        <Link to={`/sensors/${encodeURIComponent(s.id)}`} className="sw-card-link">
            <Card view="outlined" type="action" className={`sw-sensor-card ${border}`}>
                <Flex direction="column" gap={2}>
                    <Flex justifyContent="space-between" alignItems="flex-start" gap={2}>
                        <Flex direction="column" style={{minWidth: 0, flex: 1}}>
                            <Text variant="subheader-2" ellipsis>{s.name}</Text>
                            <Text color="secondary" variant="code-1">{s.id}</Text>
                        </Flex>
                        <Label size="xs" theme={s.kind === 'live' ? 'info' : 'utility'}>
                            {s.kind === 'live' ? 'живой' : `сим ${s.speed}×`}
                        </Label>
                    </Flex>
                    <StatusLabels status={st} size="xs" />
                    <Flex gap={4}>
                        <Flex direction="column">
                            <Text color="secondary" variant="caption-2">медиана окна</Text>
                            <Text variant="body-2">{fmtNum(st?.aggregate)} {s.unit ?? ''}</Text>
                        </Flex>
                        <Flex direction="column">
                            <Text color="secondary" variant="caption-2">норма режима {st?.mode ?? ''}</Text>
                            <Text variant="body-2">{fmtNum(st?.norm)}</Text>
                        </Flex>
                        <Flex direction="column">
                            <Text color="secondary" variant="caption-2">CUSUM</Text>
                            <Text variant="body-2">{fmtNum(st?.s, 1)}</Text>
                        </Flex>
                        <Flex direction="column">
                            <Text color="secondary" variant="caption-2">инциденты</Text>
                            <Text variant="body-2" color={s.open_incidents ? 'danger' : undefined}>{s.open_incidents}</Text>
                        </Flex>
                    </Flex>
                    {progress !== null && (
                        <Flex direction="column" gap={1}>
                            <Progress value={progress} size="xs" theme={s.finished ? 'success' : 'info'} />
                            <Text color="secondary" variant="caption-2">
                                {s.finished ? 'сценарий завершён' : `${fmtTime(s.now, 'sim')} из ${fmtTime(s.duration, 'sim')}`}
                            </Text>
                        </Flex>
                    )}
                </Flex>
            </Card>
        </Link>
    );
}

export function OverviewPage() {
    const sensors = useSensors();
    const version = useIncidentsVersion();
    const [events, setEvents] = useState<MonitorEvent[]>([]);
    const [openByType, setOpenByType] = useState<Record<string, number>>({});
    const [unack, setUnack] = useState(0);

    useEffect(() => {
        api.events({limit: 30}).then(setEvents).catch(() => undefined);
        api.overview()
            .then((o) => {
                setOpenByType(o.open_by_type);
                setUnack(o.unacknowledged);
            })
            .catch(() => undefined);
    }, [version, sensors.length]);

    const counts = useMemo(() => {
        const c = {alarm: 0, stale: 0, ok: 0, open: 0};
        for (const s of sensors) {
            if (s.status?.quality === 'alarm') c.alarm++;
            if (s.status?.availability === 'stale') c.stale++;
            if (s.status?.quality === 'normal' && s.status?.availability === 'fresh') c.ok++;
            c.open += s.open_incidents;
        }
        return c;
    }, [sensors]);

    const clockOf = (id?: string) => sensors.find((s) => s.id === id)?.clock ?? 'wall';
    const sorted = [...sensors].sort((a, b) => b.open_incidents - a.open_incidents || a.name.localeCompare(b.name));

    return (
        <Flex direction="column" gap={5} className="sw-page">
            <Flex direction="column" gap={1}>
                <Text variant="header-2">Обзор</Text>
                <Text color="secondary">
                    Монитор отличает устойчивую деградацию и пропуски от случайных выбросов. Данные приходят в шлюз от живых источников или из
                    синтетических сценариев с отдельной разметкой.
                </Text>
            </Flex>

            <div className="sw-stats">
                <Stat title="Датчиков" value={sensors.length} hint={`в норме: ${counts.ok}`} />
                <Stat title="Деградация качества" value={counts.alarm} theme={counts.alarm ? 'danger' : 'positive'} />
                <Stat title="Нет свежих данных" value={counts.stale} theme={counts.stale ? 'danger' : 'positive'} />
                <Stat title="Открытых инцидентов" value={counts.open} hint={`не просмотрено: ${unack}`} theme={counts.open ? 'danger' : 'positive'} />
            </div>

            <Card view="filled" className="sw-panel">
                <Flex direction="column" gap={2}>
                    <Text variant="subheader-2">Запустить сценарий как живой поток</Text>
                    <Text color="secondary">
                        Сообщения идут через шлюз по своему времени доставки: выбросы, дрейф, пропуск с поздней пачкой, смена режима.
                    </Text>
                    <SimulationLauncher />
                </Flex>
            </Card>

            <Flex direction="column" gap={2}>
                <Flex gap={2} alignItems="center">
                    <Text variant="subheader-3">Датчики</Text>
                    {Object.entries(openByType)
                        .filter(([, n]) => n > 0)
                        .map(([t, n]) => (
                            <Flex key={t} gap={1} alignItems="center">
                                <IncidentLabel type={t} />
                                <Text color="secondary">{n}</Text>
                            </Flex>
                        ))}
                </Flex>
                {sorted.length ? (
                    <div className="sw-grid">
                        {sorted.map((s) => (
                            <SensorCard key={s.id} s={s} />
                        ))}
                    </div>
                ) : (
                    <Text color="secondary">
                        Датчиков пока нет. Запустите сценарий выше или отправьте измерения в POST /api/v1/ingest.
                    </Text>
                )}
            </Flex>

            <Card view="outlined" className="sw-panel">
                <Flex direction="column" gap={3}>
                    <Text variant="subheader-2">Последние решения монитора</Text>
                    <EventLogWithSensor events={events} clockOf={clockOf} />
                </Flex>
            </Card>
        </Flex>
    );
}

function EventLogWithSensor({events, clockOf}: {events: MonitorEvent[]; clockOf: (id?: string) => 'wall' | 'sim'}) {
    const groups = new Map<string, MonitorEvent[]>();
    events.forEach((e) => groups.set(e.sensor_id ?? '', [...(groups.get(e.sensor_id ?? '') ?? []), e]));
    if (!events.length) return <Text color="secondary">Пока пусто.</Text>;
    return (
        <Flex direction="column" gap={4}>
            {[...groups.entries()].slice(0, 4).map(([sid, list]) => (
                <Flex key={sid} direction="column" gap={2}>
                    <Link to={`/sensors/${encodeURIComponent(sid)}`}>
                        <Text variant="subheader-1">{sid}</Text>
                    </Link>
                    <EventLog events={list} clock={clockOf(sid)} limit={3} />
                </Flex>
            ))}
        </Flex>
    );
}
