import {Alert, Flex, Label, Loader, SegmentedRadioGroup, Select, Table, Text} from '@gravity-ui/uikit';
import {useMemo, useRef, useState} from 'react';
import {useNavigate} from 'react-router-dom';

import {api} from '../api/client';
import type {Incident, IncidentType} from '../api/types';
import {Page, Panel} from '../components/Page';
import {IncidentTimeline} from '../components/charts';
import {useAsync} from '../hooks/useAsync';
import {useStream} from '../hooks/useStream';
import {INCIDENT, formatDateTime, formatDuration} from '../lib/format';

type StateFilter = 'all' | 'open' | 'closed';

export function IncidentsPage() {
    const navigate = useNavigate();
    const [type, setType] = useState<IncidentType | 'all'>('all');
    const [state, setState] = useState<StateFilter>('all');
    const {data, error, loading, reload} = useAsync(
        () => api.incidents({type: type === 'all' ? undefined : type, state: state === 'all' ? undefined : state}),
        [type, state],
    );
    const pending = useRef<number | null>(null);
    useStream((m) => {
        if (m.type === 'update' && !m.events.some((e) => e.incident_id !== null)) return;
        if (pending.current === null) pending.current = window.setTimeout(() => ((pending.current = null), reload()), 500);
    });

    const now = Date.now() / 1000;
    const timeline = useMemo(
        () =>
            (data ?? []).map((i) => ({
                row: i.sensor_id,
                type: i.type,
                from: i.opened_at,
                to: i.closed_at ?? now,
                label: INCIDENT[i.type].text,
            })),
        [data, now],
    );

    return (
        <Page title="Инциденты" subtitle="Все сенсоры; время на шкале — часы gateway">
            <Flex gap={3} wrap alignItems="center">
                <Select
                    width={240}
                    value={[type]}
                    onUpdate={([v]) => setType(v as IncidentType | 'all')}
                    options={[{value: 'all', content: 'Все типы'}, ...Object.entries(INCIDENT).map(([value, m]) => ({value, content: m.text}))]}
                />
                <SegmentedRadioGroup
                    value={state}
                    onUpdate={(v) => setState(v as StateFilter)}
                    options={[
                        {value: 'all', content: 'Все'},
                        {value: 'open', content: 'Открытые'},
                        {value: 'closed', content: 'Закрытые'},
                    ]}
                />
            </Flex>
            {error && <Alert theme="danger" title="Не удалось загрузить инциденты" message={error.message} />}
            {loading && !data ? (
                <Loader />
            ) : (
                <>
                    {timeline.length > 0 && (
                        <Panel title="Шкала инцидентов">
                            <IncidentTimeline items={timeline} />
                        </Panel>
                    )}
                    <Panel title={`Список · ${data?.length ?? 0}`}>
                        <Table
                            data={data ?? []}
                            width="max"
                            emptyMessage="Инцидентов нет"
                            onRowClick={(i: Incident) => navigate('/sensors/' + encodeURIComponent(i.sensor_id))}
                            columns={[
                                {id: 'sensor_id', name: 'Сенсор'},
                                {id: 'type', name: 'Тип', template: (i: Incident) => <Label theme={INCIDENT[i.type].theme}>{INCIDENT[i.type].text}</Label>},
                                {id: 'state', name: 'Статус', template: (i: Incident) => (i.state === 'open' ? <Label theme="danger">открыт</Label> : <Label theme="success">закрыт</Label>)},
                                {id: 'opened_at', name: 'Открыт', template: (i: Incident) => formatDateTime(i.opened_at)},
                                {id: 'closed_at', name: 'Закрыт', template: (i: Incident) => (i.closed_at ? formatDateTime(i.closed_at) : '—')},
                                {id: 'duration', name: 'Длительность', align: 'end', template: (i: Incident) => (i.end === null ? '—' : formatDuration(i.end - i.start))},
                                {id: 'reason', name: 'Причина', template: (i: Incident) => <Text>{i.reason}</Text>},
                            ]}
                        />
                    </Panel>
                </>
            )}
        </Page>
    );
}
