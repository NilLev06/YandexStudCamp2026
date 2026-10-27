// Живой поток шлюза (WebSocket /api/v1/ws) и React-хуки поверх него.
// Одно соединение на всё приложение; при обрыве переподключаемся.
import {useEffect, useSyncExternalStore} from 'react';

import type {Frame, Incident, LiveMessage, Message, MonitorEvent, SensorSummary} from './types';

export type ConnectionState = 'connecting' | 'open' | 'closed';
export type TickListener = (tick: {frame: Frame; messages: Message[]; events: MonitorEvent[]; incidents: Incident[]}) => void;

class LiveStore {
    private ws: WebSocket | null = null;
    private sensors = new Map<string, SensorSummary>();
    private sensorsSnapshot: SensorSummary[] = [];
    private listeners = new Set<() => void>();
    private tickListeners = new Map<string, Set<TickListener>>();
    private flushTimer: number | null = null;
    private retry = 0;
    state: ConnectionState = 'connecting';
    // Счётчик изменений инцидентов: страницы перечитывают списки, когда он растёт
    incidentsVersion = 0;

    connect() {
        if (this.ws) return;
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${proto}://${location.host}/api/v1/ws`);
        this.ws = ws;
        this.setState('connecting');
        ws.onopen = () => {
            this.retry = 0;
            this.setState('open');
        };
        ws.onmessage = (e) => this.handle(JSON.parse(e.data) as LiveMessage);
        ws.onclose = () => {
            this.ws = null;
            this.setState('closed');
            const delay = Math.min(10000, 500 * 2 ** this.retry++);
            window.setTimeout(() => this.connect(), delay);
        };
    }

    private setState(s: ConnectionState) {
        this.state = s;
        this.emit(true);
    }

    private handle(msg: LiveMessage) {
        switch (msg.type) {
            case 'hello':
                this.sensors = new Map(msg.sensors.map((s) => [s.id, s]));
                this.emit(true);
                break;
            case 'sensor':
                this.sensors.set(msg.sensor.id, msg.sensor);
                this.emit();
                break;
            case 'sensor_removed':
                this.sensors.delete(msg.sensor_id);
                this.incidentsVersion++;
                this.emit(true);
                break;
            case 'incident_ack':
                this.incidentsVersion++;
                this.emit();
                break;
            case 'tick': {
                const s = this.sensors.get(msg.sensor_id);
                const incidents: Incident[] = [];
                const events: MonitorEvent[] = [];
                for (const e of msg.events ?? []) {
                    if ('incident' in e) incidents.push(e.incident);
                    else if (e.kind !== 'incident_open' && e.kind !== 'incident_close') events.push(e as MonitorEvent);
                }
                if (s) {
                    const f = msg.frame;
                    let open = s.open_incidents;
                    for (const e of msg.events ?? []) {
                        if (e.kind === 'incident_open') open++;
                        if (e.kind === 'incident_close') open--;
                    }
                    this.sensors.set(msg.sensor_id, {
                        ...s,
                        now: f.now,
                        open_incidents: Math.max(0, open),
                        messages: s.messages + msg.messages.length,
                        status: {...f},
                    });
                }
                if (incidents.length) this.incidentsVersion++;
                this.tickListeners.get(msg.sensor_id)?.forEach((cb) => cb({frame: msg.frame, messages: msg.messages, events, incidents}));
                this.emit();
                break;
            }
        }
    }

    // Список датчиков обновляем не чаще 4 раз в секунду, чтобы не перерисовывать всё на каждом тике
    private emit(immediate = false) {
        if (immediate) {
            this.flush();
            return;
        }
        if (this.flushTimer === null) this.flushTimer = window.setTimeout(() => this.flush(), 250);
    }

    private flush() {
        if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
        this.flushTimer = null;
        this.sensorsSnapshot = [...this.sensors.values()];
        this.listeners.forEach((l) => l());
    }

    subscribe = (cb: () => void) => {
        this.listeners.add(cb);
        return () => {
            this.listeners.delete(cb);
        };
    };

    getSensors = () => this.sensorsSnapshot;
    getState = () => this.state;
    getIncidentsVersion = () => this.incidentsVersion;

    onTick(sensorId: string, cb: TickListener) {
        if (!this.tickListeners.has(sensorId)) this.tickListeners.set(sensorId, new Set());
        this.tickListeners.get(sensorId)!.add(cb);
        return () => {
            this.tickListeners.get(sensorId)?.delete(cb);
        };
    }

    upsert(s: SensorSummary) {
        this.sensors.set(s.id, s);
        this.emit(true);
    }
}

export const live = new LiveStore();

export function useSensors() {
    return useSyncExternalStore(live.subscribe, live.getSensors);
}

export function useConnection() {
    return useSyncExternalStore(live.subscribe, live.getState);
}

export function useIncidentsVersion() {
    return useSyncExternalStore(live.subscribe, live.getIncidentsVersion);
}

export function useTicks(sensorId: string | undefined, cb: TickListener) {
    useEffect(() => {
        if (!sensorId) return undefined;
        return live.onTick(sensorId, cb);
    }, [sensorId, cb]);
}
