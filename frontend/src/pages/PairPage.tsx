import {Alert, Button, Flex, Label, Loader, SegmentedRadioGroup, Text} from '@gravity-ui/uikit';
import {useCallback, useEffect, useRef, useState} from 'react';

import {api} from '../api/client';
import {saveSimulation} from '../lib/simulationHistory';
import {AlarmNotice} from '../components/AlarmNotice';
import type {PairReplay, PairScenario} from '../api/types';
import {LinkedChartsProvider} from '../components/LinkedChart';
import {Page, Panel, Stat} from '../components/Page';
import {PairCharts} from '../components/PairCharts';
import {SeedField, seedError} from '../components/SeedField';
import {formatNumber, formatTime} from '../lib/format';
import {useMeta} from '../lib/meta';

const SCENARIOS: [PairScenario, string][] = [
    ['drift', 'Дрейф одного датчика'], ['dual_drift', 'Дрейф двух датчиков'], ['normal', 'Нормальная работа'],
    ['spike', 'Одиночный выброс'], ['gap', 'Пропуск и старая пачка'],
];
const STATUS = {
    recovering: {text: 'Подтверждение восстановления', theme: 'warning'},
    normal: {text: 'Показания согласованы', theme: 'success'},
    suspect: {text: 'Подозрение на расхождение', theme: 'warning'},
    alarm: {text: 'Тревога: расхождение датчиков', theme: 'danger'},
    unavailable: {text: 'Сравнение недоступно', theme: 'unknown'},
} as const;

export function PairPage() {
    const meta = useMeta();
    const [sensorCount, setSensorCount] = useState<2 | 3>(2);
    const [seed, setSeed] = useState<number | null>(42);
    const [result, setResult] = useState<PairReplay | null>(null);
    const [position, setPosition] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const requestId = useRef(0);
    const load = useCallback(async (scenario: PairScenario, selectedSeed: number, count: 2 | 3 = 2) => {
        const id = ++requestId.current;
        setPlaying(false); setBusy(true); setError(null); setResult(null);
        try {
            const replay = await api.pairReplay({scenario, seed: selectedSeed, sensor_count: count});
            if (id === requestId.current) {setResult(replay); setPosition(0); saveSimulation(`${count === 3 ? 'triple' : 'pair'}:${replay.scenario}`, `${count} датчика · ` + (SCENARIOS.find(([value]) => value === replay.scenario)?.[1] ?? replay.scenario), replay);}
        } catch (e) {
            if (id === requestId.current) setError((e as Error).message);
        } finally {
            if (id === requestId.current) setBusy(false);
        }
    }, []);
    useEffect(() => {load('drift', 42); return () => {requestId.current++;};}, [load]);
    useEffect(() => {
        if (!playing || !result) return;
        const timer = window.setInterval(() => setPosition((p) => Math.min(result.duration, p + 1)), 1000 / 6);
        return () => window.clearInterval(timer);
    }, [playing, result]);
    useEffect(() => {if (result && position >= result.duration) setPlaying(false);}, [position, result]);
    const seek = (t: number) => {setPlaying(false); setPosition(t);};
    const validSeed = !seedError(seed, meta.seed);
    const frame = result?.frames[position];
    const activeAlarms = result?.incidents.filter((i) => i.start <= position && (i.end === null || i.end > position)) ?? [];
    const state = activeAlarms.length ? {text: 'Тревога', theme: 'danger' as const} : frame ? STATUS[frame.status] : null;
    const visibleEvents = result?.events.filter((e) => e.time <= position) ?? [];
    return (
        <LinkedChartsProvider resetKey={`${result?.sensor_count}:${result?.scenario}:${result?.seed}:${position}`}><Page title="Несколько датчиков" subtitle="Сравнение двух или трёх источников одной температуры · симуляция">
            <Panel title="Количество датчиков">
                <SegmentedRadioGroup value={String(sensorCount)} disabled={busy || !validSeed} onUpdate={(value) => {
                    const count = Number(value) as 2 | 3;
                    setSensorCount(count);
                    load(count === 2 && result?.scenario === 'dual_drift' ? 'drift' : result?.scenario ?? 'drift', seed!, count);
                }} options={[{value: '2', content: '2 датчика'}, {value: '3', content: '3 датчика'}]} />
                <Text color="secondary">{sensorCount === 2 ? 'Одна пара A–B. Расхождение не определяет виновный источник.' :
                    'Три пары A–B, A–C и B–C. Согласованная пара помогает предположить, какой источник отличается.'}</Text>
            </Panel>
            <Panel title="Сценарий">
                <Flex gap={2} wrap>
                    {SCENARIOS.filter(([value]) => sensorCount === 3 || value !== 'dual_drift').map(([value, label]) => <Button key={value} selected={result?.scenario === value} view={result?.scenario === value ? 'outlined-info' : 'outlined'}
                        disabled={busy || !validSeed} onClick={() => load(value, seed!, sensorCount)}>{label}</Button>)}
                </Flex>
                {result?.scenario === 'dual_drift' && <Alert theme="info" title="В этом примере дрейфуют B и C"
                    message="B и C смещаются вместе, A остаётся нормальным. Поэтому согласованное большинство может ошибочно указать на A. Без независимого эталона нельзя доказать, какие источники неисправны." />}
                <Flex gap={2} wrap alignItems="flex-end" style={{marginTop: 16}}>
                    <SeedField value={seed} onUpdate={setSeed} />
                    <Button loading={busy} disabled={!validSeed} onClick={() => load(result?.scenario ?? 'drift', seed!, sensorCount)}>Пересчитать</Button>
                    <Text color="secondary">{result ? `Показана запись с seed ${result.seed}` : 'Загрузка записи…'}</Text>
                </Flex>
            </Panel>
            {error && <Alert theme="danger" title="Не удалось загрузить сценарий" message={error} />}
            {!result && !error && <Loader />}
            {result && frame && state && <>
                <Panel title="Воспроизведение" extra={<Text color="secondary">6× · {formatTime(position, 'virtual')} / {formatTime(result.duration, 'virtual')}</Text>}>
                    <Flex gap={2} wrap alignItems="center">
                        <Button view="action" disabled={busy} onClick={() => {if (position >= result.duration) setPosition(0); setPlaying(!playing);}}>
                            {playing ? 'Пауза' : 'Запустить показ'}
                        </Button>
                        <Button onClick={() => seek(0)}>Сначала</Button>
                        <label className="pair-time-label">Время
                            <input className="pair-time" type="range" aria-label="Время сценария нескольких датчиков" min={0} max={result.duration} value={position}
                                onChange={(e) => seek(Number(e.target.value))} />
                        </label>
                    </Flex>
                    <Flex gap={1} wrap style={{marginTop: 12}}>
                        {((result.scenario === 'drift' || result.scenario === 'dual_drift') ? [[50, 'Общая динамика'], [90, 'Расхождение'], [145, 'Восстановление']]
                            : result.scenario === 'gap' ? [[80, 'Потеря данных'], [100, 'Старая пачка'], [120, 'Свежие пары']]
                            : result.scenario === 'spike' ? [[80, 'Выброс'], [90, 'После выброса']]
                            : [[50, 'Общее изменение'], [145, 'Нормальная работа']]).map(([time, label]) =>
                            <Button key={time} size="s" onClick={() => seek(Number(time))}>{formatTime(Number(time), 'virtual')} · {label}</Button>)}
                        <Button size="s" onClick={() => seek(result.duration)}>Итог записи</Button>
                    </Flex>
                </Panel>
                <Panel title="Решение монитора" extra={<Label theme={state.theme}>{state.text}</Label>}>
                    <Text>{frame.comment}</Text>
                    {activeAlarms.map((alarm) => <AlarmNotice key={alarm.id} reason={alarm.reason} start={alarm.start} clock="virtual" />)}
                    {(frame.status === 'unavailable' || frame.status === 'recovering') && frame.comparison_alarm_open &&
                        <Alert theme="warning" title="Инцидент расхождения остаётся открытым" message="Пропуск данных не доказывает восстановление согласованности." />}
                </Panel>
                <div className="grid grid_stats">
                    <Stat label="Датчик A" value={`${formatNumber(frame.a)} °C`} hint={`Возраст: ${formatNumber(frame.age_a)} с`} />
                    <Stat label="Датчик B" value={`${formatNumber(frame.b)} °C`} hint={`Возраст: ${formatNumber(frame.age_b)} с`} />
                    {result.sensor_count === 3 && <Stat label="Датчик C" value={`${formatNumber(frame.c)} °C`} hint={`Возраст: ${formatNumber(frame.age_c)} с`} />}
                    <Stat label={result.sensor_count === 3 ? 'Максимальное расхождение' : 'Разница |A − B|'} value={frame.difference === null ? 'Нет оценки' : `${formatNumber(frame.difference)} °C`}
                        hint={`Порог: ${result.config.threshold} °C · окно ${result.config.window} с · новых пар подряд: ${frame.bad_run}`}
                        tone={frame.status === 'alarm' ? 'danger' : undefined} />
                </div>
                <Panel title={`Одна величина — ${result.sensor_count} датчика`}>
                    <PairCharts replay={result} position={position} />
                    <Text variant="caption-2" color="secondary">{result.scenario === 'dual_drift' ? 'В симуляции дрейфуют B и C, источник A остаётся нормальным. Монитор не получает эту разметку.' : result.scenario === 'normal' ? 'Все источники измеряют общую температуру, неисправностей в этом сценарии нет.' : 'Все датчики видят общие изменения температуры. В этом сценарии нарушение внесено только в B; монитор не получает эту разметку.'}</Text>
                </Panel>
                <Panel title="Расхождение и пороги">
                    <PairCharts replay={result} position={position} difference />
                </Panel>
                <Panel title="Журнал тревог и объяснений">
                    <Flex direction="column" gap={3}>
                        {!visibleEvents.length && <Text color="secondary">Событий нет. Единичный выброс не открывает устойчивую тревогу.</Text>}
                        {[...visibleEvents].reverse().map((event, i) => <Flex key={i} direction="column" gap={1}>
                            <Flex gap={2} wrap><Text color="secondary">{formatTime(event.time, 'virtual')}</Text>
                                <Label theme={event.kind === 'close' ? 'success' : 'danger'}>{event.kind === 'close' ? 'Закрытие' : 'Тревога'} · {event.type === 'disagreement' ? 'Расхождение' : 'Недоступность сравнения'}</Label></Flex>
                            <Text>{event.text}</Text>
                        </Flex>)}
                    </Flex>
                </Panel>
                <Panel title="Условия эксперимента">
                    <Text color="secondary">Порог {result.config.threshold} °C, подтверждение одним окном {result.config.window} с с новыми последовательными парами.
                        Восстановление: {result.config.recovery_windows} нормальных окна подряд по {result.config.window} с с новыми парами с разницей меньше {result.config.recover_threshold} °C.
                        Доступность сравнения восстанавливается по {result.config.recovery_windows} нормальным окнам подряд по {result.config.window} с со свежими парами.
                        После подтверждения оба нормальных окна не закрашиваются.
                        Максимальный возраст {result.config.max_age} с, рассогласование времени ≤ {result.config.max_skew} с.
                        Нужны согласованные часы, одинаковые единицы и сопоставимые места измерения.
                        Два одинаково смещённых датчика могут остаться согласованными. Разметка генератора не передаётся монитору.
                        В режиме трёх датчиков сравниваются все пары; совпадение двух источников не гарантирует их исправность.</Text>
                </Panel>
            </>}
        </Page></LinkedChartsProvider>
    );
}
