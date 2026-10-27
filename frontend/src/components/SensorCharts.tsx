// Два синхронных графика датчика: измерения по времени события и CUSUM по времени решения монитора.
import {useMemo} from 'react';
import {Chart} from '@gravity-ui/charts';
import type {AxisPlotBand, AxisPlotLine, ChartData, ChartSeries} from '@gravity-ui/charts';
import {Flex, Text} from '@gravity-ui/uikit';

import type {Annotation, BaselineIncident, ClockKind, Frame, IncidentType, Label, Message} from '../api/types';
import {INCIDENT} from '../utils/format';

export interface ChartIncident {
    type: IncidentType | string;
    start: number;
    end: number | null;
}

interface Props {
    clock: ClockKind;
    messages: Message[];
    frames: Frame[];
    incidents: ChartIncident[];
    baseline?: BaselineIncident[];
    labels?: Label[];
    annotations?: Annotation[];
    unit?: string | null;
    h: number;
    suspect: number;
    baselineSigma?: number;
    showBaseline?: boolean;
    showLabels?: boolean;
    xMin?: number;
    xMax?: number;
    height?: number;
    // режимы без оценки качества (например, «на земле»): норму и порог для них не рисуем
    silentModes?: string[];
}

// Ось datetime работает в миллисекундах и подписывает время в UTC.
// Модельное время (с нуля) так и показываем, настенное сдвигаем в местный часовой пояс.
const makeMs = (clock: ClockKind) =>
    clock === 'sim' ? (t: number) => t * 1000 : (t: number) => t * 1000 - new Date(t * 1000).getTimezoneOffset() * 60000;
const COLORS = {
    value: '#4DA2F1',
    norm: '#3BC935',
    median: '#1F68A9',
    threshold: '#FF7E00',
    cusum: '#BA74B3',
    cusumUp: '#0FA08D',
    alarm: '#FF3D64',
    now: 'rgba(127,127,127,0.9)',
};

function timeAxis(clock: ClockKind, xMin?: number, xMax?: number) {
    const ms = makeMs(clock);
    return {
        type: 'datetime' as const,
        min: xMin === undefined ? undefined : ms(xMin),
        max: xMax === undefined ? undefined : ms(xMax),
        // модельное время сценария показываем как мм:сс от начала
        labels: {dateFormat: clock === 'sim' ? 'mm:ss' : 'HH:mm:ss'},
        startOnTick: false,
        endOnTick: false,
    };
}

export function SensorCharts(props: Props) {
    const {clock, messages, frames, incidents, unit, h, suspect, height = 300} = props;
    const ms = makeMs(clock);
    const silent = props.silentModes ?? [];
    const last = frames.at(-1);
    const now = last?.now;

    const valueData = useMemo<ChartData>(() => {
        const series: ChartSeries[] = [];
        const pts = [...messages]
            .filter((m) => m.value !== null && m.quality_flags !== 'invalid')
            .sort((a, b) => a.event_time - b.event_time);
        // Разрыв линии, если между измерениями больше 3 с (как пропуск на графике)
        const valueLine: {x: number; y: number | null}[] = [];
        pts.forEach((m, i) => {
            if (i > 0 && m.event_time - pts[i - 1].event_time > 3) valueLine.push({x: ms(m.event_time - 0.5), y: null});
            valueLine.push({x: ms(m.event_time), y: m.value as number});
        });
        series.push({type: 'line', name: `Измерение${unit ? `, ${unit}` : ''}`, data: valueLine, color: COLORS.value, lineWidth: 1.5});

        const normLine: {x: number; y: number | null}[] = [];
        const thrLine: {x: number; y: number | null}[] = [];
        const medLine: {x: number; y: number}[] = [];
        let lastAgg: number | null = null;
        for (const f of frames) {
            const off = silent.includes(f.mode);
            normLine.push({x: ms(f.now), y: off ? null : f.norm ?? null});
            if (props.showBaseline && !off && f.norm !== null && f.sigma !== null) {
                thrLine.push({x: ms(f.now), y: f.norm - (props.baselineSigma ?? 4.5) * f.sigma});
            }
            if (f.aggregate !== null && f.aggregate_time !== null && f.aggregate_time !== lastAgg) {
                medLine.push({x: ms(f.aggregate_time), y: f.aggregate});
                lastAgg = f.aggregate_time;
            }
        }
        series.push({type: 'line', name: 'Норма режима', data: normLine, color: COLORS.norm, dashStyle: 'Dash', lineWidth: 1.5});
        series.push({type: 'line', name: 'Медиана окна', data: medLine, color: COLORS.median, lineWidth: 2});
        if (props.showBaseline) {
            series.push({type: 'line', name: 'Простой порог', data: thrLine, color: COLORS.threshold, dashStyle: 'ShortDash', lineWidth: 1});
        }

        const bands: AxisPlotBand[] = incidents.map((i) => ({
            from: ms(i.start),
            to: ms(i.end ?? now ?? i.start),
            color: INCIDENT[i.type as IncidentType]?.color ?? 'rgba(127,127,127,0.15)',
            layerPlacement: 'before',
        }));
        if (props.showLabels) {
            for (const lb of props.labels ?? []) {
                bands.push({
                    from: ms(lb.start),
                    to: ms(lb.end),
                    color: 'rgba(31, 104, 169, 0.55)',
                    size: 6,
                    align: 'end',
                    label: {text: `разметка: ${lb.label ?? lb.type}`, style: {fontSize: '11px'}},
                });
            }
        }
        const lines: AxisPlotLine[] = [];
        for (const a of props.annotations ?? []) {
            if (a.kind === 'spike' || a.kind === 'batch' || a.kind === 'mode') {
                lines.push({value: ms(a.start), color: '#8a8a8a', dashStyle: 'Dot', width: 1, label: {text: a.label, style: {fontSize: '11px'}}});
            }
        }
        if (props.showBaseline) {
            for (const b of props.baseline ?? []) {
                if (b.type === 'quality') lines.push({value: ms(b.start), color: COLORS.threshold, width: 1, dashStyle: 'ShortDot'});
            }
        }
        if (now !== undefined) lines.push({value: ms(now), color: COLORS.now, width: 1});
        return {
            series: {data: series},
            xAxis: {...timeAxis(clock, props.xMin, props.xMax), plotBands: bands, plotLines: lines},
            yAxis: [{title: {text: unit ?? ''}}],
            legend: {enabled: true},
            chart: {margin: {top: 10, right: 16, bottom: 4, left: 4}},
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages, frames, incidents, unit, now, clock, props.showBaseline, props.showLabels, props.labels, props.annotations, props.baseline, props.baselineSigma, props.xMin, props.xMax, silent.join()]);

    const cusumData = useMemo<ChartData>(() => {
        const both = frames.some((f) => f.s_up > 0);
        const series: ChartSeries[] = [
            {type: 'line', name: both ? 'CUSUM вниз' : 'CUSUM, S', data: frames.map((f) => ({x: ms(f.now), y: f.s_down ?? f.s})), color: COLORS.cusum, lineWidth: 2},
        ];
        if (both) series.push({type: 'line', name: 'CUSUM вверх', data: frames.map((f) => ({x: ms(f.now), y: f.s_up})), color: COLORS.cusumUp, lineWidth: 2});
        // После открытия инцидента S растёт дальше порога; шкалу ограничиваем 4h, чтобы порог был виден
        const maxS = Math.max(0, ...frames.map((f) => Math.max(f.s_down ?? f.s, f.s_up ?? 0)));
        const yMax = Math.max(h * 1.5, Math.min(maxS * 1.05, h * 4));
        const bands: AxisPlotBand[] = incidents
            .filter((i) => i.type === 'quality')
            .map((i) => ({from: ms(i.start), to: ms(i.end ?? now ?? i.start), color: INCIDENT.quality.color}));
        return {
            series: {data: series},
            xAxis: {...timeAxis(clock, props.xMin, props.xMax), plotBands: bands, plotLines: now === undefined ? [] : [{value: ms(now), color: COLORS.now, width: 1}]},
            yAxis: [
                {
                    min: 0,
                    max: yMax,
                    plotLines: [
                        {value: h, color: COLORS.alarm, dashStyle: 'Dash', width: 1.5, label: {text: `порог h = ${h}`, style: {fontSize: '11px'}}},
                        {value: suspect, color: '#DB9100', dashStyle: 'Dot', width: 1},
                    ],
                },
            ],
            legend: {enabled: true},
            chart: {margin: {top: 10, right: 16, bottom: 4, left: 4}},
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [frames, incidents, now, clock, h, suspect, props.xMin, props.xMax]);

    return (
        <Flex direction="column" gap={3}>
            <div>
                <Text variant="subheader-1">Измерения по времени события</Text>
                <div style={{height}}>
                    <Chart data={valueData} />
                </div>
            </div>
            <div>
                <Text variant="subheader-1">Накопление отклонений (CUSUM) по времени решения монитора</Text>
                <Text color="secondary" variant="caption-2">
                    {' '}
                    красная линия - порог h, жёлтая - «подозрение»; шкала ограничена 4h
                </Text>
                <div style={{height: Math.round(height * 0.55)}}>
                    <Chart data={cusumData} />
                </div>
            </div>
        </Flex>
    );
}
