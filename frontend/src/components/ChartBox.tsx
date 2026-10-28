// Обёртка над Chart: пустые серии убираем (Chart их не принимает), ошибку графика не пускаем дальше страницы
import {Component} from 'react';
import type {ReactNode} from 'react';
import {Chart} from '@gravity-ui/charts';
import type {ChartData} from '@gravity-ui/charts';
import {Flex, Text} from '@gravity-ui/uikit';

class Guard extends Component<{children: ReactNode; resetKey: unknown}, {failed: boolean}> {
    state = {failed: false};
    static getDerivedStateFromError() {
        return {failed: true};
    }
    componentDidUpdate(prev: {resetKey: unknown}) {
        if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({failed: false});
    }
    render() {
        return this.state.failed ? <Empty text="График не удалось построить" /> : this.props.children;
    }
}

function Empty({text}: {text: string}) {
    return (
        <Flex alignItems="center" justifyContent="center" style={{height: '100%'}}>
            <Text color="secondary">{text}</Text>
        </Flex>
    );
}

export function ChartBox({data, height, empty = 'Данных пока нет'}: {data: ChartData; height: number; empty?: string}) {
    const series = data.series.data.filter((s) => Array.isArray((s as {data?: unknown[]}).data) && (s as {data: unknown[]}).data.length > 0);
    return (
        <div style={{height}}>
            {series.length ? (
                <Guard resetKey={data}>
                    <Chart data={{...data, series: {...data.series, data: series}}} />
                </Guard>
            ) : (
                <Empty text={empty} />
            )}
        </div>
    );
}
