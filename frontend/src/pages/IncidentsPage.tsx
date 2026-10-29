import {Button, Flex, Label, SegmentedRadioGroup, Select, Table, Text} from '@gravity-ui/uikit';
import {useMemo, useState} from 'react';
import {useNavigate} from 'react-router-dom';

import {Page, Panel, Stat} from '../components/Page';
import {formatDateTime, formatTime} from '../lib/format';
import {readSimulationHistory} from '../lib/simulationHistory';

type Filter = 'all' | 'open' | 'closed';
export function IncidentsPage() {
    const navigate = useNavigate();
    const [runs] = useState(readSimulationHistory);
    const [selected, setSelected] = useState('all');
    const [filter, setFilter] = useState<Filter>('all');
    const rows = useMemo(() => runs.filter((r) => selected === 'all' || selected === r.id)
        .flatMap((run) => run.incidents.map((alarm) => ({...alarm, run})))
        .filter((a) => filter === 'all' || (filter === 'open' ? a.end === null : a.end !== null)), [runs, selected, filter]);
    const openRun = (caseId: string, seed: number) => navigate(`/analysis?case=${encodeURIComponent(caseId)}&seed=${seed}`);
    return <Page title="Тревоги симуляций" subtitle="История последних 30 рассчитанных прогонов в этом браузере">
        <Text color="secondary">Здесь результаты полных расчётов, независимо от позиции воспроизведения.
            Нажмите на тревогу, чтобы открыть этот сценарий и seed в анализе.</Text>
        <div className="grid grid_stats">
            <Stat label="Сохранено прогонов" value={runs.length} />
            <Stat label="Всего тревог" value={runs.reduce((n, r) => n + r.incidents.length, 0)} />
            <Stat label="Не снято к концу записи" value={runs.reduce((n, r) => n + r.incidents.filter((i) => i.end === null).length, 0)} />
        </div>
        <Panel title="История тревог">
            <Flex gap={2} wrap>
                <Select label="Прогон" className="analysis-case-select" value={[selected]} onUpdate={([v]) => setSelected(v)}
                    options={[{value: 'all', content: 'Все прогоны'}, ...runs.map((r) => ({value: r.id, content: `${r.name} · seed ${r.seed}`}))]} />
                <SegmentedRadioGroup value={filter} onUpdate={(v) => setFilter(v as Filter)} options={[
                    {value: 'all', content: 'Все'}, {value: 'open', content: 'Не сняты'}, {value: 'closed', content: 'Сняты'},
                ]} />
            </Flex>
            <Table data={rows} width="max" emptyMessage={runs.length ? 'Тревог с выбранными условиями нет' : 'Откройте симуляцию или разбор прогона — его тревоги появятся здесь'}
                onRowClick={(a) => openRun(a.run.case_id, a.run.seed)} columns={[
                    {id: 'event', name: 'Событие', template: () => <Label theme="danger">Тревога</Label>},
                    {id: 'run', name: 'Прогон', template: (a) => `${a.run.name} · seed ${a.run.seed}`},
                    {id: 'reason', name: 'Комментарий'},
                    {id: 'start', name: 'Начало, мин:с', template: (a) => formatTime(a.start, 'virtual')},
                    {id: 'end', name: 'Восстановление, мин:с', template: (a) => a.end === null ? <Label theme="danger">Не снята</Label> : formatTime(a.end, 'virtual')},
                ]} />
        </Panel>
        <Panel title="Рассчитанные прогоны">
            <Table data={runs} width="max" emptyMessage="Пока нет рассчитанных симуляций" columns={[
                {id: 'name', name: 'Сценарий'}, {id: 'seed', name: 'Seed'},
                {id: 'calculated_at', name: 'Рассчитан', template: (r) => formatDateTime(r.calculated_at)},
                {id: 'alarms', name: 'Тревог', template: (r) => r.incidents.length},
                {id: 'action', name: '', template: (r) => <Button size="s" onClick={() => openRun(r.case_id, r.seed)}>Разобрать</Button>},
            ]} />
        </Panel>
    </Page>;
}
