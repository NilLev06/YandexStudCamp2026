import {type DependencyList, useCallback, useEffect, useRef, useState} from 'react';

export function useAsync<T>(load: () => Promise<T>, deps: DependencyList) {
    const [data, setData] = useState<T | undefined>();
    const [error, setError] = useState<Error | undefined>();
    const [loading, setLoading] = useState(true);
    const loader = useRef(load);
    const generation = useRef(0);
    loader.current = load;

    const reload = useCallback(() => {
        const current = ++generation.current;
        setLoading(true);
        loader
            .current()
            .then((value) => {
                if (current !== generation.current) return;
                setData(value);
                setError(undefined);
            })
            .catch((e: Error) => current === generation.current && setError(e))
            .finally(() => current === generation.current && setLoading(false));
    }, deps);

    useEffect(reload, [reload]);

    return {data, setData, error, loading, reload};
}
