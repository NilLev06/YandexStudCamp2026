import {createContext, useContext} from 'react';

import type {Meta} from '../api/types';

export const MetaContext = createContext<Meta | null>(null);

export function useMeta(): Meta {
    const meta = useContext(MetaContext);
    if (!meta) throw new Error('Meta не загружена');
    return meta;
}
