// Один понятный график для простого режима: измерения, что видит монитор (медиана окна), норма и тревоги
import {useMemo} from 'react';
import type {AxisPlotBand, AxisPlotLine, ChartData, ChartSeries} from '@gravity-ui/charts';

import type {BaselineIncident, ClockKind, Frame, Label, Message} from '../api/types';
import {INCIDENT} from '../utils/format';
import {ChartBox} from './ChartBox';
import type {ChartIncident} from './SensorCharts';

interface Props {
    clock: ClockKind;
    messages: Message[];
    frames: Frame[];
    incidents: ChartIncident[];
    labels?: Label[];
    baseline?: BaselineIncident[];
    showBaseline: boolean;
    unit?: string | null;
    xMin?: number;
    xMax?: number;
    height?: number;
    silentModes?: string[];   // режимы без оценки (дрон на земле): норму не рисуем
}

// Ось datetime подписывает время в UTC: модельное время (с нуля) так и показываем как мм:сс,
// настенное сдвигаем в местный часовой пояс
const makeMs = (clock: ClockKind) =>
    clock === 'sim' ? (t: number) => t * 1000 : (t: number) => t * 1000 - new Date(t * 1000).getTimezoneOffset() * 60000;

export function SimpleChart(p: Props) {
    const ms = makeMs(p.clock);
    const now = p.frames.at(-1)?.now;
    const data = useMemo<ChartData>(() => {
        const pts = p.messages
            .filter((m) => m.value !== null && !(p.silentModes ?? []).includes(m.mode ?? ''))
            .sort((a, b) => a.event_time - b.event_time);
        const raw: {x: number; y: number | null}[] = [];
        pts.forEach((m, i) => {
            if (i > 0 && m.event_time - pts[i - 1].event_time > 3) raw.push({x: ms(m.event_time - 0.5), y: null});
            raw.push({x: ms(m.event_time), y: m.value as number});
        });
        const median: {x: number; y: number}[] = [];
        const norm: {x: number; y: number | null}[] = [];
        const thr: {x: number; y: number | null}[] = [];
        let lastAgg: number | null = null;
        for (const f of p.frames) {
            if (f.aggregate !== null && f.aggregate_time !== null && f.aggregate_time !== lastAgg) {
                median.push({x: ms(f.aggregate_time), y: f.aggregate});
                lastAgg = f.aggregate_time;
            }
            const off = (p.silentModes ?? []).includes(f.mode);
            norm.push({x: ms(f.now), y: off ? null : f.norm});
            thr.push({x: ms(f.now), y: !off && f.norm !== null && f.sigma !== null ? f.norm - 4.5 * f.sigma : null});
        }
        const series: ChartSeries[] = [
            {type: 'line', name: 'Измерения', data: raw, color: '#8EC5F5', lineWidth: 1.2},
            {type: 'line', name: 'Что видит монитор (медиана окна)', data: median, color: '#1F68A9', lineWidth: 2.5},
            {type: 'line', name: 'Норма режима', data: norm, color: '#30AA6E', dashStyle: 'Dash', lineWidth: 1.5},
        ];
        if (p.showBaseline) series.push({type: 'line', name: 'Простой порог', data: thr, color: '#FF7E00', dashStyle: 'ShortDash', lineWidth: 1});
        // Невидимая опорная серия: ось сразу на всю длину сценария (min/max оси без данных на краях не растягиваются)
        const ref = median[0]?.y ?? raw.find((r) => r.y !== null)?.y;
        if (p.xMin !== undefined && p.xMax !== undefined && ref !== undefined && ref !== null) {
            series.push({
                type: 'line',
                name: 'ось',
                data: [{x: ms(p.xMin), y: ref}, {x: ms(p.xMax), y: ref}],
                color: 'transparent',
                lineWidth: 0,
                legend: {enabled: false},
                tooltip: {enabled: false},
            } as ChartSeries);
        }

        const bands: AxisPlotBand[] = p.incidents.map((i) => ({
            from: ms(i.start),
            to: ms(i.end ?? now ?? i.start),
            color: INCIDENT[i.type as keyof typeof INCIDENT]?.color ?? 'rgba(127,127,127,0.15)',
            layerPlacement: 'before',
        }));
        for (const lb of p.labels ?? []) {
            bands.push({from: ms(lb.start), to: ms(lb.end), color: 'rgba(31,104,169,0.45)', size: 5, align: 'end'});
        }
        const lines: AxisPlotLine[] = [];
        if (p.showBaseline) {
            for (const b of p.baseline ?? []) {
                if (b.type === 'quality') lines.push({value: ms(b.start), color: '#FF7E00', width: 1, dashStyle: 'ShortDot'});
            }
        }
        if (now !== undefined) lines.push({value: ms(now), color: 'rgba(127,127,127,0.9)', width: 1.5});
        return {
            series: {data: series},
            xAxis: {
                type: 'datetime',
                min: p.xMin === undefined ? undefined : ms(p.xMin),
                max: p.xMax === undefined ? undefined : ms(p.xMax),
                labels: {dateFormat: p.clock === 'sim' ? 'mm:ss' : 'HH:mm:ss'},
                startOnTick: false,
                endOnTick: false,
                plotBands: bands,
                plotLines: lines,
            },
            yAxis: [{title: {text: p.unit ?? ''}}],
            legend: {enabled: true},
            chart: {margin: {top: 8, right: 12, bottom: 4, left: 4}},
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [p.messages, p.frames, p.incidents, p.labels, p.baseline, p.showBaseline, p.xMin, p.xMax, p.clock, p.unit, now, (p.silentModes ?? []).join()]);

    return <ChartBox data={data} height={p.height ?? 340} empty="Нажмите «Смотреть» - данные появятся здесь" />;
}
