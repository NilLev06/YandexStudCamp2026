export type QualityStatus = 'normal' | 'suspect' | 'alarm' | 'unknown';
export type AvailabilityStatus = 'fresh' | 'stale' | 'unknown';
export type IncidentType = 'quality' | 'availability' | 'flags' | 'noise' | 'stuck' | 'saturation' | 'rate' | 'latency';
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
    alarm_count?: number;
    comment?: string;
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
    highlight_end?: number | null;
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

export type PairScenario = 'normal' | 'drift' | 'dual_drift' | 'spike' | 'gap';
export interface PairFrame {
    c?: number | null;
    age_c?: number | null;
    sensors?: Record<string, {value: number | null; age: number | null}>;
    pairs?: Record<string, PairFrame>;
    suspect_sensor?: string | null;
    now: number;
    a: number | null;
    b: number | null;
    age_a: number | null;
    age_b: number | null;
    time_skew: number | null;
    difference: number | null;
    status: 'normal' | 'suspect' | 'alarm' | 'unavailable' | 'recovering';
    comment: string;
    bad_run: number;
    good_run: number;
    comparison_alarm_open: boolean;
}
export interface PairReplay {
    sensor_count: 2 | 3;
    sensor_ids: string[];
    scenario: PairScenario;
    seed: number;
    duration: number;
    config: Record<string, number>;
    messages: {sensor_id: string; event_time: number; received_at: number; value: number; quality_flags: string}[];
    frames: PairFrame[];
    incidents: {id: number; type: 'disagreement' | 'availability'; start: number; end: number | null; reason: string; highlight_end?: number}[];
    events: {time: number; kind: string; type: string; text: string}[];
    truth: {start: number; end: number; label: string}[];
}

export type SingleScenario = 'normal' | 'drift' | 'rise' | 'step' | 'noise' | 'periodic' | 'stuck' | 'saturation'
    | 'spike' | 'jumps' | 'invalid' | 'gap' | 'delay' | 'rate' | 'mode';
export type SingleAlarmType = 'level' | 'noise' | 'stuck' | 'saturation' | 'rate' | 'invalid' | 'availability' | 'latency';
export interface SingleIncident {
    id: number;
    type: SingleAlarmType;
    start: number;
    end: number | null;
    highlight_end?: number;
    reason: string;
}
export interface SingleFrame {
    s: number;
    cusum_down: number;
    cusum_up: number;
    now: number;
    mode: string | null;
    value: number | null;
    aggregate: number | null;
    spread: number | null;
    coverage: number | null;
    bad_share: number | null;
    age: number | null;
    since_receipt: number | null;
    rejected: number;
    status: 'normal' | 'suspect' | 'alarm' | 'unknown';
    comment: string;
    alarms: SingleIncident[];
}
export interface SingleReplay {
    scenario: SingleScenario;
    seed: number;
    duration: number;
    config: Record<string, number>;
    profiles: Profiles;
    alarm_names: Record<SingleAlarmType, string>;
    scenarios: Record<SingleScenario, string>;
    messages: (PairReplay['messages'][number] & {mode: string})[];
    frames: SingleFrame[];
    incidents: SingleIncident[];
    events: {time: number; kind: string; type: SingleAlarmType | 'info'; text: string; incident_id?: number}[];
    truth: {start: number; end: number; label: string}[];
}

export interface AnalysisCase {
    id: string;
    kind: 'single' | 'pair';
    scenario: string;
    name: string;
    target: string | null;
    fault_start: number | null;
    fault_end: number | null;
    expectation: string;
}
export interface RunAssessment {
    case_id: string;
    seed: number;
    expected: boolean;
    detected: boolean;
    expected_count: number;
    detected_count: number;
    event_results: {target: string; start: number; end: number; detected: boolean; detection_time: number | null; delay: number | null; recovery_time: number | null; recovery_delay: number | null; repeats: number; early_recoveries: number}[];
    passed: boolean;
    issues: string[];
    false_alarms: number;
    other_alarms: number;
    repeats: number;
    early_recoveries: number;
    unclosed: number;
    detection_time: number | null;
    delay: number | null;
    recovery_time: number | null;
    recovery_delay: number | null;
}
export interface SimulationAnalysis {
    case: AnalysisCase;
    data: SingleReplay | PairReplay;
    assessment: RunAssessment;
}
export interface RunSummary {
    runs: number;
    passed: number;
    expected: number;
    detected: number;
    missed: number;
    false_alarm_runs: number;
    false_alarms: number;
    repeats: number;
    early_recovery_runs: number;
    unclosed: number;
    mean_delay: number | null;
}
export interface SimulationBatch {
    seed_from: number;
    seed_to: number;
    summary: RunSummary;
    rows: (RunSummary & {case: AnalysisCase})[];
    details: RunAssessment[];
}
