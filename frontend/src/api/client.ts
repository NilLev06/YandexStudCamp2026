import type {
    AnalysisCase,
    SimulationAnalysis,
    SimulationBatch,
    BenchmarkResult,
    Frame,
    Incident,
    IncidentType,
    Measurement,
    Meta,
    MonitorEvent,
    SingleReplay,
    SingleScenario,
    PairReplay,
    PairScenario,
    ReplayResult,
    SensorDetail,
    SensorSummary,
    Simulation,
} from './types';

const BASE = import.meta.env.VITE_API_BASE || '/api/v1';
const API_KEY = import.meta.env.VITE_API_KEY;

export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

function detailText(detail: unknown): string {
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) return detail.map((d) => d?.msg ?? JSON.stringify(d)).join('; ');
    return JSON.stringify(detail);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set('Content-Type', 'application/json');
    if (API_KEY) headers.set('X-API-Key', API_KEY);
    const response = await fetch(BASE + path, {...init, headers});
    if (!response.ok) {
        const body = await response.json().catch(() => ({detail: response.statusText}));
        throw new ApiError(response.status, detailText(body.detail));
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
}

const query = (params: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    const s = q.toString();
    return s ? '?' + s : '';
};
const post = <T>(path: string, body: unknown) => request<T>(path, {method: 'POST', body: JSON.stringify(body)});
const id = encodeURIComponent;

export const api = {
    analysisCases: () => request<AnalysisCase[]>('/simulation-analysis/cases'),
    analyzeSimulation: (body: {case_id: string; seed: number}) => post<SimulationAnalysis>('/simulation-analysis/replay', body),
    checkSimulations: (body: {case_ids: string[]; seed_from: number; seed_to: number}) => post<SimulationBatch>('/simulation-analysis/benchmark', body),
    singleReplay: (body: {scenario: SingleScenario; seed: number}) => post<SingleReplay>('/single-replays', body),
    pairReplay: (body: {scenario: PairScenario; seed: number}) => post<PairReplay>('/pair-replays', body),
    meta: () => request<Meta>('/meta'),
    sensors: () => request<SensorSummary[]>('/sensors'),
    sensor: (sensorId: string) => request<SensorDetail>(`/sensors/${id(sensorId)}`),
    frames: (sensorId: string) => request<Frame[]>(`/sensors/${id(sensorId)}/frames`),
    measurements: (sensorId: string) => request<Measurement[]>(`/sensors/${id(sensorId)}/measurements`),
    events: (sensorId: string) => request<MonitorEvent[]>(`/sensors/${id(sensorId)}/events`),
    sensorIncidents: (sensorId: string) => request<Incident[]>(`/sensors/${id(sensorId)}/incidents`),
    deleteSensor: (sensorId: string) => request<void>(`/sensors/${id(sensorId)}`, {method: 'DELETE'}),
    incidents: (params: {sensor_id?: string; type?: IncidentType; state?: 'open' | 'closed'; limit?: number} = {}) =>
        request<Incident[]>('/incidents' + query(params)),
    startSimulation: (body: {scenario: string; seed: number; speed: number; sensor_id?: string}) =>
        post<Simulation>('/simulations', body),
    stopSimulation: (simId: string) => request<Simulation>(`/simulations/${id(simId)}`, {method: 'DELETE'}),
    replay: (body: {scenario: string; seed: number}) => post<ReplayResult>('/replays', body),
    benchmark: (body: {scenarios?: string[]; seed_from: number; seed_to: number}) =>
        post<BenchmarkResult>('/benchmark', body),
};

export const streamUrl = (sensorId?: string) => BASE + '/stream' + query({sensor_id: sensorId});
