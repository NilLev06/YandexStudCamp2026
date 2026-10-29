import {useEffect, useRef, useState} from 'react';

import {streamUrl} from '../api/client';
import type {StreamMessage} from '../api/types';

export type StreamState = 'connecting' | 'open' | 'error';

const EVENTS = ['update', 'sensor_added', 'sensor_removed'] as const;

export function useStream(onMessage: (message: StreamMessage) => void, sensorId?: string): StreamState {
    const [state, setState] = useState<StreamState>('connecting');
    const handler = useRef(onMessage);
    handler.current = onMessage;

    useEffect(() => {
        const source = new EventSource(streamUrl(sensorId));
        const listener = (e: MessageEvent<string>) => handler.current(JSON.parse(e.data) as StreamMessage);
        setState('connecting');
        source.onopen = () => setState('open');
        source.onerror = () => setState(source.readyState === EventSource.CLOSED ? 'error' : 'connecting');
        for (const name of EVENTS) source.addEventListener(name, listener);
        return () => source.close();
    }, [sensorId]);

    return state;
}
