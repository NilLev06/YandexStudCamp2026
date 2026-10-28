// Живая подсказка: одна фраза о том, что сейчас происходит и почему монитор так решил
import type {Frame, Message, MonitorEvent} from '../api/types';
import {GROUP_OF_INCIDENT} from '../groups';
import type {IncidentType} from '../api/types';

export type Tone = 'info' | 'success' | 'warning' | 'danger';

export interface Narration {
    text: string;
    tone: Tone;
    group?: number;
}

const f1 = (v: number | null | undefined) => (v === null || v === undefined ? '-' : v.toFixed(1));

const OPEN: Record<string, (e: MonitorEvent) => Narration> = {
    quality: () => ({
        tone: 'danger',
        group: 2,
        text: 'Тревога: деградация подтверждена. CUSUM дошёл до порога, и 2 из 3 последних окон тоже плохие - это не случайность.',
    }),
    availability: () => ({
        tone: 'danger',
        group: 3,
        text: 'Нет свежих данных дольше 6 с. Это проблема канала связи, а не самого датчика - поэтому отдельный инцидент.',
    }),
    stuck: () => ({tone: 'danger', group: 5, text: 'Датчик замер: значение не меняется 4 окна подряд, шум пропал. Таким данным не доверяем, CUSUM на паузе.'}),
    noise: () => ({tone: 'warning', group: 6, text: 'Разброс вырос в несколько раз, хотя среднее в норме. Это рост шума, а не дрейф.'}),
    rate: () => ({tone: 'warning', group: 3, text: 'Отсчёты приходят заметно реже нормы: окна пустеют, оценке качества не на что опереться.'}),
    flags: () => ({tone: 'warning', group: 3, text: 'Больше половины отсчётов в окне помечены источником как невалидные.'}),
};

const CLOSE: Record<string, Narration> = {
    quality: {tone: 'success', group: 2, text: 'Деградация закончилась: 5 окон подряд в норме. Инцидент закрыт, CUSUM сброшен в 0.'},
    availability: {tone: 'success', group: 3, text: 'Свежие данные вернулись: 3 свежих отсчёта подряд. Инцидент свежести закрыт.'},
    stuck: {tone: 'success', group: 5, text: 'Датчик снова «живой»: значение меняется, оценка качества продолжается.'},
    noise: {tone: 'success', group: 6, text: 'Разброс вернулся к норме.'},
    rate: {tone: 'success', group: 3, text: 'Частота отсчётов вернулась к норме.'},
    flags: {tone: 'success', group: 3, text: 'Доля невалидных отсчётов снова ниже порога.'},
};

interface Input {
    frames: Frame[];          // кадры монитора до текущего момента
    events: MonitorEvent[];   // журнал до текущего момента
    recent: Message[];        // отсчёты, пришедшие за последние секунды
    h: number;
    staleAfter: number;
    started: boolean;
}

export function narrate({frames, events, recent, h, staleAfter, started}: Input): Narration {
    const f = frames.at(-1);
    if (!started || !f) return {tone: 'info', text: 'Выберите группу и нажмите ▶ - монитор будет объяснять каждое своё решение.'};
    const now = f.now;

    // 1. Свежие решения монитора (последние 4 с)
    const ev = [...events].reverse().find((e) => now - e.time <= 4 && e.time <= now);
    if (ev) {
        if (ev.kind === 'open' && OPEN[ev.type]) return OPEN[ev.type](ev);
        if (ev.kind === 'close' && CLOSE[ev.type]) return CLOSE[ev.type];
        if (ev.kind === 'mode')
            return {tone: 'info', group: 4, text: `Смена режима: ${ev.text.split(';')[0]}. У нового режима своя норма - это не ошибка, тревоги нет.`};
        if (ev.kind === 'calibrated') return {tone: 'info', group: 4, text: `Эталон режима откалиброван: ${ev.text.replace(/^Эталон режима /, '')}.`};
        if (ev.kind === 'unknown_mode') return {tone: 'info', group: 4, text: 'Новый режим без эталона: монитор копит отсчёты, чтобы узнать его норму.'};
    }

    // 2. Пришла пачка старых отсчётов
    const prev = frames.at(-4);
    const late = (f.late_count ?? 0) - (prev?.late_count ?? 0);
    if (late > 0) {
        return {
            tone: 'warning',
            group: 3,
            text: `Пришла пачка старых отсчётов (${late} шт.). Доставка работает, но данные старые - инцидент свежести не закрываем.`,
        };
    }

    // 3. Одиночный выброс: точка далеко от нормы, а тревоги нет
    if (f.norm !== null && f.sigma !== null && f.quality !== 'alarm') {
        const far = recent.find((m) => m.value !== null && Math.abs(m.value - (f.norm as number)) > 6 * (f.sigma as number));
        if (far && far.value !== null) {
            return {
                tone: 'info',
                group: 1,
                text: `Одиночный выброс: точка ${f1(far.value)} далеко от нормы ${f1(f.norm)}. Медиана окна его не замечает - тревоги нет.`,
            };
        }
    }

    // 4. Текущее состояние
    const diag = f.diagnostics ?? {};
    if (f.availability === 'stale')
        return {tone: 'danger', group: 3, text: `Ждём данные: последний пригодный отсчёт был ${f1(f.age)} с назад (порог ${staleAfter} с).`};
    if (diag.stuck === 'alarm') return {tone: 'danger', group: 5, text: 'Датчик всё ещё замер. Оценка качества приостановлена.'};
    if (f.quality === 'alarm')
        return {tone: 'danger', group: 2, text: 'Деградация продолжается. Чтобы закрыть тревогу, нужно 5 нормальных окон подряд - одна удачная точка не считается.'};
    if (diag.noise === 'alarm') return {tone: 'warning', group: 6, text: `Шум повышен: разброс примерно в ${f1(f.noise_ratio)} раза больше эталона.`};
    if (f.quality === 'suspect')
        return {tone: 'warning', group: 2, text: `Отклонения копятся: CUSUM ${f1(f.s)} из ${h}. Тревоги ещё нет - ждём, будет ли это устойчиво.`};
    if (f.quality === 'unknown' && !f.mode_known)
        return {tone: 'info', group: 4, text: 'Режим без эталона: качество пока не оцениваем, только свежесть.'};
    if (f.quality === 'unknown') return {tone: 'info', text: 'Мало данных для оценки окна - ждём следующие отсчёты.'};
    if (f.s > 1) return {tone: 'info', group: 2, text: `Небольшие отклонения: CUSUM ${f1(f.s)} из ${h}. Пока это похоже на обычный шум.`};
    return {tone: 'success', text: `Всё в норме: медиана окна около нормы ${f1(f.norm)}, CUSUM ≈ 0.`};
}

export const groupOfIncident = (t: string) => GROUP_OF_INCIDENT[t as IncidentType];
