export interface SavedAlarm {id: number; type: string; start: number; end: number | null; reason: string}
export interface SavedSimulation {
    id: string; case_id: string; name: string; seed: number; duration: number; calculated_at: number; incidents: SavedAlarm[];
}
const KEY = 'sensor-watch-simulation-history-v1';
export function readSimulationHistory(): SavedSimulation[] {
    try {
        const data: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
        return Array.isArray(data) ? data.filter((r) => r && typeof r.case_id === 'string' && typeof r.name === 'string'
            && Number.isInteger(r.seed) && Array.isArray(r.incidents)) : [];
    } catch {return [];}
}
export function saveSimulation(caseId: string, name: string, data: {seed: number; duration: number; incidents: SavedAlarm[]}) {
    try {
        const id = `${caseId}:${data.seed}`;
        const run: SavedSimulation = {id, case_id: caseId, name, seed: data.seed, duration: data.duration,
            calculated_at: Date.now() / 1000, incidents: data.incidents.map((i) => ({...i}))};
        localStorage.setItem(KEY, JSON.stringify([run, ...readSimulationHistory().filter((r) => r.id !== id)].slice(0, 30)));
    } catch { /* A disabled browser store does not prevent simulation. */ }
}
