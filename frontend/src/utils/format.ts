// Подписи, цвета статусов и форматирование времени
import type {LabelProps} from '@gravity-ui/uikit';

import type {Availability, ClockKind, IncidentType, Quality} from '../api/types';

type Theme = NonNullable<LabelProps['theme']>;

export const QUALITY: Record<Quality, {text: string; theme: Theme; hint: string}> = {
    normal: {text: 'Норма', theme: 'success', hint: 'Медианы окон в пределах эталона режима'},
    suspect: {text: 'Подозрение', theme: 'warning', hint: 'CUSUM накапливается, но подтверждения ещё нет'},
    alarm: {text: 'Деградация', theme: 'danger', hint: 'Устойчивое отклонение подтверждено последними окнами'},
    unknown: {text: 'Нет оценки', theme: 'unknown', hint: 'Нет свежих окон или режим без эталона'},
};

export const AVAILABILITY: Record<Availability, {text: string; theme: Theme; hint: string}> = {
    fresh: {text: 'Данные свежие', theme: 'success', hint: 'Последнее пригодное измерение моложе порога'},
    stale: {text: 'Данные устарели', theme: 'danger', hint: 'Нет пригодных свежих измерений дольше порога'},
    unknown: {text: 'Нет данных', theme: 'unknown', hint: 'Измерений ещё не было'},
};

export const INCIDENT: Record<IncidentType, {text: string; theme: Theme; color: string}> = {
    quality: {text: 'Деградация качества', theme: 'danger', color: 'rgba(255, 61, 100, 0.16)'},
    availability: {text: 'Нет свежих данных', theme: 'warning', color: 'rgba(255, 190, 92, 0.25)'},
    flags: {text: 'Невалидные флаги', theme: 'warning', color: 'rgba(255, 190, 92, 0.18)'},
    stuck: {text: 'Залипание', theme: 'info', color: 'rgba(130, 90, 230, 0.16)'},
    noise: {text: 'Рост шума', theme: 'info', color: 'rgba(130, 90, 230, 0.12)'},
    rate: {text: 'Частота отсчётов', theme: 'info', color: 'rgba(90, 150, 230, 0.14)'},
};

export const DIAG: Record<'stuck' | 'noise' | 'rate', string> = {
    stuck: 'залипание',
    noise: 'шум',
    rate: 'частота',
};

const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');

// Модельное время - mm:ss от начала сценария; настенное - время суток
export function fmtTime(t: number | null | undefined, clock: ClockKind): string {
    if (t === null || t === undefined || !Number.isFinite(t)) return '-';
    if (clock === 'sim') {
        const s = Math.max(0, t);
        return `${pad(s / 60)}:${pad(s % 60)}`;
    }
    return new Date(t * 1000).toLocaleTimeString('ru-RU');
}

export function fmtDuration(sec: number | null | undefined): string {
    if (sec === null || sec === undefined || !Number.isFinite(sec)) return '-';
    if (Math.abs(sec) < 60) return `${sec.toFixed(Math.abs(sec) < 10 ? 1 : 0)} с`;
    const m = Math.floor(Math.abs(sec) / 60);
    return `${sec < 0 ? '-' : ''}${m} мин ${pad(Math.abs(sec) % 60)} с`;
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
    if (v === null || v === undefined || !Number.isFinite(v)) return '-';
    const a = Math.abs(v);
    if (a !== 0 && (a < 0.01 || a >= 1e5)) return v.toExponential(2);
    return v.toFixed(digits);
}

// Для оси графика: модельные секунды остаются секундами, настенные - в миллисекунды (datetime)
export const toAxis = (t: number, clock: ClockKind) => (clock === 'wall' ? t * 1000 : t);
