import {Table} from '@gravity-ui/uikit';

import type {MethodMetrics, Metrics} from '../api/types';
import {formatDuration} from '../lib/format';

type Row = Metrics & {method: string};

const columns = [
    {id: 'method', name: 'Метод'},
    {id: 'detected', name: 'Обнаружено', align: 'end' as const, template: (r: Row) => `${r.detected} / ${r.total}`},
    {id: 'missed', name: 'Пропущено', align: 'end' as const, template: (r: Row) => r.total - r.detected},
    {id: 'false_alarms', name: 'Ложные', align: 'end' as const},
    {id: 'repeats', name: 'Повторы', align: 'end' as const},
    {id: 'unclosed', name: 'Не закрыты', align: 'end' as const},
    {id: 'delay', name: 'Задержка обнаружения', align: 'end' as const, template: (r: Row) => formatDuration(r.delay)},
    {id: 'close_delay', name: 'Задержка закрытия', align: 'end' as const, template: (r: Row) => formatDuration(r.close_delay)},
];

export function MetricsTable({metrics}: {metrics: MethodMetrics}) {
    const data: Row[] = [
        {method: 'Монитор (CUSUM)', ...metrics.monitor},
        {method: 'Простой порог', ...metrics.baseline},
    ];
    return <Table data={data} columns={columns} width="max" />;
}
