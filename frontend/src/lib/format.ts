import type {LabelProps} from '@gravity-ui/uikit';

import type {AvailabilityStatus, Clock, IncidentType, QualityStatus} from '../api/types';

type Theme = NonNullable<LabelProps['theme']>;

export const QUALITY: Record<QualityStatus, {text: string; theme: Theme}> = {
    normal: {text: 'Норма', theme: 'success'},
    suspect: {text: 'Подозрение', theme: 'warning'},
    alarm: {text: 'Тревога', theme: 'danger'},
    unknown: {text: 'Нет оценки', theme: 'unknown'},
};

export const AVAILABILITY: Record<AvailabilityStatus, {text: string; theme: Theme}> = {
    fresh: {text: 'Данные свежие', theme: 'success'},
    stale: {text: 'Данные устарели', theme: 'danger'},
    unknown: {text: 'Нет измерений', theme: 'unknown'},
};

export const INCIDENT: Record<IncidentType, {text: string; short: string; theme: Theme; color: string}> = {
    quality: {text: 'Деградация качества', short: 'Качество', theme: 'danger', color: '#e5484d'},
    availability: {text: 'Нет свежих данных', short: 'Свежесть', theme: 'danger', color: '#e5484d'},
    flags: {text: 'Непригодные измерения', short: 'Непригодные', theme: 'danger', color: '#e5484d'},
    noise: {text: 'Повышенный разброс', short: 'Шум', theme: 'danger', color: '#e5484d'},
    stuck: {text: 'Подозрение на залипание', short: 'Залипание', theme: 'danger', color: '#e5484d'},
    saturation: {text: 'Насыщение диапазона', short: 'Насыщение', theme: 'danger', color: '#e5484d'},
    rate: {text: 'Снижение частоты', short: 'Частота', theme: 'danger', color: '#e5484d'},
    latency: {text: 'Старые сообщения', short: 'Опоздания', theme: 'danger', color: '#e5484d'},
};

export const SIMULATION_STATE = {
    running: {text: 'Идёт', theme: 'info'},
    finished: {text: 'Завершена', theme: 'success'},
    stopped: {text: 'Остановлена', theme: 'unknown'},
} satisfies Record<string, {text: string; theme: Theme}>;

const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');

/** Модельные секунды показываем как мм:сс, секунды Unix — как локальное время. */
export function formatTime(t: number | null | undefined, clock: Clock): string {
    if (t === null || t === undefined) return '—';
    if (clock === 'virtual') return pad(t / 60) + ':' + pad(t % 60);
    return new Date(t * 1000).toLocaleTimeString('ru-RU');
}

export const formatDateTime = (wall: number) => new Date(wall * 1000).toLocaleString('ru-RU');

export function formatDuration(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined) return '—';
    const s = Math.round(seconds);
    if (Math.abs(s) < 60) return `${s} с`;
    const sign = s < 0 ? '−' : '';
    const a = Math.abs(s);
    return `${sign}${Math.floor(a / 60)} мин ${a % 60} с`;
}

export const formatNumber = (v: number | null | undefined, digits = 1) =>
    v === null || v === undefined ? '—' : v.toFixed(digits).replace('.', ',');

/** Ось datetime принимает миллисекунды UTC; модельное время отсчитывается от нуля без часового сдвига. */
export const toChartX = (t: number, _clock: Clock) => t * 1000;

export const chartDateFormat = (clock: Clock) => (clock === 'virtual' ? 'mm:ss' : 'HH:mm:ss');

/** Подсказка использует те же модельные часы, что и ось, без даты 1970 года. */
export function chartTimeHeader(clock: Clock) {
    return {
        type: 'custom' as const,
        formatter: ({value}: {value: unknown}) => {
            const x = Number(value);
            const seconds = x / 1000;
            return formatTime(seconds, clock);
        },
    };
}
