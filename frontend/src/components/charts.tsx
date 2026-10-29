import {type AxisPlotBand, type ChartData} from '@gravity-ui/charts';
import {Text} from '@gravity-ui/uikit';
import {useMemo} from 'react';

import {LinkedChart} from './LinkedChart';

import type {Clock, Frame, Interval, Measurement, Profiles} from '../api/types';
import {INCIDENT, chartDateFormat, chartTimeHeader, formatNumber, toChartX} from '../lib/format';

export interface ChartIncident {
    type: string;
    start: number;
    end: number | null;
    highlight_end?: number | null;
}

function ChartBox({data, height, clock = 'virtual', empty = 'Данных пока нет'}: {data: ChartData; height: number; clock?: Clock; empty?: string}) {
    const series = data.series.data.filter((s) => s.data.length > 0);
    return (
        <div style={{height}} className={series.length ? undefined : 'chart-empty'}>
            {series.length ? <LinkedChart data={{...data, series: {...data.series, data: series}}} clock={clock} /> : <Text color="secondary">{empty}</Text>}
        </div>
    );
}

const LATE_AFTER = 5;
const GAP_AFTER = 2;

function incidentBands(incidents: ChartIncident[], clock: Clock, until: number): AxisPlotBand[] {
    return incidents.map((i) => ({
        from: toChartX(i.start, clock),
        to: toChartX(i.end === null ? until : i.highlight_end ?? i.end, clock),
        color: INCIDENT[i.type as keyof typeof INCIDENT]?.color ?? '#4da2f1',
        opacity: 0.18,
        layerPlacement: 'before',
    }));
}

const truthBands = (truth: Interval[], clock: Clock): AxisPlotBand[] =>
    truth.map((t) => ({
        from: toChartX(t.start, clock),
        to: toChartX(t.end, clock),
        color: '#4da2f1',
        opacity: 0.12,
        layerPlacement: 'before',
        size: 10,
    }));

export interface MeasurementsChartProps {
    measurements: Measurement[];
    clock: Clock;
    profiles: Profiles;
    incidents: ChartIncident[];
    truth?: Interval[];
    baselineSigma?: number;
    baseline?: ChartIncident[];
    height?: number;
}

export function MeasurementsChart(props: MeasurementsChartProps) {
    const {measurements, clock, profiles, incidents, truth = [], baselineSigma, baseline = [], height = 320} = props;
    const data = useMemo<ChartData>(() => {
        const points = measurements.filter((m) => m.value !== null).sort((a, b) => a.event_time - b.event_time);
        const values: {x: number; y: number | null}[] = [];
        const norm: {x: number; y: number | null}[] = [];
        const threshold: {x: number; y: number | null}[] = [];
        points.forEach((m, i) => {
            const prev = points[i - 1];
            if (prev && m.event_time - prev.event_time > GAP_AFTER) {
                const x = toChartX((m.event_time + prev.event_time) / 2, clock);
                values.push({x, y: null});
            }
            const x = toChartX(m.event_time, clock);
            const profile = profiles[m.mode];
            values.push({x, y: m.value});
            norm.push({x, y: profile?.mean ?? null});
            if (baselineSigma !== undefined) threshold.push({x, y: profile ? profile.mean - baselineSigma * profile.sigma : null});
        });
        const late = points
            .filter((m) => m.received_at - m.event_time > LATE_AFTER)
            .map((m) => ({x: toChartX(m.event_time, clock), y: m.value as number}));
        const until = points.length ? points[points.length - 1].event_time : 0;
        return {
            series: {
                data: [
                    {type: 'line', name: 'Измерения', data: values, color: '#4d7cfe', lineWidth: 1.5, nullMode: 'skip'},
                    {type: 'line', name: 'Эталон режима', data: norm, color: '#30a46c', dashStyle: 'Dash', lineWidth: 1.5},
                    ...(baselineSigma !== undefined
                        ? [{type: 'line' as const, name: `Порог ${formatNumber(baselineSigma)}σ`, data: threshold, color: '#f5a524', dashStyle: 'ShortDot' as const}]
                        : []),
                    ...(late.length ? [{type: 'scatter' as const, name: 'Пришли с опозданием', data: late, color: '#8e8c99'}] : []),
                ],
            },
            xAxis: {
                type: 'datetime',
                labels: {dateFormat: chartDateFormat(clock)},
                plotBands: [...incidentBands(incidents, clock, until), ...truthBands(truth, clock)],
                plotLines: baseline.map((b) => ({value: toChartX(b.start, clock), color: '#f5a524', width: 1, dashStyle: 'ShortDash' as const})),
            },
            yAxis: [{title: {text: 'Значение'}}],
            tooltip: {headerFormat: chartTimeHeader(clock)},
            legend: {enabled: true},
        };
    }, [measurements, clock, profiles, incidents, truth, baselineSigma, baseline]);
    return (
        <>
            <ChartBox data={data} height={height} clock={clock} />
            <div className="chart-note">
                <span className="swatch" style={{background: INCIDENT.quality.color}} /> деградация качества
                <span className="swatch" style={{background: INCIDENT.availability.color}} /> нет свежих данных
                <span className="swatch" style={{background: INCIDENT.flags.color}} /> невалидные флаги
                {truth.length > 0 && (
                    <>
                        <span className="swatch swatch_thin" /> разметка сценария
                    </>
                )}
                {baseline.length > 0 && (
                    <>
                        <span className="swatch swatch_line" /> срабатывания порога
                    </>
                )}
            </div>
        </>
    );
}

export function CusumChart({frames, clock, h, suspect, height = 180}: {frames: Pick<Frame, 'now' | 's'>[]; clock: Clock; h: number; suspect: number; height?: number}) {
    const data = useMemo<ChartData>(
        () => ({
            series: {
                data: [{type: 'line', name: 'CUSUM', data: frames.map((f) => ({x: toChartX(f.now, clock), y: f.s})), color: '#12a594', lineWidth: 1.5}],
            },
            xAxis: {type: 'datetime', labels: {dateFormat: chartDateFormat(clock)}},
            yAxis: [
                {
                    min: 0,
                    plotLines: [
                        {value: h, color: '#e5484d', dashStyle: 'Dash', width: 1.5, label: {text: `Тревога: ${h}`}},
                        {value: suspect, color: '#f5a524', dashStyle: 'Dot', width: 1},
                    ],
                },
            ],
            tooltip: {headerFormat: chartTimeHeader(clock)},
            legend: {enabled: false},
        }),
        [frames, clock, h, suspect],
    );
    return (
        <>
            <ChartBox data={data} height={height} clock={clock} />
            <div className="chart-note">
                <span className="swatch swatch_line swatch_red" /> порог тревоги {h}
                <span className="swatch swatch_line" /> подозрение {formatNumber(suspect)}
            </div>
        </>
    );
}

export function DonutChart({items, height = 220}: {items: {name: string; value: number; color: string}[]; height?: number}) {
    const data = useMemo<ChartData>(
        () => ({
            series: {
                data: [
                    {
                        type: 'pie',
                        name: 'Сенсоры',
                        innerRadius: '55%',
                        data: items.filter((i) => i.value > 0).map((i) => ({name: i.name, value: i.value, color: i.color})),
                        dataLabels: {enabled: true},
                    },
                ],
            },
            legend: {enabled: true},
        }),
        [items],
    );
    return <ChartBox data={data} height={height} />;
}

export function GroupedBarChart({categories, series, height = 260}: {categories: string[]; series: {name: string; color: string; values: number[]}[]; height?: number}) {
    const data = useMemo<ChartData>(
        () => ({
            series: {
                data: series.map((s) => ({
                    type: 'bar-x' as const,
                    name: s.name,
                    color: s.color,
                    data: s.values.map((y, x) => ({x, y})),
                    dataLabels: {enabled: true},
                })),
            },
            xAxis: {type: 'category', categories},
            yAxis: [{min: 0}],
            legend: {enabled: true},
        }),
        [categories, series],
    );
    return <ChartBox data={data} height={height} />;
}

export interface TimelineItem {
    row: string;
    type: string;
    from: number;
    to: number;
    label: string;
}

export function IncidentTimeline({items, height}: {items: TimelineItem[]; height?: number}) {
    const rows = useMemo(() => [...new Set(items.map((i) => i.row))], [items]);
    const data = useMemo<ChartData>(
        () => ({
            series: {
                data: Object.entries(INCIDENT).map(([type, meta]) => ({
                    type: 'x-range' as const,
                    name: meta.text,
                    color: meta.color,
                    data: items
                        .filter((i) => i.type === type)
                        .map((i) => ({x0: i.from * 1000, x1: Math.max(i.to, i.from + 1) * 1000, y: rows.indexOf(i.row), label: i.label})),
                })),
            },
            xAxis: {type: 'datetime', labels: {dateFormat: 'HH:mm:ss'}},
            yAxis: [{type: 'category', categories: rows}],
            legend: {enabled: true},
        }),
        [items, rows],
    );
    return <ChartBox data={data} height={height ?? Math.max(160, 70 + rows.length * 36)} />;
}
