// Все инциденты: фильтры по состоянию, типу и датчику, подтверждение оператором
import {useCallback, useEffect, useState} from 'react';
import {Card, Flex, SegmentedRadioGroup, Select, Text} from '@gravity-ui/uikit';

import {api} from '../api/client';
import {useIncidentsVersion, useSensors} from '../api/live';
import type {Incident} from '../api/types';
import {IncidentsTable} from '../components/common';
import {INCIDENT} from '../utils/format';

export function IncidentsPage() {
    const sensors = useSensors();
    const version = useIncidentsVersion();
    const [state, setState] = useState('open');
    const [type, setType] = useState('all');
    const [sensor, setSensor] = useState('all');
    const [items, setItems] = useState<Incident[]>([]);

    const load = useCallback(() => {
        api.incidents({
            state: state === 'all' ? undefined : state,
            type: type === 'all' ? undefined : type,
            sensor_id: sensor === 'all' ? undefined : sensor,
        })
            .then(setItems)
            .catch(() => setItems([]));
    }, [state, type, sensor]);

    useEffect(load, [load, version]);

    return (
        <Flex direction="column" gap={4} className="sw-page">
            <Flex direction="column" gap={1}>
                <Text variant="header-2">Инциденты</Text>
                <Text color="secondary">
                    Инцидент открывает и закрывает только монитор. Оператор отмечает, что увидел его; комментарий сохраняется в карточке.
                </Text>
            </Flex>
            <Flex gap={2} wrap alignItems="flex-end">
                <SegmentedRadioGroup
                    value={state}
                    onUpdate={setState}
                    options={[
                        {value: 'open', content: 'Открытые'},
                        {value: 'closed', content: 'Закрытые'},
                        {value: 'all', content: 'Все'},
                    ]}
                />
                <Select
                    width={240}
                    value={[type]}
                    onUpdate={(v) => setType(v[0])}
                    options={[{value: 'all', content: 'Все типы'}, ...Object.entries(INCIDENT).map(([k, v]) => ({value: k, content: v.text}))]}
                />
                <Select
                    width={280}
                    value={[sensor]}
                    onUpdate={(v) => setSensor(v[0])}
                    filterable
                    options={[{value: 'all', content: 'Все датчики'}, ...sensors.map((s) => ({value: s.id, content: s.name}))]}
                />
            </Flex>
            <Card view="outlined" className="sw-panel">
                <IncidentsTable
                    incidents={items}
                    clockOf={(id) => sensors.find((s) => s.id === id)?.clock ?? 'wall'}
                    onChanged={load}
                />
            </Card>
        </Flex>
    );
}
