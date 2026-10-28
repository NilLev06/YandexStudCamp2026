// 7 групп ошибок и ответы на вопросы кейса - то же, что в документе «Ошибки датчиков - математическая база»
import {Button, Card, Flex, Label, Table, Text} from '@gravity-ui/uikit';

import {DOC_URL, GROUPS} from '../groups';

const DECISIONS = [
    {
        q: 'Что считается нормой при разных режимах датчика',
        a: 'Свой эталон μ, σ на каждый режим (группа 4). Источник: паспорт, ручная настройка, калибровка по здоровому интервалу или автокалибровка по первым N отсчётам режима (медиана и 1.4826·MAD). Режим без эталона - «нет оценки», а не тревога.',
    },
    {
        q: 'Какая задержка приемлема и сколько ложных тревог допускается',
        a: 'Бюджет: 0 ложных тревог на одиночный выброс и на смену режима. За это платим задержкой: окно 3 с, ожидание опозданий 2 с, порог CUSUM h = 10 и подтверждение 2 из 3 окон. На 250 прогонах сценариев кейса: 200 из 200 событий, 0 ложных, дрейф - около 21 с, пропуск - 6 с.',
    },
    {
        q: 'Как трактовать пропуск данных и время события',
        a: 'Два времени: когда измерено (event_time) и когда пришло (received_at, ставит шлюз). Окна строятся по времени события, решение - по времени прихода. Свежесть - отдельный таймер (группа 3): старая пачка после пропуска означает «доставка есть, свежих данных нет», закрывают инцидент только 3 свежих отсчёта подряд.',
    },
];

export function AboutPage() {
    return (
        <Flex direction="column" gap={4} className="sw-page">
            <Flex justifyContent="space-between" alignItems="flex-start" gap={3} wrap>
                <Flex direction="column" gap={1}>
                    <Text variant="header-2">7 групп ошибок</Text>
                    <Text color="secondary">
                        14 случаев из документа сводятся к 7 группам: внутри группы один детектор и одна реакция. Группы 1-4 требует кейс, 5-7 -
                        наше расширение.
                    </Text>
                </Flex>
                <Button view="outlined" href={DOC_URL} target="_blank">
                    Открыть документ
                </Button>
            </Flex>
            <Card view="outlined" className="sw-panel">
                <Table
                    width="max"
                    wordWrap
                    data={GROUPS}
                    columns={[
                        {
                            id: 'g',
                            name: 'Группа',
                            template: (g) => (
                                <Flex gap={2} alignItems="center">
                                    <span className={`sw-group-num ${g.required ? '' : 'sw-group-num_ext'}`}>{g.id}</span>
                                    <Text variant="subheader-1">{g.title}</Text>
                                </Flex>
                            ),
                        },
                        {
                            id: 'cases',
                            name: 'Случаи документа и сценарий проверки',
                            template: (g) => (
                                <Flex direction="column" gap={1}>
                                    {g.variants.map((v) => (
                                        <Text key={v.label}>
                                            <b>{v.cases}</b> · {v.label}{' '}
                                            <Text color="secondary" variant="code-1">
                                                {v.scenario ?? 'дрон'}
                                            </Text>
                                        </Text>
                                    ))}
                                </Flex>
                            ),
                        },
                        {
                            id: 'req',
                            name: 'Нужно',
                            template: (g) => <Label theme={g.required ? 'info' : 'utility'} size="xs">{g.required ? 'кейс' : 'расширение'}</Label>,
                        },
                        {id: 'detector', name: 'Чем ловим', template: (g) => g.detector},
                        {id: 'formula', name: 'Формула', template: (g) => <code className="sw-formula">{g.formula}</code>},
                        {id: 'reaction', name: 'Реакция', template: (g) => g.reaction},
                    ]}
                />
            </Card>
            <Text variant="subheader-3">Ответы на вопросы кейса</Text>
            {DECISIONS.map((d) => (
                <Card key={d.q} view="outlined" className="sw-panel">
                    <Flex direction="column" gap={2}>
                        <Text variant="subheader-2">{d.q}</Text>
                        <Text>{d.a}</Text>
                    </Flex>
                </Card>
            ))}
        </Flex>
    );
}
