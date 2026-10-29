import {Flex, Label} from '@gravity-ui/uikit';

import type {Frame} from '../api/types';
import {AVAILABILITY, QUALITY} from '../lib/format';

export function StatusLabels({frame, size = 's'}: {frame: Frame | null; size?: 'xs' | 's' | 'm'}) {
    if (!frame) return <Label theme="unknown" size={size}>Нет тактов</Label>;
    return (
        <Flex gap={1} wrap>
            <Label theme={QUALITY[frame.quality].theme} size={size}>
                {QUALITY[frame.quality].text}
            </Label>
            <Label theme={AVAILABILITY[frame.availability].theme} size={size}>
                {AVAILABILITY[frame.availability].text}
            </Label>
            {frame.flags === 'degraded' && (
                <Label theme="warning" size={size}>
                    Невалидные флаги
                </Label>
            )}
        </Flex>
    );
}
