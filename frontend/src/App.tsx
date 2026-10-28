// Каркас: простой режим (одна страница «Демо») и режим эксперта (боковое меню, все экраны)
import {useEffect, useState} from 'react';
import {AsideHeader, FooterItem} from '@gravity-ui/navigation';
import type {MenuItem} from '@gravity-ui/navigation';
import {ChartLine, CircleInfo, Eye, Flask, LayoutCellsLarge, ListUl, Moon, Sun, TriangleExclamation} from '@gravity-ui/icons';
import {Button, Flex, Icon, Label, SegmentedRadioGroup, Text} from '@gravity-ui/uikit';
import {Route, Routes, useLocation, useNavigate} from 'react-router-dom';

import {live, useConnection, useSensors} from './api/live';
import {DOC_URL} from './groups';
import {AboutPage} from './pages/About';
import {DemoPage} from './pages/Demo';
import {IncidentsPage} from './pages/Incidents';
import {LabPage} from './pages/Lab';
import {OverviewPage} from './pages/Overview';
import {SensorPage} from './pages/SensorPage';
import {localStorageGet, localStorageSet} from './utils/storage';

export const EXPERT = '/expert';

const LOGO = `data:image/svg+xml;utf8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1f2328"/><path d="M5 20h5l3-9 4 14 3-9h7" fill="none" stroke="#ffcc00" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
)}`;

type ThemeProps = {theme: 'light' | 'dark'; onTheme: (t: 'light' | 'dark') => void};

export function App(props: ThemeProps) {
    const {pathname} = useLocation();
    useEffect(() => live.connect(), []);
    return pathname.startsWith(EXPERT) ? <ExpertLayout {...props} /> : <SimpleLayout {...props} />;
}

function ConnectionBanner() {
    const connection = useConnection();
    if (connection !== 'closed') return null;
    return (
        <Flex className="sw-banner">
            <Text>Нет связи со шлюзом. Запустите start_demo.bat (или python -m uvicorn app.main:app --port 8000 в папке gateway).</Text>
        </Flex>
    );
}

function ModeSwitch({value}: {value: 'simple' | 'expert'}) {
    const navigate = useNavigate();
    return (
        <SegmentedRadioGroup
            value={value}
            onUpdate={(v) => navigate(v === 'simple' ? '/' : EXPERT)}
            options={[
                {value: 'simple', content: 'Простой режим'},
                {value: 'expert', content: 'Эксперт'},
            ]}
        />
    );
}

// ------------------------------------------------------------------ простой режим
function SimpleLayout({theme, onTheme}: ThemeProps) {
    const connection = useConnection();
    return (
        <div className="sw-simple">
            <header className="sw-topbar">
                <Flex gap={2} alignItems="center">
                    <img src={LOGO} width={28} height={28} alt="" />
                    <Flex direction="column">
                        <Text variant="subheader-2">Sensor Watch</Text>
                        <Text variant="caption-2" color="secondary">монитор дрейфа сенсоров · кейс 07</Text>
                    </Flex>
                </Flex>
                <Flex gap={2} alignItems="center" wrap>
                    <span className={`sw-dot sw-dot_${connection}`} title={connection === 'open' ? 'шлюз на связи' : 'нет связи'} />
                    <Button view="flat" href={DOC_URL} target="_blank">
                        Документ
                    </Button>
                    <Button view="flat" onClick={() => onTheme(theme === 'light' ? 'dark' : 'light')} title="Тема">
                        <Icon data={theme === 'light' ? Moon : Sun} size={16} />
                    </Button>
                    <ModeSwitch value="simple" />
                </Flex>
            </header>
            <ConnectionBanner />
            <main className="sw-simple-body">
                <DemoPage />
            </main>
        </div>
    );
}

// ------------------------------------------------------------------ режим эксперта
function ExpertLayout({theme, onTheme}: ThemeProps) {
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
    const p = pathname.slice(EXPERT.length) || '/';

    const item = (id: string, title: string, icon: MenuItem['icon'], path: string, current: boolean, extra?: Partial<MenuItem>): MenuItem => ({
        id,
        title,
        icon,
        current,
        onItemClick: () => navigate(EXPERT + path),
        ...extra,
    });

    const menuItems: MenuItem[] = [
        item('overview', 'Обзор', LayoutCellsLarge, '', p === '/'),
        item('sensors', 'Датчики', ChartLine, sensors[0] ? `/sensors/${encodeURIComponent(sensors[0].id)}` : '', p.startsWith('/sensors')),
        item('incidents', 'Инциденты', TriangleExclamation, '/incidents', p === '/incidents', {
            rightAdornment: open ? <Label theme="danger" size="xs">{open}</Label> : undefined,
        }),
        item('lab', 'Сценарии и проверка', Flask, '/lab', p === '/lab'),
        item('groups', '7 групп ошибок', ListUl, '/about', p === '/about'),
    ];

    return (
        <AsideHeader
            logo={{text: 'Sensor Watch', iconSrc: LOGO, iconSize: 28, onClick: () => navigate(EXPERT)}}
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
                    <FooterItem compact={c} id="simple" title="Простой режим" icon={Eye} onItemClick={() => navigate('/')} />
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
                    <div className="sw-expert-bar">
                        <ModeSwitch value="expert" />
                    </div>
                    <ConnectionBanner />
                    <Routes>
                        <Route path={EXPERT} element={<OverviewPage />} />
                        <Route path={`${EXPERT}/sensors/:id`} element={<SensorPage />} />
                        <Route path={`${EXPERT}/incidents`} element={<IncidentsPage />} />
                        <Route path={`${EXPERT}/lab`} element={<LabPage />} />
                        <Route path={`${EXPERT}/about`} element={<AboutPage />} />
                        <Route path="*" element={<OverviewPage />} />
                    </Routes>
                </main>
            )}
        />
    );
}
