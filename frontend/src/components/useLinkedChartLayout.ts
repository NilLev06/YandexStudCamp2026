import {useCallback, useLayoutEffect, useRef, useState, type RefObject} from 'react';

type Layout = {time: number; x: number; y: number; left: number; top: number};

/** Measures rendered axes, compensates their widths and anchors readouts to the series. */
export function useLinkedChartLayout(container: RefObject<HTMLDivElement>, readout: RefObject<HTMLDivElement>,
    selectedX: number | null, color: string | undefined, enabled: boolean) {
    const [padding, setPadding] = useState({left: 0, right: 0});
    const [layout, setLayout] = useState<Layout | null>(null);
    const pending = useRef(0);
    const measure = useRef<() => void>(() => {});
    const schedule = useCallback(() => {
        if (!pending.current) pending.current = requestAnimationFrame(() => {
            pending.current = 0;
            measure.current();
        });
    }, []);
    measure.current = () => {
        const root = container.current;
        const svg = root?.querySelector('svg');
        const domain = root?.querySelector('.gcharts-x-axis__domain');
        if (!root || !svg || !domain) return;
        const box = root.getBoundingClientRect();
        const svgBox = svg.getBoundingClientRect();
        const bounds = domain.getBoundingClientRect();
        // A resize is asynchronous; wait until the SVG matches its container.
        if (!box.width || Math.abs(svgBox.width - box.width) > 1) return;
        const left = Math.max(0, 80 - (bounds.left - box.left - padding.left));
        const right = Math.max(0, 16 - (box.right - bounds.right - padding.right));
        if (Math.abs(left - padding.left) > 0.5 || Math.abs(right - padding.right) > 0.5)
            setPadding({left, right});
        if (selectedX === null || !readout.current) return;
        const cursor = root.querySelector<SVGPathElement>('path[stroke="#8e8c99"][stroke-dasharray]');
        if (!cursor) return;
        const plot = cursor.getBoundingClientRect();
        const screenX = plot.left;
        type SeriesPath = SVGPathElement & {__data__?: {color?: string;
            points?: {x: number | null; y: number | null; data: {x?: number}}[]}};
        // Gravity changes stroke on hover; use the original series color and
        // the exact projected sample rather than guessing a position on a path.
        const path = color ? [...root.querySelectorAll<SeriesPath>('path[stroke]')].find((p) =>
            p.__data__?.color === color && Array.isArray(p.__data__?.points) &&
            !p.closest('.gcharts-legend')) : undefined;
        const point = path?.__data__?.points?.find((p) => p.data.x === selectedX);
        const matrix = path?.getScreenCTM();
        if (!point || point.x === null || point.y === null || !matrix) {
            setLayout(null);
            return;
        }
        const screenY = new DOMPoint(point.x, point.y).matrixTransform(matrix).y;
        const card = readout.current.getBoundingClientRect();
        const x = screenX - box.left, y = screenY - box.top;
        const fitsRight = x + 12 + card.width <= box.width - 8;
        const fitsLeft = x - card.width - 12 >= 8;
        const preferredLeft = fitsRight ? x + 12 : fitsLeft ? x - card.width - 12 : x - card.width / 2;
        // On narrow screens place the readout above/below instead of covering its point.
        const preferredTop = fitsRight || fitsLeft ? y - card.height / 2 :
            y - card.height - 12 >= plot.top - box.top + 8 ? y - card.height - 12 : y + 12;
        const next = {time: selectedX, x, y,
            left: Math.max(8, Math.min(box.width - card.width - 8, preferredLeft)),
            top: Math.max(plot.top - box.top + 8,
                Math.min(plot.bottom - box.top - card.height - 8, preferredTop))};
        setLayout((previous) => previous && previous.time === next.time &&
            (['x', 'y', 'left', 'top'] as const).every((key) => Math.abs(previous[key] - next[key]) < 0.5) ? previous : next);
    };
    useLayoutEffect(() => {
        const root = container.current;
        if (!enabled || !root) return;
        const resize = new ResizeObserver(schedule);
        const mutation = new MutationObserver(schedule);
        resize.observe(root);
        mutation.observe(root, {subtree: true, childList: true, attributes: true});
        schedule();
        return () => {
            resize.disconnect(); mutation.disconnect();
            cancelAnimationFrame(pending.current); pending.current = 0;
        };
    }, [container, enabled, schedule]);
    useLayoutEffect(schedule, [selectedX, color, padding, schedule]);
    return {padding, layout: layout?.time === selectedX ? layout : null};
}
