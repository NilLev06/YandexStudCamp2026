import {Alert, Button, Checkbox, DefinitionList, Flex, Label, Loader, Text} from '@gravity-ui/uikit';
import {useCallback, useEffect, useRef, useState} from 'react';

import {api} from '../api/client';
import {saveSimulation} from '../lib/simulationHistory';
import {AlarmNotice} from '../components/AlarmNotice';
import type {SingleAlarmType, SingleReplay, SingleScenario} from '../api/types';
import {LinkedChartsProvider} from '../components/LinkedChart';
import {Page, Panel, Stat} from '../components/Page';
import {SeedField, seedError} from '../components/SeedField';
import {CusumChart} from '../components/charts';
import {SingleCharts} from '../components/SingleCharts';
import {formatNumber, formatTime} from '../lib/format';
import {useMeta} from '../lib/meta';

const STATUS = {
    normal: {text: 'Подтверждённых тревог нет', theme: 'success'},
    suspect: {text: 'Проверка нарушения', theme: 'warning'},
    alarm: {text: 'Тревога', theme: 'danger'},
    unknown: {text: 'Недостаточно данных для оценки', theme: 'unknown'},
} as const;

export function SinglePage() {
    const meta = useMeta();
    const [seed, setSeed] = useState<number | null>(42);
    const [result, setResult] = useState<SingleReplay | null>(null);
    const [position, setPosition] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showMedian, setShowMedian] = useState(false);
    const requestId = useRef(0);
    const load = useCallback(async (scenario: SingleScenario, selectedSeed: number) => {
        const id = ++requestId.current;
        setPlaying(false); setBusy(true); setError(null);
        try {
            const replay = await api.singleReplay({scenario, seed: selectedSeed});
            if (id === requestId.current) {setResult(replay); setPosition(0); saveSimulation(`single:${replay.scenario}`, 'Один датчик · ' + replay.scenarios[replay.scenario], replay);}
        } catch (e) {
            if (id === requestId.current) setError((e as Error).message);
        } finally {
            if (id === requestId.current) setBusy(false);
        }
    }, []);
    useEffect(() => {load('noise', 42); return () => {requestId.current++;};}, [load]);
    useEffect(() => {
        if (!playing || !result) return;
        const timer = window.setInterval(() => setPosition((p) => Math.min(result.duration, p + 1)), 1000 / 6);
        return () => window.clearInterval(timer);
    }, [playing, result]);
    useEffect(() => {if (result && position >= result.duration) setPlaying(false);}, [position, result]);
    const seek = (t: number) => {setPlaying(false); setPosition(t);};
    const frame = result?.frames[position];
    const validSeed = !seedError(seed, meta.seed);
    const state = frame ? STATUS[frame.status] : null;
    const events = result?.events.filter((e) => e.time <= position) ?? [];
    return <LinkedChartsProvider resetKey={`${result?.scenario}:${result?.seed}:${position}`}><Page title="Один датчик" subtitle="Независимые тревоги с объяснениями · синтетическое воспроизведение">
        <Panel title="Сценарий">
            {!result && !error && <Loader />}
            <Flex gap={2} wrap>
                {result && (Object.entries(result.scenarios) as [SingleScenario, string][]).map(([value, label]) =>
                    <Button key={value} selected={result.scenario === value} view={result.scenario === value ? 'outlined-info' : 'outlined'}
                        disabled={busy || !validSeed} onClick={() => load(value, seed!)}>{label}</Button>)}
            </Flex>
            <Flex gap={2} wrap alignItems="flex-end">
                <SeedField value={seed} onUpdate={setSeed} />
                <Button loading={busy} disabled={!validSeed} onClick={() => load(result?.scenario ?? 'noise', seed!)}>Пересчитать</Button>
                <Text color="secondary">{result ? `Показана запись с seed ${result.seed}` : 'Загрузка записи…'}</Text>
            </Flex>
        </Panel>
        {error && <Alert theme="danger" title="Не удалось загрузить сценарий" message={error} />}
        {result && frame && state && <>
            <Panel title="Воспроизведение" extra={<Text color="secondary">6× · {formatTime(position, 'virtual')} / {formatTime(result.duration, 'virtual')}</Text>}>
                <Flex gap={2} wrap alignItems="center">
                    <Button view="action" disabled={busy} onClick={() => {if (position >= result.duration) setPosition(0); setPlaying(!playing);}}>
                        {playing ? 'Пауза' : 'Запустить показ'}
                    </Button>
                    <Button onClick={() => seek(0)}>Сначала</Button>
                    <label className="pair-time-label">Время
                        <input className="pair-time" type="range" aria-label="Время сценария одного датчика" min={0} max={result.duration}
                            value={position} onChange={(e) => seek(Number(e.target.value))} />
                    </label>
                </Flex>
                <Flex gap={1} wrap>
                    {[[48, 'До нарушения'], [96, 'Во время нарушения'], [110, 'Проверка доставки'], [180, 'После восстановления']].map(([time, label]) =>
                        <Button key={time} size="s" onClick={() => seek(Number(time))}>{formatTime(Number(time), 'virtual')} · {label}</Button>)}
                    <Button size="s" onClick={() => seek(result.duration)}>Итог записи</Button>
                </Flex>
            </Panel>
            <Panel title="Решение монитора" extra={<Label theme={state.theme}>{state.text}{frame.alarms.length ? ` · ${frame.alarms.length}` : ''}</Label>}>
                <Text>{frame.comment}</Text>
                {frame.alarms.map((alarm) => <AlarmNotice key={alarm.id} cause={result.alarm_names[alarm.type]} reason={alarm.reason} start={alarm.start} clock="virtual" />)}
            </Panel>
            <div className="grid grid_stats">
                <Stat label="Последнее пригодное значение" value={formatNumber(frame.value)} hint={`Медиана окна: ${formatNumber(frame.aggregate)}`} />
                <Stat label="Возраст пригодного измерения" value={`${formatNumber(frame.age)} с`} hint={`После получения сообщения: ${formatNumber(frame.since_receipt)} с`} />
                <Stat label="CUSUM" value={`${formatNumber(frame.s)} / ${result.config.cusum_h}`} hint={`Разброс за ${result.config.dynamics_window} с: ${formatNumber(frame.spread)}`} />
                <Stat label="Исключено измерений" value={frame.rejected} hint={`Доля непригодных в последнем окне: ${frame.bad_share === null ? '—' : Math.round(frame.bad_share * 100) + '%'}`} />
            </div>
            <Panel title="Измерения датчика" extra={<Flex gap={2} wrap>
                <Checkbox checked={showMedian} onUpdate={setShowMedian}>Медиана окна</Checkbox>
            </Flex>}>
                <SingleCharts replay={result} position={position} showMedian={showMedian} />
                <Text variant="caption-2" color="secondary">Синяя линия включает непригодные и поздние сообщения. Они не участвуют в оценке уровня и разброса.
                    Красный фон — периоды тревог. После подтверждения восстановления оба нормальных окна не закрашиваются.</Text>
            </Panel>
            <Panel title="Накопление отклонений (CUSUM)">
                <div className="replay-chart">
                    <CusumChart frames={result.frames.filter((f) => f.now <= position)} clock="virtual"
                        h={result.config.cusum_h} suspect={result.config.cusum_suspect} height={220} />
                </div>
                <Text variant="caption-2" color="secondary">Медиана окна 3 с → нормирование по эталону режима → ограниченный вклад → накопление.
                    Показан максимум накопителей снижения и повышения уровня. Шум и другие нарушения проверяются независимо.</Text>
            </Panel>
            <Panel title="Журнал тревог и объяснений">
                {!events.length && <Text color="secondary">Событий пока нет. Одиночный скачок исключается из анализа; высокая доля непригодных точек вызывает отдельную тревогу.</Text>}
                <Flex direction="column" gap={3}>
                    {[...events].reverse().map((event, i) => <Flex key={i} direction="column" gap={1}>
                        <Flex gap={2} wrap><Text color="secondary">{formatTime(event.time, 'virtual')}</Text>
                            <Label theme={event.kind === 'close' ? 'success' : event.kind === 'mode' ? 'info' : 'danger'}>
                                {event.kind === 'close' ? 'Восстановление' : event.kind === 'mode' ? 'Смена режима' : 'Тревога'}
                                {event.type !== 'info' && ` · ${result.alarm_names[event.type as SingleAlarmType]}`}
                            </Label>
                        </Flex><Text>{event.text}</Text>
                    </Flex>)}
                </Flex>
            </Panel>
            <Panel title="Условия срабатывания">
                <DefinitionList direction="vertical">
                    <DefinitionList.Item name="Отклонение уровня">CUSUM ≥ {result.config.cusum_h} и отклонение в одном текущем окне {result.config.window} с; контроль в обе стороны.</DefinitionList.Item>
                    <DefinitionList.Item name="Повышенный разброс">Стандартное отклонение за {result.config.dynamics_window} с выше {result.config.noise_ratio} σ; достаточно {result.config.noise_confirm} полного окна.</DefinitionList.Item>
                    <DefinitionList.Item name="Подозрение на залипание">Размах ниже {result.config.min_spread} за {result.config.dynamics_window} с; достаточно одного полного окна.</DefinitionList.Item>
                    <DefinitionList.Item name="Насыщение">Не менее {result.config.saturation_share * 100}% пригодных точек у границ [{result.config.range_min}, {result.config.range_max}]; одно окно {result.config.dynamics_window} с.</DefinitionList.Item>
                    <DefinitionList.Item name="Непригодные измерения">Не менее {result.config.bad_share * 100}% в окне {result.config.window} с: плохой флаг, значение вне диапазона или скорость выше {result.config.max_rate} ед/с.</DefinitionList.Item>
                    <DefinitionList.Item name="Снижение частоты">При ненулевом потоке менее {result.config.min_coverage * 100}% ожидаемых отсчётов; период {result.config.expected_period} с; одно окно {result.config.dynamics_window} с.</DefinitionList.Item>
                    <DefinitionList.Item name="Старые сообщения">Не менее {result.config.late_share * 100}% сообщений старше {result.config.lateness} с; одно окно {result.config.dynamics_window} с.</DefinitionList.Item>
                    <DefinitionList.Item name="Свежесть">Возраст пригодного измерения больше {result.config.max_age} с; восстановление по {result.config.fresh_recover} окнам подряд по {result.config.window} с с минимум {result.config.fresh_confirm} новыми свежими измерениями.</DefinitionList.Item>
                    <DefinitionList.Item name="Восстановление">Для непригодных измерений — {result.config.invalid_recover} нормальных окна подряд по {result.config.window} с; они не закрашиваются после подтверждения.
                        Для CUSUM — {result.config.level_recover} нормальных окна подряд по {result.config.window} с и сброс накопления; они также не закрашиваются после подтверждения.
                        Для остальных оконных проверок — {result.config.recover} нормальных окна подряд по {result.config.dynamics_window} с.
                        Пропуск и старые сообщения не закрывают тревогу.</DefinitionList.Item>
                </DefinitionList>
                <Text color="secondary">Пороговые значения заданы для этого профиля. Для другого датчика нужны свои диапазон, частота, норма и допустимая скорость.
                    Если постоянный сигнал допустим, контроль залипания отключают. По одному каналу нельзя надёжно отличить неисправность датчика от изменения процесса;
                    смещение нуля, ошибка масштаба и квантование не классифицируются отдельно. Новые правила работают в этом воспроизведении; в live-поток gateway они пока не подключены.</Text>
            </Panel>
        </>}
    </Page></LinkedChartsProvider>;
}
