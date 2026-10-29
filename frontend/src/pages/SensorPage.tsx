import {ArrowLeft, Stop, TrashBin} from '@gravity-ui/icons';
import {Alert, Button, DefinitionList, Flex, Icon, Label, Loader, Progress, Table, Text, useToaster} from '@gravity-ui/uikit';
import {useCallback, useEffect, useState} from 'react';
import {useNavigate, useParams} from 'react-router-dom';

import {api} from '../api/client';
import type {Frame, Incident, Measurement, MonitorEvent, SensorDetail, StreamMessage} from '../api/types';
import {AlarmNotice} from '../components/AlarmNotice';
import {LinkedChartsProvider} from '../components/LinkedChart';
import {EventLog} from '../components/EventLog';
import {Page, Panel} from '../components/Page';
import {StatusLabels} from '../components/StatusLabels';
import {CusumChart, MeasurementsChart} from '../components/charts';
import {useStream} from '../hooks/useStream';
import {SIMULATION_STATE, formatDuration, formatNumber, formatTime} from '../lib/format';
import {useMeta} from '../lib/meta';

const KEEP = 3600;
const tail = <T,>(items: T[]) => (items.length > KEEP ? items.slice(-KEEP) : items);

interface State {
    detail: SensorDetail;
    measurements: Measurement[];
    frames: Frame[];
    events: MonitorEvent[];
    incidents: Incident[];
}

export function SensorPage() {
    const {sensorId = ''} = useParams();
    const meta = useMeta();
    const navigate = useNavigate();
    const toaster = useToaster();
    const [state, setState] = useState<State | null>(null);
    const [error, setError] = useState<Error | null>(null);

    const load = useCallback(async () => {
        try {
            const [detail, measurements, frames, events, incidents] = await Promise.all([
                api.sensor(sensorId),
                api.measurements(sensorId),
                api.frames(sensorId),
                api.events(sensorId),
                api.sensorIncidents(sensorId),
            ]);
            setState({detail, measurements, frames, events, incidents});
            setError(null);
        } catch (e) {
            setError(e as Error);
        }
    }, [sensorId]);

    useEffect(() => {
        setState(null);
        load();
    }, [load]);

    const onMessage = useCallback(
        (m: StreamMessage) => {
            if (m.type === 'sensor_removed') {
                navigate('/');
                return;
            }
            if (m.type !== 'update') return;
            setState((prev) => {
                if (!prev) return prev;
                const lastSeq = prev.events.at(-1)?.seq ?? 0;
                return {
                    ...prev,
                    detail: {...prev.detail, ...m.summary},
                    measurements: tail([...prev.measurements, ...m.measurements]),
                    frames: tail([...prev.frames, ...m.frames]),
                    events: [...prev.events, ...m.events.filter((e) => e.seq > lastSeq)],
                };
            });
            if (m.events.some((e) => e.incident_id !== null)) api.sensorIncidents(sensorId).then((incidents) => setState((prev) => prev && {...prev, incidents}));
        },
        [navigate, sensorId],
    );
    const stream = useStream(onMessage, sensorId);

    const act = async (action: () => Promise<unknown>, done: string) => {
        try {
            await action();
            toaster.add({name: 'sensor-action', theme: 'success', title: done, autoHiding: 3000});
        } catch (e) {
            toaster.add({name: 'sensor-action', theme: 'danger', title: 'Ошибка', content: (e as Error).message});
        }
    };

    if (error) return <Page title={sensorId}><Alert theme="danger" title="Не удалось загрузить сенсор" message={error.message} /></Page>;
    if (!state) return <Page title={sensorId}><Loader /></Page>;

    const {detail, measurements, frames, events, incidents} = state;
    const frame = detail.status;
    const sim = detail.simulation;
    const clock = detail.clock;

    return (
        <LinkedChartsProvider resetKey={sensorId}><Page
            title={detail.sensor_id}
            subtitle={
                (detail.source === 'simulation' ? `Симуляция «${meta.scenarios.find((s) => s.id === sim?.scenario)?.name}», seed ${sim?.seed}, ${sim?.speed}×` : 'Телеметрия через gateway') +
                (stream === 'open' ? ' · обновляется вживую' : ' · переподключение…')
            }
            actions={
                <>
                    <Button view="flat" onClick={() => navigate('/')}>
                        <Icon data={ArrowLeft} />
                        К обзору
                    </Button>
                    {sim?.state === 'running' && (
                        <Button view="outlined" onClick={() => act(() => api.stopSimulation(sim.id), 'Симуляция остановлена')}>
                            <Icon data={Stop} />
                            Остановить
                        </Button>
                    )}
                    <Button view="outlined-danger" onClick={() => act(() => api.deleteSensor(detail.sensor_id), 'Сенсор удалён')}>
                        <Icon data={TrashBin} />
                        Удалить
                    </Button>
                </>
            }
        >
            {detail.open_incidents.map((alarm) => <AlarmNotice key={alarm.id} reason={alarm.reason} start={alarm.start} clock={clock} />)}
            <Panel title="Правила тревог">
                <Text>Окно — {meta.config.window} с. Для открытия достаточно одного плохого окна;
                    для восстановления нужны два нормальных окна подряд, {meta.config.window * meta.config.recover} с.
                    Для уровня также требуется CUSUM ≥ {meta.config.h}; потеря свежести определяется таймером {meta.config.max_age} с.
                    После подтверждения восстановления оба нормальных окна не закрашиваются.</Text>
            </Panel>
            <div className="grid grid_sensor-head">
                <Panel title="Текущее состояние">
                    <Flex direction="column" gap={3}>
                        <StatusLabels frame={frame} size="m" />
                        <DefinitionList nameMaxWidth={220}>
                            <DefinitionList.Item name="Режим">{frame ? frame.mode + (frame.mode_known ? '' : ' (не описан)') : '—'}</DefinitionList.Item>
                            <DefinitionList.Item name="Эталон">{frame && detail.profiles[frame.mode] ? `${detail.profiles[frame.mode].mean} ± ${detail.profiles[frame.mode].sigma}` : '—'}</DefinitionList.Item>
                            <DefinitionList.Item name="CUSUM">{`${formatNumber(frame?.s)} / ${meta.config.h}`}</DefinitionList.Item>
                            <DefinitionList.Item name="Возраст свежего измерения">{formatDuration(frame?.age)}</DefinitionList.Item>
                            <DefinitionList.Item name="После последнего сообщения">{formatDuration(frame?.since_receipt)}</DefinitionList.Item>
                            <DefinitionList.Item name="Принято / опоздало">{frame ? `${frame.accepted} / ${frame.late_count}` : '—'}</DefinitionList.Item>
                            <DefinitionList.Item name="Время монитора">{formatTime(frame?.now, clock)}</DefinitionList.Item>
                        </DefinitionList>
                    </Flex>
                </Panel>
                {sim && (
                    <Panel title="Симуляция" extra={<Label theme={SIMULATION_STATE[sim.state].theme}>{SIMULATION_STATE[sim.state].text}</Label>}>
                        <Flex direction="column" gap={2}>
                            <Text variant="subheader-1">
                                {formatTime(sim.position, 'virtual')} / {formatTime(sim.duration, 'virtual')}
                            </Text>
                            <Progress className="progress-wide" value={sim.progress * 100} theme={sim.state === 'running' ? 'info' : 'success'} size="s" />
                            <Text color="secondary">{meta.scenarios.find((s) => s.id === sim.scenario)?.description}</Text>
                        </Flex>
                    </Panel>
                )}
            </div>
            <Panel title="Измерения">
                <MeasurementsChart
                    measurements={measurements}
                    clock={clock}
                    profiles={detail.profiles}
                    incidents={incidents}
                />
            </Panel>
            <Panel title="Накопление отклонений (CUSUM)">
                <CusumChart frames={frames} clock={clock} h={meta.config.h} suspect={meta.config.suspect} />
            </Panel>
            <div className="grid grid_two">
                <Panel title="Журнал монитора">
                    <EventLog events={events} clock={clock} />
                </Panel>
                <Panel title="Тревоги">
                    <Table
                        data={[...incidents].reverse()}
                        width="max"
                        emptyMessage="Тревог не было"
                        columns={[
                            {id: 'type', name: 'Событие', template: () => <Label theme="danger">Тревога</Label>},
                            {id: 'reason', name: 'Комментарий', template: (i: Incident) => <Text>{i.reason}</Text>},
                            {id: 'start', name: 'Начало', template: (i: Incident) => formatTime(i.start, clock)},
                            {id: 'end', name: 'Конец', template: (i: Incident) => (i.end === null ? <Label theme="danger">открыт</Label> : formatTime(i.end, clock))},
                            {id: 'duration', name: 'Длительность', align: 'end', template: (i: Incident) => formatDuration((i.end ?? frame?.now ?? i.start) - i.start)},
                        ]}
                    />
                </Panel>
            </div>
        </Page></LinkedChartsProvider>
    );
}
