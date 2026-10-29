import {Chart, type ChartData} from '@gravity-ui/charts';
import {createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';

import {useLinkedChartLayout} from './useLinkedChartLayout';

import type {Clock} from '../api/types';
import {formatNumber, formatTime} from '../lib/format';

const HoverContext = createContext<{x: number | null; update: (x: number | null) => void} | null>(null);

export function LinkedChartsProvider({children, resetKey}: {children: ReactNode; resetKey: string}) {
    const [x, update] = useState<number | null>(null);
    useEffect(() => update(null), [resetKey]);
    useEffect(() => {
        const clearOutside = (event: PointerEvent) => {
            if (!(event.target instanceof Element) || !event.target.closest('.linked-chart')) update(null);
        };
        document.addEventListener('pointermove', clearOutside, true);
        return () => document.removeEventListener('pointermove', clearOutside, true);
    }, []);
    const value = useMemo(() => ({x, update}), [x]);
    return <HoverContext.Provider value={value}>{children}</HoverContext.Provider>;
}

function shortName(name: string) {
    if (name === 'Полученные измерения, включая исключённые') return 'Измерение';
    if (name === 'Последняя медиана пригодного окна 3 с') return 'Медиана окна';
    return name;
}

/** Общая отметка времени; значения берутся строго в этой точке без интерполяции пропусков. */
export function LinkedChart({data, clock = 'virtual'}: {data: ChartData; clock?: Clock}) {
    const hover = useContext(HoverContext);
    const selectedX = hover?.x ?? null;
    const update = hover?.update;
    const inside = useRef(false);
    const container = useRef<HTMLDivElement>(null);
    const rows = useMemo(() => data.series.data.flatMap((series) => {
        if (series.type !== 'line') return [];
        const point = series.data.find((p) => p.x === selectedX);
        return [{name: shortName(series.name ?? ''), color: typeof series.color === 'string' ? series.color : '#8e8c99',
            value: typeof point?.y === 'number' && Number.isFinite(point.y) ? point.y : null}];
    }), [data, selectedX]);
    const readout = useRef<HTMLDivElement>(null);
    const anchorColor = rows.find((row) => row.value !== null)?.color;
    const {padding, layout} = useLinkedChartLayout(container, readout, selectedX, anchorColor, Boolean(hover));
    const linkedData = useMemo<ChartData>(() => {
        if (!update) return data;
        return {
            ...data,
            chart: {...data.chart, margin: {...data.chart?.margin, left: padding.left, right: padding.right}, events: {...data.chart?.events, pointermove: (payload) => {
                // Перерисовка может повторить прошлое событие другого графика.
                if (!inside.current || !container.current?.matches(':hover')) return;
                const point = payload?.hovered.find((item) => item.closest) ?? payload?.hovered[0];
                const x = point && 'x' in point.data ? point.data.x : undefined;
                update(typeof x === 'number' && Number.isFinite(x) ? x : null);
            }}},
            tooltip: {...data.tooltip, enabled: false, pin: {...data.tooltip?.pin, enabled: false}},
            xAxis: {...data.xAxis, plotLines: [
                ...(data.xAxis?.plotLines ?? []),
                ...(selectedX === null ? [] : [{value: selectedX, color: '#8e8c99', dashStyle: 'Dash' as const,
                    width: 1.5, layerPlacement: 'after' as const}]),
            ]},
        };
    }, [data, selectedX, update, padding]);
    if (!hover) return <Chart data={data} />;
    return <div ref={container} className="linked-chart" onPointerEnter={() => {inside.current = true;}}
        onPointerLeave={() => {inside.current = false; update?.(null);}}>
        <Chart data={linkedData} />
        {layout && anchorColor && <span className="linked-chart-anchor" style={{left: layout.x, top: layout.y, background: anchorColor}} />}
        {selectedX !== null && <div ref={readout} className="linked-chart-readout" data-time={selectedX / 1000}
            style={layout ? {left: layout.left, top: layout.top} : {visibility: 'hidden'}}>
            <strong className="linked-chart-readout__time">{formatTime(selectedX / 1000, clock)}</strong>
            {rows.map((row, index) => <div className="linked-chart-readout__row" key={index}>
                <span className="linked-chart-readout__dot" style={{background: row.color}} />
                <span className="linked-chart-readout__name">{row.name}</span>
                <strong>{row.value === null ? 'Нет данных' : formatNumber(row.value, 2)}</strong>
            </div>)}
        </div>}
    </div>;
}
