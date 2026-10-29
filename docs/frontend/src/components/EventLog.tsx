import {Flex, Label, Text} from '@gravity-ui/uikit';

import type {Clock, IncidentType} from '../api/types';
import {INCIDENT, formatTime} from '../lib/format';

export interface LogEvent {
    time: number;
    kind: string;
    type: string;
    text: string;
    seq?: number;
}

function title(e: LogEvent) {
    if (e.kind === 'mode') return <Label theme="info">Смена режима</Label>;
    if (e.kind === 'unknown_mode') return <Label theme="warning">Неизвестный режим</Label>;
    const meta = INCIDENT[e.type as IncidentType];
    const opened = e.kind === 'open';
    return <Label theme={opened ? meta?.theme ?? 'danger' : 'success'}>{(opened ? 'Открыт: ' : 'Закрыт: ') + (meta?.text ?? e.type)}</Label>;
}

export function EventLog({events, clock, limit = 30}: {events: LogEvent[]; clock: Clock; limit?: number}) {
    if (!events.length) return <Text color="secondary">Событий пока нет. Монитор ждёт устойчивых признаков проблемы.</Text>;
    return (
        <Flex direction="column" gap={3}>
            {events
                .slice(-limit)
                .reverse()
                .map((e, i) => (
                    <Flex key={e.seq ?? i} gap={3} alignItems="flex-start">
                        <Text variant="code-1" color="secondary" style={{minWidth: 64}}>
                            {formatTime(e.time, clock)}
                        </Text>
                        <Flex direction="column" gap={1}>
                            {title(e)}
                            <Text>{e.text}</Text>
                        </Flex>
                    </Flex>
                ))}
        </Flex>
    );
}
