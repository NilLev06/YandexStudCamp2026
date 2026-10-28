import {ActionTooltip, Button, Flex, NumberInput, Text} from '@gravity-ui/uikit';

import type {Meta} from '../api/types';
import {useMeta} from '../lib/meta';

export function seedError(value: number | null, bounds: Meta['seed']): string | undefined {
    const range = `от ${bounds.min} до ${bounds.max.toLocaleString('ru-RU')}`;
    if (value === null) return `Укажите seed ${range}`;
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) return `Seed — целое число ${range}`;
    return undefined;
}

interface SeedFieldProps {
    value: number | null;
    onUpdate: (value: number | null) => void;
    label?: string;
    width?: number;
}

export function SeedField({value, onUpdate, label = 'Seed', width = 150}: SeedFieldProps) {
    const {seed} = useMeta();
    const error = seedError(value, seed);
    return (
        <NumberInput
            label={label}
            value={value}
            onUpdate={onUpdate}
            min={seed.min}
            max={seed.max}
            validationState={error ? 'invalid' : undefined}
            errorMessage={error}
            style={{width}}
        />
    );
}

export function SeedPicks({scenario, value, onPick}: {scenario: string; value: number | null; onPick: (seed: number) => void}) {
    const meta = useMeta();
    const recs = meta.recommended_seeds[scenario] ?? [];
    if (!recs.length) return null;
    const active = recs.find((r) => r.seed === value);
    return (
        <Flex direction="column" gap={1}>
            <Flex gap={1} wrap alignItems="center">
                <Text variant="caption-2" color="secondary">
                    Рекомендуемые seed:
                </Text>
                {recs.map((r) => (
                    <ActionTooltip key={r.seed} title={r.label} description={r.note}>
                        <Button size="s" view={r.seed === value ? 'outlined-info' : 'outlined'} onClick={() => onPick(r.seed)}>
                            <b>{r.seed}</b> {r.label}
                        </Button>
                    </ActionTooltip>
                ))}
            </Flex>
            {active && (
                <Text variant="caption-2" color="secondary">
                    {active.note}
                </Text>
            )}
        </Flex>
    );
}
