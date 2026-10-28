export type QualityStatus = 'normal' | 'suspect' | 'alarm' | 'unknown';
export type AvailabilityStatus = 'fresh' | 'stale' | 'unknown';
export type IncidentType = 'quality' | 'availability' | 'flags';
export type Clock = 'wall' | 'virtual';

export interface Frame {
    now: number;
    mode: string;
    mode_known: boolean;
    s: number;
    z: number;
    aggregate: number | null;
    aggregate_time: number | null;
    quality: QualityStatus;
    availability: AvailabilityStatus;
    flags: 'ok' | 'degraded';
    age: number | null;
    since_receipt: number | null;
    late_count: number;
    accepted: number;
    events: number;
}

export interface Measurement {
    event_time: number;
    received_at: number;
    value: number | null;
    mode: string;
    quality_flags: string;
}

export interface MonitorEvent {
    seq: number;
    sensor_id: string;
    time: number;
    wall_time: number;
    kind: string;
    type: string;
    text: string;
    incident_id: number | null;
}

export interface Incident {
    id: number;
    sensor_id: string;
    type: IncidentType;
    start: number;
    end: number | null;
    reason: string;
    state: 'open' | 'closed';
    opened_at: number;
    closed_at: number | null;
}

export interface Simulation {
    id: string;
    sensor_id: string;
    scenario: string;
    seed: number;
    speed: number;
    state: 'running' | 'finished' | 'stopped';
    position: number;
    duration: number;
    progress: number;
    started_at: number;
}

export interface SensorSummary {
    sensor_id: string;
    source: 'ingest' | 'simulation';
    clock: Clock;
    created_at: number;
    status: Frame | null;
    open_incidents: Incident[];
    simulation: Simulation | null;
}

export interface Interval {
    start: number;
    end: number;
    label: string;
    type?: string | null;
    kind?: string | null;
}

export type Profiles = Record<string, {mean: number; sigma: number}>;

export interface SensorDetail extends SensorSummary {
    truth: Interval[];
    annotations: Interval[];
    profiles: Profiles;
}

export interface Scenario {
    id: string;
    name: string;
    duration: number;
    description: string;
}

export interface RecommendedSeed {
    seed: number;
    kind: 'reference' | 'fastest' | 'slowest' | 'unclosed' | 'near_miss';
    label: string;
    note: string;
    value?: number | null;
}

export interface Meta {
    version: string;
    config: Record<string, number>;
    profiles: Profiles;
    scenarios: Scenario[];
    seed: {min: number; max: number; scan: number};
    recommended_seeds: Record<string, RecommendedSeed[]>;
    limits: Record<string, number>;
    auth_required: boolean;
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

export interface MethodMetrics {
    monitor: Metrics;
    baseline: Metrics;
}

export interface ReplayIncident {
    id?: number | null;
    type: string;
    start: number;
    end: number | null;
    reason: string;
}

export interface ReplayResult {
    scenario: string;
    seed: number;
    duration: number;
    messages: (Measurement & {id: number; sensor_id: string})[];
    truth: Interval[];
    annotations: Interval[];
    frames: Frame[];
    incidents: ReplayIncident[];
    events: Omit<MonitorEvent, 'seq' | 'sensor_id' | 'wall_time'>[];
    baseline: ReplayIncident[];
    metrics: MethodMetrics;
}

export interface BenchmarkResult extends MethodMetrics {
    runs: number;
    scenarios: string[];
    seed_from: number;
    seed_to: number;
    elapsed_ms: number;
}

export interface StreamUpdate {
    type: 'update';
    sensor_id: string;
    frames: Frame[];
    measurements: Measurement[];
    events: MonitorEvent[];
    summary: SensorSummary;
}

export type StreamMessage =
    | StreamUpdate
    | {type: 'sensor_added'; sensor_id: string; summary: SensorSummary}
    | {type: 'sensor_removed'; sensor_id: string};
