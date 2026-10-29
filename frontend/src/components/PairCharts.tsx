import {type ChartData} from '@gravity-ui/charts';
import {useMemo} from 'react';

import {LinkedChart} from './LinkedChart';

import type {PairReplay} from '../api/types';
import {chartDateFormat, chartTimeHeader, toChartX} from '../lib/format';

export function PairCharts({replay, position, difference = false, showTruth = false}: {replay: PairReplay; position: number; difference?: boolean; showTruth?: boolean}) {
    const data = useMemo<ChartData>(() => {
        const x = (t: number) => toChartX(t, 'virtual');
        const frames = replay.frames.filter((f) => f.now <= position);
        const measurements = replay.messages.filter((m) => m.received_at <= position);
        const series: ChartData['series']['data'] = difference
            ? [{type: 'line', name: '|A − B|', color: '#8a63d2', nullMode: 'skip',
                data: frames.map((f) => ({x: x(f.now), y: f.difference}))}]
            : ['A', 'B'].map((name, index) => {
                const values = measurements.filter((m) => m.sensor_id === name).sort((a, b) => a.event_time - b.event_time);
                const points: {x: number; y: number | null}[] = [];
                values.forEach((m, i) => {
                    const previous = values[i - 1];
                    if (previous && m.event_time - previous.event_time > 2)
                        points.push({x: x((m.event_time + previous.event_time) / 2), y: null});
                    points.push({x: x(m.event_time), y: m.value});
                });
                return {type: 'line' as const, name: 'Датчик ' + name, color: index ? '#f5a524' : '#4d7cfe',
                    lineWidth: 1.8, nullMode: 'skip' as const, data: points};
            });
        return {
            series: {data: series},
            xAxis: {type: 'datetime', min: x(0), max: x(replay.duration), labels: {dateFormat: chartDateFormat('virtual')},
                plotBands: [...(showTruth ? replay.truth.map((t) => ({from: x(t.start), to: x(t.end), color: '#f5a524', opacity: 0.1, layerPlacement: 'before' as const})) : []), ...replay.incidents.filter((i) => i.start <= position).map((i) => {
                    const end = i.end !== null && i.end <= position ? i.highlight_end ?? i.end : position;
                    return {from: x(i.start), to: x(end), color: '#e5484d',
                        opacity: 0.14, layerPlacement: 'before' as const};
                })]},
            yAxis: [{title: {text: difference ? 'Разница, °C' : 'Температура, °C'}, ...(difference ? {min: 0, plotLines: [
                {value: replay.config.threshold, color: '#e5484d', dashStyle: 'Dash' as const, label: {text: 'Тревога ' + replay.config.threshold + ' °C'}},
                {value: replay.config.recover_threshold, color: '#30a46c', dashStyle: 'Dot' as const, label: {text: 'Восстановление ' + replay.config.recover_threshold + ' °C'}},
            ]} : {})}],
            tooltip: {headerFormat: chartTimeHeader('virtual')},
            legend: {enabled: !difference},
        };
    }, [replay, position, difference, showTruth]);
    return <div className="replay-chart" style={{height: difference ? 220 : 320}}><LinkedChart data={data} /></div>;
}
