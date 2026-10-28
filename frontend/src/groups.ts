// 7 групп ошибок - те же номера и названия, что в документе «Ошибки датчиков - математическая база»
// (раздел «Главное: 7 групп вместо 14 случаев»). Интерфейс и документ должны совпадать.
import type {IncidentType} from './api/types';

export const DOC_URL = 'https://claude.ai/artifact/DoA9mYEAqFavfL7k2uhLYi';

export interface Group {
    id: number;
    title: string;
    cases: string;            // номера случаев из раздела 7 документа
    required: boolean;        // требует кейс (1-4) или наше расширение (5-7)
    what: string;             // что происходит, одной фразой
    detector: string;         // чем ловим
    formula: string;          // формула (как в документе, простым текстом)
    reaction: string;         // что делаем
    scenario?: string;        // сценарий шлюза для демонстрации
    live?: string;            // или живой канал дрона
}

export const GROUPS: Group[] = [
    {
        id: 1,
        title: 'Выброс',
        cases: '1',
        required: true,
        what: 'Одна точка резко ушла и вернулась',
        detector: 'Медиана окна + подтверждение по нескольким окнам',
        formula: 'm = median(окно 3 с),  z = clip((μ - m)/σ, ±4.5)',
        reaction: 'Тревоги нет: отсчёт не влияет на медиану',
        scenario: 'spike',
    },
    {
        id: 2,
        title: 'Дрейф',
        cases: '2, 3, 4, 5',
        required: true,
        what: 'Значение устойчиво уходит от нормы (плавно или ступенькой)',
        detector: 'CUSUM по медианам окон',
        formula: 'S = max(0, S + z - k);  тревога: S ≥ h и 2 из 3 окон z > 1.2;  закрыть: 5 окон |z| < 1.35',
        reaction: 'Предупредить, компенсировать или перекалибровать',
        scenario: 'drift',
    },
    {
        id: 3,
        title: 'Пропуск и время',
        cases: '9, 10, 11',
        required: true,
        what: 'Данные не приходят или приходят поздно, старой пачкой',
        detector: 'Таймер свежести, независимый от прихода сообщений',
        formula: 'возраст = t_сейчас - t_последнего пригодного;  тревога: возраст > 6 с;  закрыть: 3 свежих подряд',
        reaction: '«Нет данных» - проблема канала, а не объекта',
        scenario: 'gap',
    },
    {
        id: 4,
        title: 'Смена режима',
        cases: 'не ошибка',
        required: true,
        what: 'Датчик перешёл в другой режим с другим нормальным уровнем',
        detector: 'Свой эталон μ, σ на каждый режим',
        formula: 'z считается по эталону текущего режима',
        reaction: 'Тревоги нет',
        scenario: 'mode',
    },
    {
        id: 5,
        title: 'Залипание',
        cases: '6, 8, 12',
        required: false,
        what: 'Значение замерло, шум пропал',
        detector: 'Размах окна ≈ 0 несколько окон подряд',
        formula: 'max - min = 0 в 4 окнах подряд',
        reaction: 'Данным не доверяем, CUSUM на паузе',
        scenario: 'stuck',
    },
    {
        id: 6,
        title: 'Рост шума',
        cases: '7, 13',
        required: false,
        what: 'Среднее в норме, разброс вырос',
        detector: 'Разброс внутри окна относительно σ эталона',
        formula: 'σ_окна = RMS(разностей)/√2;  тревога: медиана(σ_окна/σ, 8 окон) ≥ 2.5',
        reaction: 'Предупредить',
        scenario: 'noise',
    },
    {
        id: 7,
        title: 'Сравнение',
        cases: '14',
        required: false,
        what: 'Две величины должны совпадать, но расходятся',
        detector: 'Невязка между командой и измерением (у дрона - обороты мотора)',
        formula: 'r = y_изм / y_команда;  тот же CUSUM по r',
        reaction: 'Компенсировать (дрон добавляет обороты изношенному мотору)',
        live: 'mavic.motor3',
    },
];

// Какой группе документа соответствует тип инцидента монитора
export const GROUP_OF_INCIDENT: Record<IncidentType, number> = {
    quality: 2,
    availability: 3,
    flags: 3,
    rate: 3,
    stuck: 5,
    noise: 6,
};

export const groupById = (id: number | undefined) => GROUPS.find((g) => g.id === id);
