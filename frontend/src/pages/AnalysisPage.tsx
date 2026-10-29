import {Alert, Button, Checkbox, Flex, Label, Loader, NumberInput, Select, Table, Text} from '@gravity-ui/uikit';
import {useEffect, useRef, useState} from 'react';

import {api} from '../api/client';
import type {PairReplay, RunAssessment, SimulationAnalysis, SimulationBatch, SingleReplay} from '../api/types';
import {LinkedChartsProvider} from '../components/LinkedChart';
import {Page, Panel, Stat} from '../components/Page';
import {PairCharts} from '../components/PairCharts';
import {SingleCharts} from '../components/SingleCharts';
import {SeedField, seedError} from '../components/SeedField';
import {CusumChart} from '../components/charts';
import {useAsync} from '../hooks/useAsync';
import {formatDuration, formatNumber, formatTime} from '../lib/format';
import {useMeta} from '../lib/meta';
import {saveSimulation} from '../lib/simulationHistory';
import {useSearchParams} from 'react-router-dom';

export function AnalysisPage() {
    const meta = useMeta();
    const [query] = useSearchParams();
    const catalog = useAsync(api.analysisCases, []);
    const [caseId, setCaseId] = useState(query.get('case') ?? 'single:combined');
    const recommendations = useAsync(() => api.analysisExamples(caseId).then((items) => ({caseId, items})), [caseId]);
    const [seed, setSeed] = useState<number | null>(query.has('seed') ? Number(query.get('seed')) : 42);
    const [result, setResult] = useState<SimulationAnalysis | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showTruth, setShowTruth] = useState(true);
    const [showMedian, setShowMedian] = useState(false);
    const [selectedCases, setSelectedCases] = useState<string[]>([]);
    const [range, setRange] = useState<[number | null, number | null]>([1, 10]);
    const [batch, setBatch] = useState<SimulationBatch | null>(null);
    const [checking, setChecking] = useState(false);
    const [batchError, setBatchError] = useState<string | null>(null);
    const requestId = useRef(0);
    const top = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (catalog.data) setSelectedCases(catalog.data.map((c) => c.id));
    }, [catalog.data]);
    useEffect(() => {
        const id = ++requestId.current;
        if (seed === null || seedError(seed, meta.seed)) {setLoading(false); return;}
        setLoading(true);
        setError(null);
        const timer = window.setTimeout(async () => {
            try {
                const next = await api.analyzeSimulation({case_id: caseId, seed});
                if (id === requestId.current) {setResult(next); saveSimulation(next.case.id, next.case.name, next.data);}
            } catch (e) {
                if (id === requestId.current) setError((e as Error).message);
            } finally {
                if (id === requestId.current) setLoading(false);
            }
        }, 200);
        return () => {clearTimeout(timer); requestId.current++;};
    }, [caseId, seed, meta.seed]);

    const exampleList = recommendations.data?.caseId === caseId ? recommendations.data.items : undefined;
    const ready = result?.case.id === caseId && result.assessment.seed === seed ? result : null;
    const options = (catalog.data ?? []).map((c) => ({value: c.id, content: c.name}));
    const chosen = catalog.data?.find((c) => c.id === caseId);
    const runCount = selectedCases.length * Math.max(0, (range[1] ?? 0) - (range[0] ?? 0) + 1);
    const rangeError = seedError(range[0], meta.seed) ?? seedError(range[1], meta.seed) ??
        ((range[1] ?? 0) < (range[0] ?? 0) ? 'Конец диапазона должен быть не меньше начала' :
            runCount > meta.limits.max_benchmark_runs ? `Не больше ${meta.limits.max_benchmark_runs} прогонов за раз` : undefined);
    const check = async () => {
        setChecking(true); setBatchError(null);
        try {
            setBatch(await api.checkSimulations({case_ids: selectedCases, seed_from: range[0]!, seed_to: range[1]!}));
        } catch (e) {setBatchError((e as Error).message);}
        finally {setChecking(false);}
    };
    const openRun = (run: RunAssessment) => {
        setCaseId(run.case_id); setSeed(run.seed);
        top.current?.scrollIntoView({behavior: 'smooth', block: 'start'});
    };
    const name = (id: string) => catalog.data?.find((c) => c.id === id)?.name ?? id;
    const single = ready?.case.kind === 'single' ? ready.data as SingleReplay : null;
    const pair = ready?.case.kind === 'pair' ? ready.data as PairReplay : null;
    const incidents: {id: number; type: string; start: number; end: number | null; reason: string}[] = ready?.data.incidents ?? [];
    const problematic = batch?.details.filter((r) => !r.passed) ?? [];

    return <Page title="Анализ сценариев" subtitle="Подробный разбор симуляции и проверка устойчивости на разных seed">
        <div ref={top} />
        {(catalog.error || error) && <Alert theme="danger" title="Не удалось загрузить прогон" message={error ?? catalog.error?.message} />}
        <Panel title="Разбор одного прогона">
            <Flex gap={3} wrap alignItems="flex-end">
                <Select label="Сценарий" className="analysis-case-select" value={[caseId]} options={options}
                    onUpdate={([value]) => setCaseId(value)} disabled={!catalog.data} />
                <SeedField value={seed} onUpdate={setSeed} />
                {loading && <Loader size="s" />}
            </Flex>
            <Flex gap={1} wrap alignItems="center">
                <Text color="secondary">Рекомендуемые seed:</Text>
                {(exampleList ?? [{seed: 42, label: 'Эталон', note: 'Опорный пример с seed 42'}]).map((example) => <Button key={example.seed} size="s" selected={seed === example.seed} aria-pressed={seed === example.seed}
                    view={seed === example.seed ? 'outlined-info' : 'outlined'} title={example.note} onClick={() => setSeed(example.seed)}>
                    <span style={{fontWeight: seed === example.seed ? 700 : 400}}>{example.seed} {example.label}</span>
                </Button>)}
                {recommendations.loading && <Loader size="s" />}
            </Flex>
            {exampleList?.find((example) => example.seed === seed) && <Text variant="caption-2" color="secondary">
                {exampleList?.find((example) => example.seed === seed)?.note}
            </Text>}
            <Text variant="caption-2" color="secondary">Seed задаёт случайный шум. Одинаковый seed воспроизводит одинаковую запись; тип и время нарушения не меняются.</Text>
            <Text color="secondary">{chosen?.expectation} Выбор сценария или seed сразу загружает результат.</Text>
            <Text color="secondary">Время — от начала симуляции, мин:с. Окно 3 с; открытие по одному плохому окну,
                восстановление по двум нормальным. Для уровня дополнительно нужен порог CUSUM 10.</Text>
        </Panel>
        {ready && <>
            <Panel title={`Результат · ${ready.case.name} · seed ${ready.assessment.seed}`}
                extra={<Label theme={ready.assessment.passed ? 'success' : 'warning'}>{ready.assessment.passed ? 'Соответствует сценарию' : 'Есть замечания'}</Label>}>
                <div className="grid grid_stats">
                    <Stat label="Нарушений обнаружено" value={ready.assessment.expected ? `${ready.assessment.detected_count} / ${ready.assessment.expected_count}` : 'Не требуется'} />
                    <Stat label="Открытие" value={formatTime(ready.assessment.detection_time, 'virtual')}
                        hint={ready.assessment.delay !== null ? `Через ${formatDuration(ready.assessment.delay)} от начала первого нарушения` : 'Для целевой тревоги'} />
                    <Stat label="Восстановление" value={formatTime(ready.assessment.recovery_time, 'virtual')}
                        hint={ready.assessment.recovery_delay !== null ? `Подтверждено через ${formatDuration(ready.assessment.recovery_delay)} после конца нарушения` : 'Для последней целевой тревоги'} />
                    <Stat label="Лишние тревоги" value={ready.assessment.false_alarms} hint="Открылись вне ожидаемого нарушения" />
                </div>
                {ready.assessment.issues.map((issue) => <Text key={issue} color="warning">{issue}</Text>)}
                {ready.assessment.other_alarms > 0 && <Text color="secondary">Других тревог во время нарушения: {ready.assessment.other_alarms}.
                    Они перечислены ниже и не подменяют обнаружение целевой причины.</Text>}
            </Panel>
            {ready.assessment.event_results.length > 1 && <Panel title="Обнаружение каждого нарушения">
                <Table data={ready.assessment.event_results} width="max" columns={[
                    {id: 'target', name: 'Ожидается', template: (e) => single?.alarm_names[e.target as keyof SingleReplay['alarm_names']] ?? e.target},
                    {id: 'start', name: 'Начало нарушения', template: (e) => formatTime(e.start, 'virtual')},
                    {id: 'detection_time', name: 'Тревога', template: (e) => formatTime(e.detection_time, 'virtual')},
                    {id: 'recovery_time', name: 'Восстановление', template: (e) => formatTime(e.recovery_time, 'virtual')},
                ]} />
            </Panel>}
            <LinkedChartsProvider resetKey={`${ready.case.id}:${ready.assessment.seed}`}>
                <Panel title={single ? 'Измерения датчика' : `Измерения ${pair?.sensor_count ?? 2} датчиков`} extra={<Flex gap={2} wrap>
                    <Checkbox checked={showTruth} onUpdate={setShowTruth}>Разметка генератора</Checkbox>
                    {single && <Checkbox checked={showMedian} onUpdate={setShowMedian}>Медиана окна</Checkbox>}
                </Flex>}>
                    {single && <SingleCharts replay={single} position={single.duration} showTruth={showTruth} showMedian={showMedian} />}
                    {pair && <PairCharts replay={pair} position={pair.duration} showTruth={showTruth} />}
                    <Text variant="caption-2" color="secondary">Красный фон — тревоги, жёлтый — заданное нарушение.
                        Разметка используется только для оценки. После подтверждения восстановления оба нормальных окна не закрашиваются.</Text>
                </Panel>
                <Panel title={single ? 'Накопление отклонений (CUSUM)' : 'Расхождение и пороги'}>
                    {single && <div className="replay-chart"><CusumChart frames={single.frames} clock="virtual" h={single.config.cusum_h} suspect={single.config.cusum_suspect} height={220} /></div>}
                    {pair && <PairCharts replay={pair} position={pair.duration} difference />}
                    <Text variant="caption-2" color="secondary">Наведите на любой график: время и значения появятся на обоих.
                        {single && ' CUSUM отвечает за уровень; шум, частота и качество данных проверяются независимо.'}</Text>
                </Panel>
            </LinkedChartsProvider>
            <Panel title="Тревоги и причины">
                <Table data={incidents} width="max" emptyMessage="Тревог в этом прогоне нет" columns={[
                    {id: 'start', name: 'Открыта, мин:с', template: (i) => formatTime(i.start, 'virtual')},
                    {id: 'end', name: 'Снята, мин:с', template: (i) => i.end === null ? <Label theme="danger">Не снята</Label> : formatTime(i.end, 'virtual')},
                    {id: 'alarm', name: 'Событие', template: () => <Label theme="danger">Тревога</Label>},
                    {id: 'reason', name: 'Комментарий', template: (i) => <Text className="alarm-comment">{i.reason}</Text>},
                ]} />
            </Panel>
        </>}
        <Panel title="Проверка на разных seed">
            <Text>Один удачный пример не показывает устойчивость. Здесь каждый выбранный сценарий повторяется с разным случайным шумом.
                Результат показывает пропуски, лишние тревоги, повторные открытия и раннее снятие тревоги.</Text>
            <Flex gap={2} wrap alignItems="flex-end">
                <Select label="Сценарии" multiple className="analysis-case-select" value={selectedCases} options={options} onUpdate={setSelectedCases} />
                <NumberInput label="Seed с" value={range[0]} onUpdate={(v) => setRange([v, range[1]])} min={meta.seed.min} max={meta.seed.max} style={{width: 140}} />
                <NumberInput label="по" value={range[1]} onUpdate={(v) => setRange([range[0], v])} min={meta.seed.min} max={meta.seed.max} style={{width: 130}} />
                <Button view="action" loading={checking} disabled={!selectedCases.length || Boolean(rangeError)} onClick={check}>Проверить {runCount} прогонов</Button>
            </Flex>
            {rangeError && <Text color="danger">{rangeError}</Text>}
            {batchError && <Alert theme="danger" title="Проверка не выполнена" message={batchError} />}
            {batch && <>
                <Text variant="subheader-1">Результат: {batch.summary.runs} прогонов · seed {batch.seed_from}…{batch.seed_to}</Text>
                <div className="grid grid_stats">
                    <Stat label="Нарушений обнаружено" value={`${batch.summary.detected} / ${batch.summary.expected}`} hint={`Пропущено: ${batch.summary.missed}`} />
                    <Stat label="Прогонов с лишними тревогами" value={`${batch.summary.false_alarm_runs} / ${batch.summary.runs}`} hint={`Всего лишних тревог: ${batch.summary.false_alarms}`} />
                    <Stat label="Прогонов без замечаний" value={`${batch.summary.passed} / ${batch.summary.runs}`} hint="Нет пропусков, лишних тревог, повторов, ранних снятий и незакрытых тревог" />
                    <Stat label="Средняя задержка обнаружения" value={batch.summary.mean_delay === null ? '—' : `${formatNumber(batch.summary.mean_delay)} с`} hint="Только обнаруженные целевые нарушения" />
                </div>
                <Table data={batch.rows} width="max" columns={[
                    {id: 'case', name: 'Сценарий', template: (r) => r.case.name},
                    {id: 'detected', name: 'Обнаружено', template: (r) => r.expected ? `${r.detected} / ${r.expected}` : 'Тревог не ожидается'},
                    {id: 'false_alarm_runs', name: 'Прогонов с лишними тревогами'},
                    {id: 'repeats', name: 'Повторных открытий'},
                    {id: 'early_recovery_runs', name: 'Раннее снятие, прогонов'},
                    {id: 'unclosed', name: 'Не закрыто тревог'},
                    {id: 'action', name: '', template: (r) => <Button size="s" onClick={() => openRun(batch.details.find((d) => d.case_id === r.case.id && !d.passed) ?? batch.details.find((d) => d.case_id === r.case.id)!)}>Разобрать</Button>},
                ]} />
                <Text color="secondary">Лишняя тревога — открытие вне заданного нарушения (допуск 3 с на завершение окна).
                    Другие симптомы внутри нарушения считаются отдельно. Раннее снятие — закрытие целевой тревоги до конца заданного нарушения.
                    Прогоны без нарушения не входят в число ожидаемых обнаружений.</Text>
                {problematic.length > 0 ? <>
                    <Text variant="subheader-1">Прогоны с замечаниями · {problematic.length}</Text>
                    <Table data={problematic.slice(0, 20)} width="max" columns={[
                        {id: 'case_id', name: 'Сценарий', template: (r) => name(r.case_id)},
                        {id: 'seed', name: 'Seed'},
                        {id: 'issues', name: 'Что произошло', template: (r) => r.issues.join('. ')},
                        {id: 'action', name: '', template: (r) => <Button size="s" onClick={() => openRun(r)}>Показать прогон</Button>},
                    ]} />
                    {problematic.length > 20 && <Text color="secondary">Показаны первые 20. Для подробного разбора сузьте диапазон seed.</Text>}
                </> : <Text color="positive">В выбранных прогонах замечаний нет.</Text>}
            </>}
        </Panel>
    </Page>;
}
