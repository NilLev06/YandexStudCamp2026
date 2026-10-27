// Каркас приложения: боковая навигация Gravity UI и маршруты
import {useEffect, useState} from 'react';
import {AsideHeader, FooterItem} from '@gravity-ui/navigation';
import type {MenuItem} from '@gravity-ui/navigation';
import {ChartLine, CircleInfo, Flask, LayoutCellsLarge, Moon, Sun, TriangleExclamation} from '@gravity-ui/icons';
import {Flex, Label, Text} from '@gravity-ui/uikit';
import {Route, Routes, useLocation, useNavigate} from 'react-router-dom';

import {live, useConnection, useSensors} from './api/live';
import {localStorageGet, localStorageSet} from './utils/storage';
import {AboutPage} from './pages/About';
import {IncidentsPage} from './pages/Incidents';
import {LabPage} from './pages/Lab';
import {OverviewPage} from './pages/Overview';
import {SensorPage} from './pages/SensorPage';

const LOGO = `data:image/svg+xml;utf8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1f2328"/><path d="M5 20h5l3-9 4 14 3-9h7" fill="none" stroke="#ffcc00" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
)}`;

export function App({theme, onTheme}: {theme: 'light' | 'dark'; onTheme: (t: 'light' | 'dark') => void}) {
    const [compact, setCompact] = useState(() => localStorageGet('sw-compact') === '1');
    // На узком экране меню всегда свёрнуто, иначе оно занимает почти всю ширину
    const [narrow, setNarrow] = useState(() => window.matchMedia?.('(max-width: 900px)').matches ?? false);
    useEffect(() => {
        const mq = window.matchMedia?.('(max-width: 900px)');
        if (!mq) return undefined;
        const on = () => setNarrow(mq.matches);
        mq.addEventListener('change', on);
        return () => mq.removeEventListener('change', on);
    }, []);
    const navigate = useNavigate();
    const {pathname} = useLocation();
    const connection = useConnection();
    const sensors = useSensors();
    const open = sensors.reduce((n, s) => n + s.open_incidents, 0);

    useEffect(() => live.connect(), []);

    const item = (id: string, title: string, icon: MenuItem['icon'], path: string, current: boolean, extra?: Partial<MenuItem>): MenuItem => ({
        id,
        title,
        icon,
        current,
        onItemClick: () => navigate(path),
        ...extra,
    });

    const menuItems: MenuItem[] = [
        item('overview', 'Обзор', LayoutCellsLarge, '/', pathname === '/'),
        item('sensors', 'Датчики', ChartLine, sensors[0] ? `/sensors/${encodeURIComponent(sensors[0].id)}` : '/', pathname.startsWith('/sensors')),
        item('incidents', 'Инциденты', TriangleExclamation, '/incidents', pathname === '/incidents', {
            rightAdornment: open ? <Label theme="danger" size="xs">{open}</Label> : undefined,
        }),
        item('lab', 'Сценарии и проверка', Flask, '/lab', pathname === '/lab'),
        item('about', 'Решение кейса', CircleInfo, '/about', pathname === '/about'),
    ];

    return (
        <AsideHeader
            logo={{text: 'Sensor Watch', iconSrc: LOGO, iconSize: 28, onClick: () => navigate('/')}}
            compact={compact || narrow}
            hideCollapseButton={narrow}
            onChangeCompact={(v) => {
                setCompact(v);
                localStorageSet('sw-compact', v ? '1' : '0');
            }}
            menuItems={menuItems}
            headerDecoration
            renderFooter={({compact: c}) => (
                <>
                    <FooterItem
                        compact={c}
                        id="theme"
                        title={theme === 'light' ? 'Тёмная тема' : 'Светлая тема'}
                        icon={theme === 'light' ? Moon : Sun}
                        onItemClick={() => onTheme(theme === 'light' ? 'dark' : 'light')}
                    />
                    <FooterItem
                        compact={c}
                        id="conn"
                        title={connection === 'open' ? 'Шлюз на связи' : connection === 'connecting' ? 'Подключение...' : 'Нет связи со шлюзом'}
                        icon={CircleInfo}
                        rightAdornment={<span className={`sw-dot sw-dot_${connection}`} />}
                    />
                </>
            )}
            renderContent={() => (
                <main className="sw-content">
                    {connection === 'closed' && (
                        <Flex className="sw-banner">
                            <Text>Нет связи со шлюзом. Проверьте, что запущен uvicorn app.main:app --port 8000 (папка gateway).</Text>
                        </Flex>
                    )}
                    <Routes>
                        <Route path="/" element={<OverviewPage />} />
                        <Route path="/sensors/:id" element={<SensorPage />} />
                        <Route path="/incidents" element={<IncidentsPage />} />
                        <Route path="/lab" element={<LabPage />} />
                        <Route path="/about" element={<AboutPage />} />
                        <Route path="*" element={<OverviewPage />} />
                    </Routes>
                </main>
            )}
        />
    );
}
