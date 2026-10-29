import {Flex, Text} from '@gravity-ui/uikit';
import type {ReactNode} from 'react';

export function Page({title, subtitle, actions, children}: {title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode}) {
    return (
        <div className="page">
            <Flex className="page__header" justifyContent="space-between" alignItems="center" gap={3} wrap>
                <Flex direction="column" gap={1}>
                    <Text variant="header-1">{title}</Text>
                    {subtitle && <Text color="secondary">{subtitle}</Text>}
                </Flex>
                {actions && (
                    <Flex gap={2} wrap>
                        {actions}
                    </Flex>
                )}
            </Flex>
            {children}
        </div>
    );
}

export function Panel({title, extra, children}: {title?: ReactNode; extra?: ReactNode; children: ReactNode}) {
    return (
        <section className="panel">
            {(title || extra) && (
                <Flex justifyContent="space-between" alignItems="center" gap={2} className="panel__head">
                    {title && <Text variant="subheader-2">{title}</Text>}
                    {extra}
                </Flex>
            )}
            {children}
        </section>
    );
}

export function Stat({label, value, hint, tone}: {label: string; value: ReactNode; hint?: ReactNode; tone?: 'danger' | 'warning' | 'success'}) {
    return (
        <section className={'panel stat' + (tone ? ' stat_' + tone : '')}>
            <Text color="secondary">{label}</Text>
            <Text variant="display-1">{value}</Text>
            {hint && <Text variant="caption-2" color="secondary">{hint}</Text>}
        </section>
    );
}
