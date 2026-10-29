import {type ChartData} from '@gravity-ui/charts';
import {useMemo} from 'react';

import {LinkedChart} from './LinkedChart';

import type {SingleReplay} from '../api/types';
import {chartDateFormat, chartTimeHeader, toChartX} from '../lib/format';

export function SingleCharts({replay, position, showMedian = false, showTruth = false}: {
    replay: SingleReplay; position: number; showMedian?: boolean; showTruth?: boolean;
}) {
    const data = useMemo<ChartData>(() => {
        const x = (t: number) => toChartX(t, 'virtual');
        const frames = replay.frames.filter((f) => f.now <= position);
        const points: {x: number; y: number | null}[] = [];
        const messages = replay.messages.filter((m) => m.received_at <= position).sort((a, b) => a.event_time - b.event_time);
        messages.forEach((m, index) => {
            const previous = messages[index - 1];
            if (previous && m.event_time - previous.event_time > 2)
                points.push({x: x((m.event_time + previous.event_time) / 2), y: null});
            points.push({x: x(m.event_time), y: m.value});
        });
        return {
            series: {data: [
                {type: 'line', name: 'Полученные измерения, включая исключённые', color: '#4d7cfe', lineWidth: 1.5, nullMode: 'skip', data: points},
                ...(showMedian ? [{type: 'line' as const, name: 'Последняя медиана пригодного окна 3 с', color: '#f5a524', nullMode: 'skip' as const,
                    data: frames.map((f) => ({x: x(f.now), y: f.age !== null && f.age <= replay.config.max_age ? f.aggregate : null}))}] : []),
                {type: 'line', name: 'Норма режима', color: '#30a46c', lineWidth: 1, dashStyle: 'Dash',
                    data: frames.map((f) => ({x: x(f.now), y: f.mode ? replay.profiles[f.mode]?.mean ?? null : null}))},
            ]},
            xAxis: {type: 'datetime', labels: {dateFormat: chartDateFormat('virtual')},
                plotBands: [
                    ...replay.incidents.filter((i) => i.start <= position).map((i) => {
                        // Нормальное окно известно только после решения о закрытии.
                        const end = i.end !== null && i.end <= position ? i.highlight_end ?? i.end : position;
                        return {from: x(i.start), to: x(end), color: '#e5484d', opacity: 0.07, layerPlacement: 'before' as const};
                    }),
                    ...(showTruth ? replay.truth.map((i) => ({from: x(i.start), to: x(i.end), color: '#f5a524', opacity: 0.12, layerPlacement: 'before' as const})) : []),
                ]},
            yAxis: [{title: {text: 'Значение, ед.'}}],
            tooltip: {headerFormat: chartTimeHeader('virtual')},
            legend: {enabled: true},
        };
    }, [replay, position, showMedian, showTruth]);
    return <div className="replay-chart" style={{height: 340}}><LinkedChart data={data} /></div>;
}
