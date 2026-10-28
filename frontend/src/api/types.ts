// Типы ответов шлюза (см. gateway/app/schemas.py и /docs)

export type Quality = 'normal' | 'suspect' | 'alarm' | 'unknown';
export type Availability = 'fresh' | 'stale' | 'unknown';
export type ClockKind = 'wall' | 'sim';
export type IncidentType = 'quality' | 'availability' | 'flags' | 'stuck' | 'noise' | 'rate';

export interface Profile {
    mean: number;
    sigma: number;
    assess: boolean;
    source: string;
}

export interface Status {
    now: number;
    mode: string;
    mode_known: boolean;
    quality: Quality;
    availability: Availability;
    flags: 'ok' | 'degraded';
    diagnostics: Record<'stuck' | 'noise' | 'rate', 'ok' | 'alarm'>;
    s: number;
    z: number;
    aggregate: number | null;
    age: number | null;
    norm: number | null;
    sigma: number | null;
    noise_ratio: number | null;
    rate_ratio: number | null;
}

export interface Frame extends Status {
    s_up: number;
    s_down: number;
    aggregate_time: number | null;
    since_receipt?: number | null;
    late_count?: number;
    accepted?: number;
    events?: number;
}

export interface SensorSummary {
    id: string;
    name: string;
    kind: 'live' | 'simulation';
    clock: ClockKind;
    source: string;
    unit: string | null;
    description: string | null;
    tags: string[];
    created_at: number;
    now: number | null;
    finished: boolean;
    duration: number | null;
    speed: number | null;
    status: Status | null;
    open_incidents: number;
    messages: number;
    profiles: Record<string, Profile>;
}

export interface Label {
    start: number;
    end: number;
    type: IncidentType;
    label?: string | null;
}

export interface Annotation {
    start: number;
    end: number;
    label: string;
    kind: string;
}

export interface SensorDetail extends SensorSummary {
    config: Record<string, number | string | boolean>;
    labels: Label[];
    annotations: Annotation[];
}

export interface Message {
    event_time: number;
    received_at: number;
    value: number | null;
    mode: string | null;
    quality_flags: string | null;
}

export interface Incident {
    id: string;
    sensor_id: string;
    type: IncidentType;
    start: number;
    end: number | null;
    reason: string;
    close_reason?: string | null;
    side?: string | null;
    open: boolean;
    acknowledged: boolean;
    ack_by?: string | null;
    ack_comment?: string | null;
    ack_at?: number | null;
}

export interface MonitorEvent {
    sensor_id?: string;
    time: number;
    kind: string;
    type: string;
    text: string;
}

export interface BaselineIncident {
    type: string;
    start: number;
    end: number | null;
    reason: string;
}

export interface Series {
    sensor_id: string;
    clock: ClockKind;
    messages: Message[];
    frames: Frame[];
    annotations: Annotation[];
    incidents: Incident[];
    baseline: BaselineIncident[];
    events: MonitorEvent[];
}

export interface Metrics {
    detected: number;
    total: number;
    false_alarms: number;
    repeats: number;
    unclosed: number;
    delay: number | null;
    close_delay: number | null;
    closed: number;
}

export interface Evaluation {
    labels: number;
    until: number;
    complete: boolean;
    monitor: Metrics;
    baseline: Metrics;
}

export interface Scenario {
    id: string;
    name: string;
    duration: number;
    description: string;
    extended: boolean;
}

export interface RunResult {
    id: string;
    scenario: string;
    seed: number;
    duration: number;
    messages: (Message & {id: number; sensor_id: string})[];
    truth: Label[];
    annotations: Annotation[];
    frames: Frame[];
    incidents: {type: IncidentType; start: number; end: number | null; reason: string; side?: string; shape?: 'step' | 'drift'}[];
    events: MonitorEvent[];
    baseline: BaselineIncident[];
    config: Record<string, number | string | boolean>;
    profiles: Record<string, Profile>;
    metrics: {monitor: Metrics; baseline: Metrics};
}

export interface BenchmarkResult {
    runs: number;
    seeds: number;
    scenarios: Record<string, {monitor: Metrics; baseline: Metrics}>;
    total: {monitor: Metrics; baseline: Metrics};
}

export interface Overview {
    sensors: number;
    live: number;
    simulations: number;
    quality: Record<string, number>;
    availability: Record<string, number>;
    open_incidents: number;
    unacknowledged: number;
    open_by_type: Record<string, number>;
}

export interface Meta {
    version: string;
    incident_types: Record<IncidentType, string>;
    config: {name: string; default: number | string | boolean; type: string}[];
    scenarios: Scenario[];
    ingest_key_required: boolean;
}

// Сообщения живого потока /api/v1/ws
export type LiveMessage =
    | {type: 'hello'; sensors: SensorSummary[]}
    | {type: 'sensor'; sensor: SensorSummary}
    | {type: 'sensor_removed'; sensor_id: string}
    | {type: 'incident_ack'; sensor_id: string; incident: Incident}
    | {
          type: 'tick';
          sensor_id: string;
          frame: Frame;
          messages: Message[];
          events?: (
              | {kind: 'incident_open' | 'incident_close'; incident: Incident}
              | ({kind: string; sensor_id: string} & MonitorEvent)
          )[];
      };
