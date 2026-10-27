// Тонкий клиент REST API шлюза. Все пути относительные: в dev их проксирует Vite.
import type {
    BenchmarkResult,
    Evaluation,
    Incident,
    Meta,
    MonitorEvent,
    Overview,
    Profile,
    RunResult,
    Scenario,
    SensorDetail,
    SensorSummary,
    Series,
} from './types';

const BASE = '/api/v1';

export class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(BASE + path, {
        method,
        headers: body === undefined ? undefined : {'Content-Type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
        let detail = res.statusText;
        try {
            const data = await res.json();
            detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
        } catch {
            /* ответ не JSON */
        }
        throw new ApiError(res.status, detail);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
}

const q = (params: Record<string, string | number | undefined | null>) => {
    const s = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && v !== null && v !== '' && s.set(k, String(v)));
    const str = s.toString();
    return str ? `?${str}` : '';
};

export const api = {
    meta: () => request<Meta>('GET', '/meta'),
    overview: () => request<Overview>('GET', '/overview'),
    sensors: () => request<SensorSummary[]>('GET', '/sensors'),
    sensor: (id: string) => request<SensorDetail>('GET', `/sensors/${encodeURIComponent(id)}`),
    series: (id: string, maxPoints = 5000) =>
        request<Series>('GET', `/sensors/${encodeURIComponent(id)}/series${q({max_points: maxPoints})}`),
    patchSensor: (id: string, body: {config?: Record<string, unknown>; name?: string}) =>
        request<SensorDetail>('PATCH', `/sensors/${encodeURIComponent(id)}`, body),
    deleteSensor: (id: string) => request<void>('DELETE', `/sensors/${encodeURIComponent(id)}`),
    resetSensor: (id: string) => request<SensorDetail>('POST', `/sensors/${encodeURIComponent(id)}/reset`),
    calibrate: (id: string, body: {mode: string; since?: number; until?: number}) =>
        request<Profile>('POST', `/sensors/${encodeURIComponent(id)}/calibrate`, body),
    putProfile: (id: string, mode: string, body: {mean: number; sigma: number; assess: boolean}) =>
        request<Profile>('PUT', `/sensors/${encodeURIComponent(id)}/profiles/${encodeURIComponent(mode)}`, body),
    evaluation: (id: string) => request<Evaluation>('GET', `/sensors/${encodeURIComponent(id)}/evaluation`),
    exportUrl: (id: string) => `${BASE}/sensors/${encodeURIComponent(id)}/export`,
    incidents: (params: {sensor_id?: string; type?: string; state?: string} = {}) =>
        request<Incident[]>('GET', `/incidents${q(params)}`),
    ack: (id: string, by: string, comment?: string) =>
        request<Incident>('POST', `/incidents/${encodeURIComponent(id)}/ack`, {by, comment}),
    events: (params: {sensor_id?: string; limit?: number} = {}) =>
        request<MonitorEvent[]>('GET', `/events${q(params)}`),
    scenarios: () => request<Scenario[]>('GET', '/scenarios'),
    run: (scenario: string, seed: number, config?: Record<string, unknown>) =>
        request<RunResult>('POST', '/runs', {scenario, seed, config}),
    benchmark: (seeds: number, scenarios?: string[], config?: Record<string, unknown>) =>
        request<BenchmarkResult>('POST', '/benchmark', {seeds, scenarios, config}),
    simulate: (scenario: string, seed: number, speed: number, sensor_id?: string) =>
        request<SensorSummary>('POST', '/simulations', {scenario, seed, speed, sensor_id}),
};
