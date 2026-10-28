// Простой режим: одна страница. Выбираешь группу ошибок (как в документе) -> смотришь, как монитор решает.
import {useCallback, useEffect, useMemo, useState} from 'react';
import {Button, Card, Flex, Icon, Label, Loader, SegmentedRadioGroup, Slider, Switch, Text, Tooltip} from '@gravity-ui/uikit';
import {ArrowRotateLeft, Pause, Play} from '@gravity-ui/icons';

import {api} from '../api/client';
import {useSensors, useTicks} from '../api/live';
import type {TickListener} from '../api/live';
import type {Frame, Incident, Message, MonitorEvent, RunResult, SensorDetail} from '../api/types';
import {SimpleChart} from '../components/SimpleChart';
import {DOC_URL, GROUPS, groupById} from '../groups';
import type {Group, Variant} from '../groups';
import {INCIDENT, fmtDuration, fmtNum, fmtTime} from '../utils/format';
import {narrate, summarize} from '../utils/narrate';
import type {Tone} from '../utils/narrate';

type Pick = number | 'all';
const ALL = {id: 'all' as const, title: 'Всё подряд', what: 'Выброс → дрейф → пропуск со старой пачкой → смена режима', scenario: 'combined'};

const DRONE_CHANNELS: {id: string; label: string}[] = [
    {id: 'mavic.motor3', label: 'Мотор 3'},
    {id: 'mavic.motor1', label: 'Мотор 1'},
    {id: 'mavic.mag', label: 'Компас'},
    {id: 'mavic.vib', label: 'Вибрация'},
    {id: 'mavic.gyro', label: 'Гироскоп'},
];

const UNITS: Record<string, string> = {pair: '°C (y2 - y1)', gain: 'изм./зад.'};

interface View {
    clock: 'sim' | 'wall';
    messages: Message[];
    frames: Frame[];
    incidents: {type: string; start: number; end: number | null; id?: string}[];
    events: MonitorEvent[];
    baseline: RunResult['baseline'];
    labels: RunResult['truth'];
    recent: Message[];
    h: number;
    staleAfter: number;
    unit: string | null;
}

// ------------------------------------------------------------------ сценарий: прогон + воспроизведение
function useReplay(scenario: string | null) {
    const [run, setRun] = useState<RunResult | null>(null);
    const [t, setT] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState('6');

    useEffect(() => {
        if (!scenario) return;
        let alive = true;
        setRun(null);
        api.run(scenario, 42).then((r) => {
            if (!alive) return;
            setRun(r);
            setT(0);
            setPlaying(true);
        });
        return () => {
            alive = false;
        };
    }, [scenario]);

    useEffect(() => {
        if (!playing || !run) return undefined;
        const id = window.setInterval(() => {
            setT((prev) => {
                const next = prev + Number(speed) / 10;
                if (next >= run.duration) {
                    setPlaying(false);
                    return run.duration;
                }
                return next;
            });
        }, 100);
        return () => window.clearInterval(id);
    }, [playing, run, speed]);

    const view = useMemo<View | null>(() => {
        if (!run) return null;
        const now = Math.floor(t);
        const messages = run.messages.filter((m) => m.received_at <= now);
        return {
            clock: 'sim',
            messages,
            frames: run.frames.filter((f) => f.now <= now),
            incidents: run.incidents.filter((i) => i.start <= now).map((i) => ({...i, end: i.end !== null && i.end <= now ? i.end : null})),
            events: run.events.filter((e) => e.time <= now),
            baseline: run.baseline.filter((b) => b.start <= now),
            labels: run.truth,
            recent: messages.filter((m) => now - m.received_at <= 3),
            h: Number(run.config.h),
            staleAfter: Number(run.config.stale_after),
            unit: UNITS[run.scenario] ?? 'score',
        };
    }, [run, t]);

    return {run, t, setT, playing, setPlaying, speed, setSpeed, view};
}

// ------------------------------------------------------------------ живой датчик (дрон)
function useLiveSensor(id: string | null) {
    const [detail, setDetail] = useState<SensorDetail | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [frames, setFrames] = useState<Frame[]>([]);
    const [events, setEvents] = useState<MonitorEvent[]>([]);
    const [incidents, setIncidents] = useState<Incident[]>([]);

    useEffect(() => {
        if (!id) return;
        let alive = true;
        Promise.all([api.sensor(id), api.series(id, 3000)])
            .then(([d, s]) => {
                if (!alive) return;
                setDetail(d);
                setMessages(s.messages);
                setFrames(s.frames);
                setEvents(s.events);
                setIncidents(s.incidents);
            })
            .catch(() => setDetail(null));
        return () => {
            alive = false;
        };
    }, [id]);

    const onTick = useCallback<TickListener>(({frame, messages: m, events: ev, incidents: inc}) => {
        setFrames((p) => [...p.slice(-3000), frame]);
        if (m.length) setMessages((p) => [...p.slice(-3000), ...m]);
        if (ev.length) setEvents((p) => [...p, ...ev]);
        if (inc.length)
            setIncidents((p) => {
                const map = new Map(p.map((i) => [i.id, i]));
                inc.forEach((i) => map.set(i.id, i));
                return [...map.values()];
            });
    }, []);
    useTicks(id ?? undefined, onTick);

    const view = useMemo<View | null>(() => {
        if (!detail) return null;
        const now = frames.at(-1)?.now ?? 0;
        const lo = now - 120;    // последние 2 минуты
        return {
            clock: detail.clock,
            messages: messages.filter((x) => x.event_time >= lo),
            frames: frames.filter((f) => f.now >= lo),
            incidents,
            events,
            baseline: [],
            labels: detail.labels,
            recent: messages.filter((x) => now - x.received_at <= 3),
            h: Number(detail.config.h),
            staleAfter: Number(detail.config.stale_after),
            unit: detail.unit,
        };
    }, [detail, messages, frames, events, incidents]);
    return {view, detail};
}

// ------------------------------------------------------------------ страница
export function DemoPage() {
    const [pick, setPick] = useState<Pick>(2);
    const [vi, setVi] = useState(0);              // какой случай группы показываем
    const [channel, setChannel] = useState('mavic.motor3');
    const [showBaseline, setShowBaseline] = useState(false);
    const sensors = useSensors();
    const droneOnline = sensors.some((s) => s.id.startsWith('mavic.'));

    const group = pick === 'all' ? undefined : groupById(pick);
    const variant: Variant | undefined = group?.variants[Math.min(vi, (group?.variants.length ?? 1) - 1)];
    const isLive = !!variant?.live;
    const scenario = pick === 'all' ? ALL.scenario : variant?.scenario ?? null;
    const choose = (id: Pick) => {
        setPick(id);
        // группа 7: если дрон не подключён, сразу показываем сценарий двух датчиков
        const g = id === 'all' ? undefined : groupById(id);
        setVi(g?.variants[0]?.live && !droneOnline ? 1 : 0);
    };
    const replay = useReplay(isLive ? null : scenario);
    const live = useLiveSensor(isLive && droneOnline ? channel : null);
    const view = isLive ? live.view : replay.view;

    const finished = !isLive && !!replay.run && replay.t >= replay.run.duration;
    const narration = finished && replay.run
        ? summarize(replay.run)
        : view
        ? narrate({frames: view.frames, events: view.events, recent: view.recent, h: view.h, staleAfter: view.staleAfter, started: true})
        : narrate({frames: [], events: [], recent: [], h: 10, staleAfter: 6, started: false});
    const focusGroup = group ?? groupById(narration.group);

    return (
        <Flex direction="column" gap={4} className="sw-demo">
            <Flex direction="column" gap={1}>
                <Text variant="display-1">Устойчивая деградация - тревога. Случайный скачок - нет.</Text>
                <Text color="secondary" variant="body-2">
                    Выберите группу ошибок из документа. Монитор видит только поток измерений и объясняет каждое решение.
                </Text>
            </Flex>

            <div className="sw-groups">
                {GROUPS.map((g) => (
                    <GroupCard
                        key={g.id}
                        g={g}
                        active={pick === g.id}
                        disabled={false}
                        onClick={() => choose(g.id)}
                    />
                ))}
                <Card
                    view={pick === 'all' ? 'outlined' : 'raised'}
                    type="selection"
                    selected={pick === 'all'}
                    onClick={() => choose('all')}
                    className="sw-group-card"
                >
                    <Flex direction="column" gap={1}>
                        <Flex gap={2} alignItems="center">
                            <span className="sw-group-num sw-group-num_all">1-4</span>
                            <Text variant="subheader-2">{ALL.title}</Text>
                        </Flex>
                        <Text color="secondary" variant="caption-2">{ALL.what}</Text>
                    </Flex>
                </Card>
            </div>

            {group && group.variants.length > 1 && (
                <Flex gap={2} alignItems="center" wrap>
                    <Text color="secondary">Случай из документа:</Text>
                    <SegmentedRadioGroup
                        value={String(group.variants.indexOf(variant as Variant))}
                        onUpdate={(v) => setVi(Number(v))}
                        options={group.variants.map((v, i) => ({value: String(i), content: `${v.cases} · ${v.label}`}))}
                    />
                </Flex>
            )}
            {isLive && !droneOnline && (
                <Card view="filled" theme="warning" className="sw-panel">
                    <Text>
                        Дрон не подключён. Запустите <code>start_demo.bat</code> (или <code>python start_demo.py</code>): он поднимет шлюз, мост,
                        бортовой монитор и Webots.
                    </Text>
                </Card>
            )}

            {(isLive ? droneOnline : true) && (
                <div className="sw-demo-main">
                    <Flex direction="column" gap={3} style={{minWidth: 0}}>
                        <Card view="outlined" className="sw-panel">
                            <Flex direction="column" gap={2}>
                                {isLive ? (
                                    <Flex gap={2} alignItems="center" wrap>
                                        <Label theme="info" size="m">живой поток с дрона</Label>
                                        <SegmentedRadioGroup
                                            value={channel}
                                            onUpdate={setChannel}
                                            options={DRONE_CHANNELS.map((c) => ({value: c.id, content: c.label}))}
                                        />
                                    </Flex>
                                ) : (
                                    <Player replay={replay} />
                                )}
                                {view ? (
                                    <SimpleChart
                                        clock={view.clock}
                                        messages={view.messages}
                                        frames={view.frames}
                                        incidents={view.incidents}
                                        labels={view.labels}
                                        baseline={view.baseline}
                                        showBaseline={showBaseline}
                                        unit={view.unit}
                                        silentModes={isLive && live.detail ? Object.entries(live.detail.profiles).filter(([, pr]) => !pr.assess).map(([m]) => m) : []}
                                        xMin={!isLive && replay.run ? 0 : undefined}
                                        xMax={!isLive && replay.run ? replay.run.duration : undefined}
                                    />
                                ) : (
                                    <Loader size="l" className="sw-loader" />
                                )}
                                <Flex gap={4} wrap alignItems="center">
                                    <Legend color="rgba(255, 61, 100, 0.35)" text="тревога монитора" />
                                    <Legend color="rgba(255, 190, 92, 0.5)" text="нет свежих данных" />
                                    <Legend color="rgba(31,104,169,0.6)" text="разметка: где ошибка была на самом деле (монитор её не видит)" thin />
                                    {!isLive && (
                                        <Switch checked={showBaseline} onUpdate={setShowBaseline} size="m">
                                            Сравнить с простым порогом
                                        </Switch>
                                    )}
                                </Flex>
                            </Flex>
                        </Card>

                        <NarrationBox text={narration.text} tone={narration.tone} group={narration.group} />

                        {view && <IncidentStrip view={view} group={group?.id} />}

                        {!isLive && replay.run && replay.t >= replay.run.duration && (
                            <ResultCard run={replay.run} showBaseline={() => setShowBaseline(true)} />
                        )}
                    </Flex>

                    <Flex direction="column" gap={3}>
                        <Lights frame={view?.frames.at(-1)} h={view?.h ?? 10} staleAfter={view?.staleAfter ?? 6} />
                        {focusGroup && <GroupInfo g={focusGroup} variant={focusGroup === group ? variant : undefined} />}
                    </Flex>
                </div>
            )}
        </Flex>
    );
}

// ------------------------------------------------------------------ части страницы
function GroupCard({g, active, disabled, onClick}: {g: Group; active: boolean; disabled: boolean; onClick: () => void}) {
    const card = (
        <Card
            view={active ? 'outlined' : 'raised'}
            type="selection"
            selected={active}
            disabled={disabled}
            onClick={onClick}
            className="sw-group-card"
        >
            <Flex direction="column" gap={1}>
                <Flex gap={2} alignItems="center">
                    <span className={`sw-group-num ${g.required ? '' : 'sw-group-num_ext'}`}>{g.id}</span>
                    <Text variant="subheader-2">{g.title}</Text>
                </Flex>
                <Text color="secondary" variant="caption-2">{g.what}</Text>
                <Text color="hint" variant="caption-1">{g.live ? 'живой дрон' : g.required ? 'требует кейс' : 'расширение'}</Text>
            </Flex>
        </Card>
    );
    return disabled ? <Tooltip content="Нужен дрон: запустите start_demo.bat">{<span>{card}</span>}</Tooltip> : card;
}

function Player({replay}: {replay: ReturnType<typeof useReplay>}) {
    const {run, t, setT, playing, setPlaying, speed, setSpeed} = replay;
    if (!run) return <Loader size="s" />;
    return (
        <Flex direction="column" gap={1}>
            <Flex gap={2} alignItems="center" wrap>
                <Button
                    view="action"
                    size="l"
                    onClick={() => {
                        if (t >= run.duration) setT(0);
                        setPlaying(!playing);
                    }}
                >
                    <Icon data={playing ? Pause : Play} size={16} />
                    {playing ? 'Пауза' : t >= run.duration ? 'Ещё раз' : 'Смотреть'}
                </Button>
                <Button
                    view="outlined"
                    size="l"
                    onClick={() => {
                        setT(0);
                        setPlaying(true);
                    }}
                >
                    <Icon data={ArrowRotateLeft} size={16} />
                    Сначала
                </Button>
                <SegmentedRadioGroup
                    size="l"
                    value={speed}
                    onUpdate={setSpeed}
                    options={['3', '6', '12'].map((v) => ({value: v, content: `${v}×`}))}
                />
                <Text variant="code-2" color="secondary">
                    {fmtTime(t, 'sim')} / {fmtTime(run.duration, 'sim')}
                </Text>
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
        </Flex>
    );
}

function Legend({color, text, thin}: {color: string; text: string; thin?: boolean}) {
    return (
        <Flex gap={1} alignItems="center">
            <span style={{width: 18, height: thin ? 4 : 12, background: color, borderRadius: 2, display: 'inline-block'}} />
            <Text variant="caption-2" color="secondary">{text}</Text>
        </Flex>
    );
}

const TONE_CLASS: Record<Tone, string> = {info: 'sw-say_info', success: 'sw-say_ok', warning: 'sw-say_warn', danger: 'sw-say_bad'};

function NarrationBox({text, tone, group}: {text: string; tone: Tone; group?: number}) {
    return (
        <div className={`sw-say ${TONE_CLASS[tone]}`}>
            <Flex gap={3} alignItems="center">
                {group && <span className="sw-group-num">{group}</span>}
                <Text variant="subheader-3" className="sw-say-text">{text}</Text>
            </Flex>
        </div>
    );
}

type LightState = 'ok' | 'warn' | 'bad' | 'off';

function Light({title, state, value, caption}: {title: string; state: LightState; value: string; caption: string}) {
    return (
        <Flex gap={3} alignItems="center" className="sw-light">
            <span className={`sw-lamp sw-lamp_${state}`} />
            <Flex direction="column">
                <Text color="secondary" variant="caption-2">{title}</Text>
                <Text variant="subheader-2">{value}</Text>
                <Text color="secondary" variant="caption-2">{caption}</Text>
            </Flex>
        </Flex>
    );
}

function Lights({frame, h, staleAfter}: {frame?: Frame; h: number; staleAfter: number}) {
    const diag = frame?.diagnostics ?? {stuck: 'ok', noise: 'ok', rate: 'ok'};
    let q: [LightState, string] = ['off', 'нет оценки'];
    if (frame) {
        if (frame.quality === 'alarm') q = ['bad', 'деградация'];
        else if (diag.stuck === 'alarm') q = ['bad', 'датчик замер'];
        else if (diag.noise === 'alarm') q = ['warn', 'шум вырос'];
        else if (frame.quality === 'suspect') q = ['warn', 'подозрение'];
        else if (frame.quality === 'normal') q = ['ok', 'норма'];
    }
    const a: [LightState, string] = !frame || frame.availability === 'unknown' ? ['off', 'нет данных'] : frame.availability === 'stale' ? ['bad', 'данные устарели'] : ['ok', 'данные свежие'];
    const flowing = frame && (frame.since_receipt ?? 99) <= staleAfter;
    const s = frame?.s ?? 0;
    return (
        <Card view="outlined" className="sw-panel">
            <Flex direction="column" gap={3}>
                <Light
                    title="Качество"
                    state={q[0]}
                    value={q[1]}
                    caption={frame?.quality === 'unknown' ? `режим ${frame.mode}: качество не оцениваем` : `медиана ${fmtNum(frame?.aggregate, 2)} при норме ${fmtNum(frame?.norm, 2)}`}
                />
                <Flex direction="column" gap={1} className="sw-cusum">
                    <Flex justifyContent="space-between">
                        <Text variant="caption-2" color="secondary">накопление CUSUM</Text>
                        <Text variant="caption-2">
                            {fmtNum(s, 1)} из {h}
                        </Text>
                    </Flex>
                    <div className="sw-bar">
                        <div
                            className={`sw-bar-fill ${s >= h ? 'sw-bar-fill_bad' : s > h * 0.45 ? 'sw-bar-fill_warn' : ''}`}
                            style={{width: `${Math.min(100, (s / h) * 100)}%`}}
                        />
                    </div>
                </Flex>
                <Light
                    title="Свежесть"
                    state={a[0]}
                    value={a[1]}
                    caption={frame?.age !== null && frame?.age !== undefined ? `последний отсчёт ${fmtDuration(frame.age)} назад, предел ${staleAfter} с` : '-'}
                />
                <Light
                    title="Доставка"
                    state={!frame ? 'off' : flowing ? 'ok' : 'bad'}
                    value={!frame ? '-' : flowing ? 'поток идёт' : 'сообщений нет'}
                    caption={frame ? `принято ${frame.accepted ?? 0}, старых ${frame.late_count ?? 0}` : '-'}
                />
            </Flex>
        </Card>
    );
}

function GroupInfo({g, variant}: {g: Group; variant?: Variant}) {
    return (
        <Card view="filled" className="sw-panel">
            <Flex direction="column" gap={2}>
                <Flex gap={2} alignItems="center">
                    <span className={`sw-group-num ${g.required ? '' : 'sw-group-num_ext'}`}>{g.id}</span>
                    <Text variant="subheader-2">Группа {g.id} в документе: {g.title}</Text>
                </Flex>
                <Text color="secondary" variant="caption-2">случаи {g.cases} · {g.required ? 'требует кейс' : 'наше расширение'}</Text>
                <Text>{g.what}.</Text>
                <Text variant="caption-2" color="secondary">Чем ловим</Text>
                <Text>{g.detector}</Text>
                <code className="sw-formula">{g.formula}</code>
                {variant && (
                    <>
                        <Text variant="caption-2" color="secondary">
                            Случай {variant.cases} · {variant.label}: как его видит детектор группы
                        </Text>
                        <Text>{variant.how}</Text>
                    </>
                )}
                <Text variant="caption-2" color="secondary">Реакция</Text>
                <Text>{g.reaction}</Text>
                <Button view="outlined" href={DOC_URL} target="_blank">
                    Открыть документ
                </Button>
            </Flex>
        </Card>
    );
}

function IncidentStrip({view, group}: {view: View; group?: number}) {
    const list = [...view.incidents].sort((a, b) => a.start - b.start);
    return (
        <Card view="outlined" className="sw-panel">
            <Flex direction="column" gap={2}>
                <Text variant="subheader-2">Решения монитора</Text>
                {!list.length && <Text color="secondary">Тревог нет.</Text>}
                {list.map((i, k) => {
                    const base = INCIDENT[i.type as keyof typeof INCIDENT];
                    // В группе 7 CUSUM смотрит на невязку двух источников: это расхождение, а не деградация одного датчика
                    const info = group === 7 && i.type === 'quality' && base ? {...base, text: 'Расхождение источников · гр. 7'} : base;
                    return (
                        <Flex key={i.id ?? k} gap={2} alignItems="center" wrap>
                            <Text color={i.end === null ? 'danger' : 'positive'}>{i.end === null ? '●' : '✓'}</Text>
                            <Text variant="code-1" color="secondary">
                                {fmtTime(i.start, view.clock)}
                                {i.end !== null ? ` - ${fmtTime(i.end, view.clock)}` : ''}
                            </Text>
                            <Label theme={info?.theme ?? 'normal'} size="xs">{info?.text ?? i.type}</Label>
                            <Text color="secondary" variant="caption-2">
                                {i.end === null ? 'идёт' : `длилась ${fmtDuration(i.end - i.start)}`}
                            </Text>
                        </Flex>
                    );
                })}
            </Flex>
        </Card>
    );
}

function ResultCard({run, showBaseline}: {run: RunResult; showBaseline: () => void}) {
    const m = run.metrics.monitor;
    const b = run.metrics.baseline;
    const thresholdHits = run.baseline.filter((x) => x.type === 'quality').length;
    return (
        <Card view="filled" theme={m.false_alarms ? 'warning' : 'success'} className="sw-panel">
            <Flex direction="column" gap={2}>
                <Text variant="subheader-3">Итог: сравнение с разметкой</Text>
                <Text>
                    <b>Монитор:</b>{' '}
                    {m.total ? `нашёл ${m.detected} из ${m.total}` : 'ошибок в разметке нет'}, ложных тревог {m.false_alarms}
                    {m.delay !== null ? `, задержка ${fmtDuration(m.delay)}` : ''}.
                </Text>
                <Text>
                    <b>Простой порог:</b> {b.total ? `нашёл ${b.detected} из ${b.total}` : 'ошибок в разметке нет'}, ложных {b.false_alarms}, всего
                    срабатываний {thresholdHits}.
                </Text>
                <Flex>
                    <Button view="outlined" onClick={showBaseline}>
                        Показать порог на графике
                    </Button>
                </Flex>
            </Flex>
        </Card>
    );
}
