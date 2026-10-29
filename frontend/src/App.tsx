import {ChartColumn, Flask, Layers, Moon, Pulse, Sun, TriangleExclamation} from '@gravity-ui/icons';
import {AsideHeader, type MenuItem} from '@gravity-ui/navigation';
import {Alert, Button, Icon, Loader, ThemeProvider, Toaster, ToasterComponent, ToasterProvider} from '@gravity-ui/uikit';
import {useEffect, useState} from 'react';
import {Navigate, Route, Routes, useLocation, useNavigate} from 'react-router-dom';

import {api} from './api/client';
import {useAsync} from './hooks/useAsync';
import {MetaContext} from './lib/meta';
import {AnalysisPage} from './pages/AnalysisPage';
import {IncidentsPage} from './pages/IncidentsPage';
import {SinglePage} from './pages/SinglePage';
import {PairPage} from './pages/PairPage';

type Theme = 'light' | 'dark';

const toaster = new Toaster();

function initialTheme(): Theme {
    try {
        const saved = localStorage.getItem('sensor-watch-theme');
        if (saved === 'light' || saved === 'dark') return saved;
    } catch {
        // хранилище недоступно — берём системную тему
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const PAGES = [
    {id: 'single', path: '/single', title: 'Один датчик', icon: Pulse, match: (p: string) => p.startsWith('/single')},
    {id: 'pair', path: '/pair', title: 'Два датчика', icon: Layers, match: (p: string) => p.startsWith('/pair')},
    {id: 'incidents', path: '/incidents', title: 'Тревоги', icon: TriangleExclamation, match: (p: string) => p.startsWith('/incidents')},
    {id: 'analysis', path: '/analysis', title: 'Анализ сценариев', icon: Flask, match: (p: string) => p.startsWith('/analysis')},
];

export function App() {
    const [theme, setTheme] = useState<Theme>(initialTheme);
    const narrow = () => window.matchMedia?.('(max-width: 800px)').matches ?? false;
    const [compact, setCompact] = useState(narrow);
    const navigate = useNavigate();
    const {pathname} = useLocation();
    const meta = useAsync(api.meta, []);

    useEffect(() => {
        const query = window.matchMedia?.('(max-width: 800px)');
        if (!query) return;
        const onChange = (e: MediaQueryListEvent) => e.matches && setCompact(true);
        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
    }, []);

    const toggleTheme = () => {
        const next = theme === 'light' ? 'dark' : 'light';
        setTheme(next);
        try {
            localStorage.setItem('sensor-watch-theme', next);
        } catch {
            // не сохраняем — тема всё равно переключится
        }
    };

    const menuItems: MenuItem[] = PAGES.map((p) => ({
        id: p.id,
        title: p.title,
        icon: p.icon,
        current: p.match(pathname),
        onItemClick: () => navigate(p.path),
    }));

    const content = () => {
        if (meta.error)
            return (
                <div className="page">
                    <Alert theme="danger" title="Gateway недоступен" message={`${meta.error.message}. Запустите: uvicorn app.main:app --port 8000`} />
                </div>
            );
        if (!meta.data)
            return (
                <div className="page">
                    <Loader size="l" />
                </div>
            );
        return (
            <MetaContext.Provider value={meta.data}>
                <Routes>
                    <Route path="/single" element={<SinglePage />} />
                    <Route path="/pair" element={<PairPage />} />
                    <Route path="/" element={<Navigate to="/single" replace />} />
                    <Route path="/incidents" element={<IncidentsPage />} />
                    <Route path="/analysis" element={<AnalysisPage />} />
                    <Route path="*" element={<Navigate to="/single" replace />} />
                </Routes>
            </MetaContext.Provider>
        );
    };

    return (
        <ThemeProvider theme={theme}>
            <ToasterProvider toaster={toaster}>
                <AsideHeader
                    logo={{text: 'Sensor Watch', icon: ChartColumn, onClick: () => navigate('/single')}}
                    compact={compact}
                    onChangeCompact={setCompact}
                    menuItems={menuItems}
                    renderContent={content}
                    renderFooter={() => (
                        <div className="aside-footer">
                            <Button view="flat" onClick={toggleTheme} title="Сменить тему" width="max">
                                <Icon data={theme === 'light' ? Moon : Sun} />
                                {!compact && (theme === 'light' ? 'Тёмная тема' : 'Светлая тема')}
                            </Button>
                        </div>
                    )}
                />
                <ToasterComponent />
            </ToasterProvider>
        </ThemeProvider>
    );
}
