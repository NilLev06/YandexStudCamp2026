// Небольшие общие компоненты: метки статусов, таблица метрик, журнал, таблица инцидентов
import {useState} from 'react';
import {Button, Dialog, Flex, Label, Table, Text, TextArea, TextInput, Tooltip} from '@gravity-ui/uikit';
import type {TableColumnConfig} from '@gravity-ui/uikit';
import {Link} from 'react-router-dom';

import {api} from '../api/client';
import type {ClockKind, Incident, IncidentType, Metrics, MonitorEvent, Status} from '../api/types';
import {AVAILABILITY, DIAG, INCIDENT, QUALITY, fmtDuration, fmtTime} from '../utils/format';
import {localStorageGet, localStorageSet} from '../utils/storage';

export function StatusLabels({status, size = 's'}: {status: Status | null; size?: 'xs' | 's' | 'm'}) {
    if (!status) return <Label theme="unknown" size={size}>Ждём первый тик</Label>;
    const q = QUALITY[status.quality];
    const a = AVAILABILITY[status.availability];
    const diag = Object.entries(status.diagnostics ?? {}).filter(([, v]) => v === 'alarm');
    return (
        <Flex gap={1} wrap>
            <Tooltip content={q.hint}>
                <Label theme={q.theme} size={size}>{q.text}</Label>
            </Tooltip>
            <Tooltip content={a.hint}>
                <Label theme={a.theme} size={size}>{a.text}</Label>
            </Tooltip>
            {status.flags === 'degraded' && <Label theme="warning" size={size}>Флаги</Label>}
            {diag.map(([k]) => (
                <Label key={k} theme="info" size={size}>{DIAG[k as keyof typeof DIAG]}</Label>
            ))}
            {!status.mode_known && status.mode !== '-' && (
                <Tooltip content="Для режима нет эталона: копим отсчёты для автокалибровки или задайте эталон вручную">
                    <Label theme="unknown" size={size}>режим {status.mode} без эталона</Label>
                </Tooltip>
            )}
        </Flex>
    );
}

export function DiagLabels({status}: {status: Status | null}) {
    if (!status) return <Label theme="unknown" size="xs">нет данных</Label>;
    const diag = Object.entries(status.diagnostics ?? {}).filter(([, v]) => v === 'alarm');
    if (!diag.length && status.flags !== 'degraded') return <Label theme="success" size="xs">Отклонений нет</Label>;
    return (
        <Flex gap={1} wrap>
            {status.flags === 'degraded' && <Label theme="warning" size="xs">невалидные флаги</Label>}
            {diag.map(([k]) => (
                <Label key={k} theme="info" size="xs">{DIAG[k as keyof typeof DIAG]}</Label>
            ))}
        </Flex>
    );
}

export function IncidentLabel({type}: {type: IncidentType | string}) {
    const info = INCIDENT[type as IncidentType];
    return <Label theme={info?.theme ?? 'normal'} size="xs">{info?.text ?? type}</Label>;
}

type MetricRow = {method: string; m: Metrics};

export function MetricsTable({monitor, baseline}: {monitor: Metrics; baseline: Metrics}) {
    const columns: TableColumnConfig<MetricRow>[] = [
        {id: 'method', name: 'Метод', template: (r) => <Text variant="subheader-1">{r.method}</Text>},
        {id: 'detected', name: 'Обнаружено', align: 'end', template: (r) => `${r.m.detected} / ${r.m.total}`},
        {id: 'missed', name: 'Пропущено', align: 'end', template: (r) => String(r.m.total - r.m.detected)},
        {
            id: 'false',
            name: 'Ложные',
            align: 'end',
            template: (r) => <Text color={r.m.false_alarms ? 'danger' : 'positive'}>{r.m.false_alarms}</Text>,
        },
        {id: 'repeats', name: 'Повторы', align: 'end', template: (r) => String(r.m.repeats)},
        {id: 'unclosed', name: 'Не закрыты', align: 'end', template: (r) => String(r.m.unclosed)},
        {id: 'delay', name: 'Задержка обнаружения', align: 'end', template: (r) => fmtDuration(r.m.delay)},
        {id: 'close', name: 'Задержка закрытия', align: 'end', template: (r) => fmtDuration(r.m.close_delay)},
    ];
    return (
        <Table
            width="max"
            columns={columns}
            data={[
                {method: 'Наш монитор', m: monitor},
                {method: 'Простой порог', m: baseline},
            ]}
        />
    );
}

const EVENT_ICON: Record<string, {icon: string; color: 'danger' | 'positive' | 'info' | 'secondary'}> = {
    open: {icon: '●', color: 'danger'},
    close: {icon: '✓', color: 'positive'},
    mode: {icon: '⇄', color: 'info'},
    unknown_mode: {icon: '?', color: 'secondary'},
    calibrated: {icon: '◎', color: 'info'},
};

export function EventLog({events, clock, limit = 12}: {events: MonitorEvent[]; clock: ClockKind; limit?: number}) {
    const rows = [...events].sort((a, b) => b.time - a.time).slice(0, limit);
    if (!rows.length) return <Text color="secondary">Монитор пока ничего не решал: всё в норме.</Text>;
    return (
        <Flex direction="column" gap={2}>
            {rows.map((e, i) => {
                const ic = EVENT_ICON[e.kind] ?? {icon: '•', color: 'secondary' as const};
                return (
                    <Flex key={`${e.time}-${i}`} gap={2} alignItems="flex-start">
                        <Text variant="code-1" color="secondary" style={{minWidth: 64}}>{fmtTime(e.time, clock)}</Text>
                        <Text color={ic.color} style={{width: 14}}>{ic.icon}</Text>
                        <Flex direction="column" gap={0.5} alignItems="flex-start">
                            {e.type !== 'info' && <IncidentLabel type={e.type} />}
                            <Text>{e.text}</Text>
                        </Flex>
                    </Flex>
                );
            })}
        </Flex>
    );
}

export function IncidentsTable({
    incidents,
    clockOf,
    showSensor = true,
    onChanged,
}: {
    incidents: Incident[];
    clockOf: (sensorId: string) => ClockKind;
    showSensor?: boolean;
    onChanged?: () => void;
}) {
    const [ackFor, setAckFor] = useState<Incident | null>(null);
    const columns: TableColumnConfig<Incident>[] = [
        ...(showSensor
            ? [{id: 'sensor', name: 'Датчик', template: (i: Incident) => <Link to={`/expert/sensors/${encodeURIComponent(i.sensor_id)}`}>{i.sensor_id}</Link>}]
            : []),
        {id: 'type', name: 'Тип', template: (i) => <IncidentLabel type={i.type} />},
        {
            id: 'state',
            name: 'Состояние',
            template: (i) => (
                <Flex gap={1}>
                    <Label theme={i.open ? 'danger' : 'success'} size="xs">{i.open ? 'открыт' : 'закрыт'}</Label>
                    {i.acknowledged && (
                        <Tooltip content={`${i.ack_by ?? ''}${i.ack_comment ? `: ${i.ack_comment}` : ''}`}>
                            <Label theme="info" size="xs">просмотрен</Label>
                        </Tooltip>
                    )}
                </Flex>
            ),
        },
        {id: 'start', name: 'Начало', template: (i) => fmtTime(i.start, clockOf(i.sensor_id))},
        {id: 'dur', name: 'Длительность', template: (i) => (i.end === null ? 'идёт' : fmtDuration(i.end - i.start))},
        {
            id: 'reason',
            name: 'Объяснение',
            width: '45%',
            template: (i) => (
                <Flex direction="column">
                    <Text>{i.reason}</Text>
                    {i.close_reason && <Text color="secondary">Закрыт: {i.close_reason}</Text>}
                </Flex>
            ),
        },
        {
            id: 'act',
            name: '',
            template: (i) =>
                !i.acknowledged ? (
                    <Button size="s" view="outlined" onClick={() => setAckFor(i)}>
                        Принять
                    </Button>
                ) : null,
        },
    ];
    return (
        <>
            <Table width="max" columns={columns} data={incidents} emptyMessage="Инцидентов нет" wordWrap />
            {ackFor && (
                <AckDialog
                    incident={ackFor}
                    onClose={() => setAckFor(null)}
                    onDone={() => {
                        setAckFor(null);
                        onChanged?.();
                    }}
                />
            )}
        </>
    );
}

function AckDialog({incident, onClose, onDone}: {incident: Incident; onClose: () => void; onDone: () => void}) {
    const [by, setBy] = useState(() => localStorageGet('sw-operator') ?? 'оператор');
    const [comment, setComment] = useState('');
    const [busy, setBusy] = useState(false);
    return (
        <Dialog open onClose={onClose} size="s">
            <Dialog.Header caption="Принять инцидент" />
            <Dialog.Body>
                <Flex direction="column" gap={3}>
                    <Text color="secondary">
                        Подтверждение означает «оператор увидел». Закрывает инцидент только монитор, когда данные вернутся в норму.
                    </Text>
                    <TextInput label="Кто" value={by} onUpdate={setBy} />
                    <TextArea placeholder="Комментарий (необязательно)" value={comment} onUpdate={setComment} minRows={2} />
                </Flex>
            </Dialog.Body>
            <Dialog.Footer
                textButtonApply="Принять"
                textButtonCancel="Отмена"
                loading={busy}
                onClickButtonCancel={onClose}
                onClickButtonApply={async () => {
                    setBusy(true);
                    localStorageSet('sw-operator', by);
                    try {
                        await api.ack(incident.id, by, comment || undefined);
                        onDone();
                    } finally {
                        setBusy(false);
                    }
                }}
            />
        </Dialog>
    );
}
