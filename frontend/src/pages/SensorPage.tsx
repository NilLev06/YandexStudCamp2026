// Карточка датчика: статусы, графики в реальном времени, журнал, инциденты, эталоны, оценка по разметке
import {useCallback, useEffect, useMemo, useState} from 'react';
import {
    Alert,
    Button,
    Card,
    Checkbox,
    Dialog,
    Flex,
    Icon,
    Label,
    Loader,
    SegmentedRadioGroup,
    Select,
    Tab,
    TabList,
    TabPanel,
    TabProvider,
    Table,
    Text,
    TextInput,
} from '@gravity-ui/uikit';
import {ArrowDownToLine, ArrowRotateLeft, Sliders, TrashBin} from '@gravity-ui/icons';
import {useNavigate, useParams} from 'react-router-dom';

import {api} from '../api/client';
import {useIncidentsVersion, useSensors, useTicks} from '../api/live';
import type {TickListener} from '../api/live';
import type {BaselineIncident, Evaluation, Frame, Incident, Message, MonitorEvent, SensorDetail, Status} from '../api/types';
import {DiagLabels, EventLog, IncidentsTable, MetricsTable} from '../components/common';
import {SensorCharts} from '../components/SensorCharts';
import {AVAILABILITY, QUALITY, fmtDuration, fmtNum, fmtTime} from '../utils/format';

const KEEP = 20000; // сколько точек держим в браузере

export function SensorPage() {
    const {id = ''} = useParams();
    const sensors = useSensors();
    const summary = sensors.find((s) => s.id === id);
    const incVersion = useIncidentsVersion();
    const navigate = useNavigate();

    const [detail, setDetail] = useState<SensorDetail | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [frames, setFrames] = useState<Frame[]>([]);
    const [events, setEvents] = useState<MonitorEvent[]>([]);
    const [incidents, setIncidents] = useState<Incident[]>([]);
    const [baseline, setBaseline] = useState<BaselineIncident[]>([]);
    const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
    const [windowSec, setWindowSec] = useState('600');
    const [showBaseline, setShowBaseline] = useState(true);
    const [showLabels, setShowLabels] = useState(true);
    const [tab, setTab] = useState('log');
    const [calibrateOpen, setCalibrateOpen] = useState(false);

    const load = useCallback(async () => {
        try {
            const [d, s] = await Promise.all([api.sensor(id), api.series(id, 8000)]);
            setDetail(d);
            setMessages(s.messages);
            setFrames(s.frames);
            setEvents(s.events);
            setIncidents(s.incidents);
            setBaseline(s.baseline);
            setError(null);
        } catch (e) {
            setError((e as Error).message);
        }
    }, [id]);

    useEffect(() => {
        load();
    }, [load]);

    // Живые тики: дописываем точки к уже загруженной истории
    const onTick = useCallback<TickListener>(({frame, messages: msgs, events: evs, incidents: incs}) => {
        setFrames((prev) => (prev.length >= KEEP ? [...prev.slice(-KEEP / 2), frame] : [...prev, frame]));
        if (msgs.length) setMessages((prev) => (prev.length >= KEEP ? [...prev.slice(-KEEP / 2), ...msgs] : [...prev, ...msgs]));
        // события журнала (open/close/mode/...) приходят отдельно от карточек инцидентов
        if (evs.length) setEvents((prev) => [...prev, ...evs]);
        if (incs.length) {
            setIncidents((prev) => {
                const map = new Map(prev.map((i) => [i.id, i]));
                incs.forEach((i) => map.set(i.id, i));
                return [...map.values()].sort((a, b) => b.start - a.start);
            });
        }
    }, []);
    useTicks(id, onTick);

    // Подтверждения и т.п. - перечитываем список инцидентов
    useEffect(() => {
        api.incidents({sensor_id: id}).then(setIncidents).catch(() => undefined);
    }, [id, incVersion]);

    // Порог перечитываем раз в 15 с (его инциденты в живой поток не входят)
    useEffect(() => {
        const t = window.setInterval(() => {
            api.series(id, 50).then((s) => setBaseline(s.baseline)).catch(() => undefined);
        }, 15000);
        return () => window.clearInterval(t);
    }, [id]);

    const finished = summary?.finished;
    useEffect(() => {
        if (tab === 'eval' || finished) api.evaluation(id).then(setEvaluation).catch(() => undefined);
    }, [id, tab, finished, incVersion]);

    const clock = detail?.clock ?? 'wall';
    const last = frames.at(-1) ?? null;
    const cfg = detail?.config ?? {};
    const xRange = useMemo(() => {
        if (!detail) return {};
        if (detail.kind === 'simulation' && detail.duration) return {xMin: 0, xMax: detail.duration};
        if (windowSec === 'all' || !last) return {};
        return {xMin: last.now - Number(windowSec), xMax: last.now};
    }, [detail, windowSec, last]);

    const view = useMemo(() => {
        if (xRange.xMin === undefined) return {messages, frames};
        const lo = xRange.xMin - 5;
        return {messages: messages.filter((m) => m.event_time >= lo), frames: frames.filter((f) => f.now >= lo)};
    }, [messages, frames, xRange.xMin]);

    if (error && !detail) {
        return (
            <Flex direction="column" gap={3} className="sw-page">
                <Alert theme="danger" title="Датчик недоступен" message={error} />
                <Button onClick={() => navigate('/')}>К обзору</Button>
            </Flex>
        );
    }
    if (!detail) return <Loader size="l" className="sw-loader" />;

    const status: Status | Frame | null = summary?.status ?? last;
    const q = status ? QUALITY[status.quality] : null;
    const a = status ? AVAILABILITY[status.availability] : null;

    return (
        <Flex direction="column" gap={4} className="sw-page">
            <Flex justifyContent="space-between" alignItems="flex-start" gap={3} wrap>
                <Flex direction="column" gap={1}>
                    <Flex gap={2} alignItems="center" wrap>
                        <Text variant="header-2">{detail.name}</Text>
                        <Label theme={detail.kind === 'live' ? 'info' : 'utility'}>
                            {detail.kind === 'live' ? 'живой источник' : `симуляция ${detail.speed}×`}
                        </Label>
                        {detail.tags.map((t) => (
                            <Label key={t} size="xs">{t}</Label>
                        ))}
                    </Flex>
                    <Text color="secondary" variant="code-1">
                        {detail.id} · {detail.source}
                        {detail.unit ? ` · ${detail.unit}` : ''}
                    </Text>
                    {detail.description && <Text color="secondary">{detail.description}</Text>}
                </Flex>
                <Flex gap={2} wrap>
                    <Button view="outlined" onClick={() => setCalibrateOpen(true)}>
                        <Icon data={Sliders} size={14} />
                        Калибровать
                    </Button>
                    <Button view="outlined" href={api.exportUrl(id)} target="_blank">
                        <Icon data={ArrowDownToLine} size={14} />
                        Экспорт JSON
                    </Button>
                    {detail.kind === 'live' && (
                        <Button
                            view="outlined"
                            onClick={async () => {
                                await api.resetSensor(id);
                                load();
                            }}
                        >
                            <Icon data={ArrowRotateLeft} size={14} />
                            Сбросить
                        </Button>
                    )}
                    <Button
                        view="outlined-danger"
                        onClick={async () => {
                            await api.deleteSensor(id);
                            navigate('/');
                        }}
                    >
                        <Icon data={TrashBin} size={14} />
                        Удалить
                    </Button>
                </Flex>
            </Flex>

            <div className="sw-stats">
                <Card view="outlined" className="sw-stat">
                    <Text color="secondary">Качество измерений</Text>
                    {q && <Label theme={q.theme} size="m">{q.text}</Label>}
                    <Text color="secondary" variant="caption-2">
                        CUSUM {fmtNum(status?.s, 1)} из {String(cfg.h ?? '-')} · z {fmtNum(status?.z)} · медиана {fmtNum(status?.aggregate)} при
                        норме {fmtNum(status?.norm)}
                    </Text>
                </Card>
                <Card view="outlined" className="sw-stat">
                    <Text color="secondary">Свежесть</Text>
                    {a && <Label theme={a.theme} size="m">{a.text}</Label>}
                    <Text color="secondary" variant="caption-2">
                        возраст данных {fmtDuration(status?.age)} · предел {fmtDuration(Number(cfg.stale_after))}
                    </Text>
                </Card>
                <Card view="outlined" className="sw-stat">
                    <Text color="secondary">Доставка</Text>
                    <Label theme={last && (last.since_receipt ?? 99) <= Number(cfg.stale_after) ? 'success' : 'danger'} size="m">
                        {last && (last.since_receipt ?? 99) <= Number(cfg.stale_after) ? 'Поток поступает' : 'Нет сообщений'}
                    </Label>
                    <Text color="secondary" variant="caption-2">
                        принято {last?.accepted ?? 0} · опоздавших {last?.late_count ?? 0} · флаги {status?.flags === 'degraded' ? 'плохие' : 'в норме'}
                    </Text>
                </Card>
                <Card view="outlined" className="sw-stat">
                    <Text color="secondary">Диагностика сигнала</Text>
                    <DiagLabels status={status} />
                    <Text color="secondary" variant="caption-2">
                        шум σ/σ₀ {fmtNum(status?.noise_ratio)} · частота Δt/Δt₀ {fmtNum(status?.rate_ratio)} · режим {status?.mode ?? '-'}
                    </Text>
                </Card>
            </div>

            <Card view="outlined" className="sw-panel">
                <Flex direction="column" gap={3}>
                    <Flex justifyContent="space-between" alignItems="center" wrap gap={2}>
                        <Flex gap={3} wrap>
                            <Checkbox checked={showBaseline} onUpdate={setShowBaseline}>
                                Простой порог для сравнения
                            </Checkbox>
                            {detail.labels.length > 0 && (
                                <Checkbox checked={showLabels} onUpdate={setShowLabels}>
                                    Разметка (монитору не передаётся)
                                </Checkbox>
                            )}
                        </Flex>
                        {detail.kind === 'live' && (
                            <SegmentedRadioGroup
                                value={windowSec}
                                onUpdate={setWindowSec}
                                options={[
                                    {value: '120', content: '2 мин'},
                                    {value: '600', content: '10 мин'},
                                    {value: 'all', content: 'всё'},
                                ]}
                            />
                        )}
                    </Flex>
                    <SensorCharts
                        clock={clock}
                        messages={view.messages}
                        frames={view.frames}
                        incidents={incidents}
                        baseline={baseline}
                        labels={detail.labels}
                        annotations={detail.annotations}
                        unit={detail.unit}
                        h={Number(cfg.h ?? 10)}
                        suspect={Number(cfg.suspect ?? 4.5)}
                        baselineSigma={Number(cfg.baseline_sigma ?? 4.5)}
                        showBaseline={showBaseline}
                        showLabels={showLabels}
                        silentModes={Object.entries(detail.profiles)
                            .filter(([, p]) => !p.assess)
                            .map(([m]) => m)}
                        {...xRange}
                    />
                </Flex>
            </Card>

            <Card view="outlined" className="sw-panel">
                <TabProvider value={tab} onUpdate={setTab}>
                    <TabList>
                        <Tab value="log">Журнал решений</Tab>
                        <Tab value="incidents" counter={incidents.filter((i) => i.open).length || undefined}>
                            Инциденты
                        </Tab>
                        <Tab value="profiles">Эталоны и параметры</Tab>
                        <Tab value="eval">Оценка по разметке</Tab>
                    </TabList>
                    <div className="sw-tab-body">
                        <TabPanel value="log">
                            <EventLog events={events} clock={clock} limit={40} />
                        </TabPanel>
                        <TabPanel value="incidents">
                            <IncidentsTable incidents={incidents} clockOf={() => clock} showSensor={false} />
                        </TabPanel>
                        <TabPanel value="profiles">
                            <ProfilesTab detail={detail} onChanged={load} />
                        </TabPanel>
                        <TabPanel value="eval">
                            <EvaluationTab evaluation={evaluation} labels={detail.labels.length} clock={clock} />
                        </TabPanel>
                    </div>
                </TabProvider>
            </Card>

            {calibrateOpen && (
                <CalibrateDialog
                    detail={detail}
                    now={last?.now ?? null}
                    mode={status?.mode ?? ''}
                    onClose={() => setCalibrateOpen(false)}
                    onDone={() => {
                        setCalibrateOpen(false);
                        load();
                    }}
                />
            )}
        </Flex>
    );
}

function ProfilesTab({detail, onChanged}: {detail: SensorDetail; onChanged: () => void}) {
    const rows = Object.entries(detail.profiles).map(([mode, p]) => ({mode, ...p}));
    const [k, setK] = useState(String(detail.config.k));
    const [h, setH] = useState(String(detail.config.h));
    const [direction, setDirection] = useState(String(detail.config.direction));
    const [staleAfter, setStaleAfter] = useState(String(detail.config.stale_after));
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    return (
        <Flex direction="column" gap={4}>
            <Flex direction="column" gap={2}>
                <Text variant="subheader-2">Эталоны режимов</Text>
                <Text color="secondary">
                    Норма задаётся отдельно для каждого режима датчика. Источник: паспорт, ручная настройка, калибровка по здоровому интервалу или
                    автокалибровка по первым отсчётам режима (медиана и 1.4826·MAD).
                </Text>
                <Table
                    columns={[
                        {id: 'mode', name: 'Режим'},
                        {id: 'mean', name: 'Норма μ', align: 'end', template: (r) => fmtNum(r.mean, 4)},
                        {id: 'sigma', name: 'Шум σ', align: 'end', template: (r) => fmtNum(r.sigma, 4)},
                        {id: 'assess', name: 'Оценивать', template: (r) => (r.assess ? 'да' : 'нет (только свежесть)')},
                        {id: 'source', name: 'Источник'},
                    ]}
                    data={rows}
                    emptyMessage="Эталонов пока нет: монитор копит отсчёты для автокалибровки"
                />
            </Flex>
            <Flex direction="column" gap={2}>
                <Text variant="subheader-2">Параметры монитора</Text>
                <Flex gap={2} wrap alignItems="flex-end">
                    <TextInput label="k" value={k} onUpdate={setK} style={{width: 120}} />
                    <TextInput label="h" value={h} onUpdate={setH} style={{width: 120}} />
                    <TextInput label="Свежесть, с" value={staleAfter} onUpdate={setStaleAfter} style={{width: 150}} />
                    <Select
                        label="Деградация"
                        width={200}
                        value={[direction]}
                        onUpdate={(v) => setDirection(v[0])}
                        options={[
                            {value: 'down', content: 'вниз (score)'},
                            {value: 'up', content: 'вверх'},
                            {value: 'both', content: 'в обе стороны'},
                        ]}
                    />
                    <Button
                        view="action"
                        loading={saving}
                        onClick={async () => {
                            setSaving(true);
                            try {
                                await api.patchSensor(detail.id, {
                                    config: {k: Number(k), h: Number(h), stale_after: Number(staleAfter), direction},
                                });
                                setSaved(true);
                                onChanged();
                            } finally {
                                setSaving(false);
                            }
                        }}
                    >
                        Применить
                    </Button>
                    {saved && <Text color="positive">Применено со следующего тика</Text>}
                </Flex>
                <Table
                    columns={[
                        {id: 'name', name: 'Параметр', template: (r) => <Text variant="code-1">{r.name}</Text>},
                        {id: 'value', name: 'Значение', template: (r) => String(r.value)},
                    ]}
                    data={Object.entries(detail.config).map(([name, value]) => ({name, value}))}
                />
            </Flex>
        </Flex>
    );
}

function EvaluationTab({evaluation, labels, clock}: {evaluation: Evaluation | null; labels: number; clock: 'wall' | 'sim'}) {
    if (!labels) {
        return (
            <Text color="secondary">
                Разметки нет. Загрузите её отдельно: PUT /api/v1/sensors/&lt;id&gt;/labels. Монитор разметку не видит, она нужна только для
                оценки.
            </Text>
        );
    }
    if (!evaluation) return <Loader />;
    return (
        <Flex direction="column" gap={2}>
            <Text color="secondary">
                {evaluation.complete ? 'Итог по всей записи.' : `Промежуточная оценка на ${fmtTime(evaluation.until, clock)}.`} Событий в разметке:{' '}
                {evaluation.labels}. Тревога засчитывается, если открыта не раньше чем за 3 с до начала события и до его конца.
            </Text>
            <MetricsTable monitor={evaluation.monitor} baseline={evaluation.baseline} />
        </Flex>
    );
}

function CalibrateDialog({
    detail,
    now,
    mode,
    onClose,
    onDone,
}: {
    detail: SensorDetail;
    now: number | null;
    mode: string;
    onClose: () => void;
    onDone: () => void;
}) {
    const modes = Array.from(new Set([mode, ...Object.keys(detail.profiles)].filter((m) => m && m !== '-')));
    const [m, setM] = useState(modes[0] ?? 'A');
    const [last, setLast] = useState('60');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    return (
        <Dialog open onClose={onClose} size="s">
            <Dialog.Header caption="Калибровка эталона по здоровому интервалу" />
            <Dialog.Body>
                <Flex direction="column" gap={3}>
                    <Text color="secondary">
                        Норма = медиана, шум = 1.4826·MAD пригодных измерений режима за выбранный интервал. Используйте, когда уверены, что
                        датчик был исправен.
                    </Text>
                    <Select label="Режим" value={[m]} onUpdate={(v) => setM(v[0])} options={modes.map((x) => ({value: x, content: x}))} />
                    <TextInput label="Последние, с" value={last} onUpdate={setLast} type="number" />
                    {error && <Alert theme="danger" message={error} />}
                </Flex>
            </Dialog.Body>
            <Dialog.Footer
                textButtonApply="Откалибровать"
                textButtonCancel="Отмена"
                loading={busy}
                onClickButtonCancel={onClose}
                onClickButtonApply={async () => {
                    setBusy(true);
                    try {
                        await api.calibrate(detail.id, {mode: m, since: now !== null ? now - Number(last) : undefined});
                        onDone();
                    } catch (e) {
                        setError((e as Error).message);
                    } finally {
                        setBusy(false);
                    }
                }}
            />
        </Dialog>
    );
}
