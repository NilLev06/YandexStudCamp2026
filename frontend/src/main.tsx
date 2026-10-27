import {StrictMode, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ThemeProvider, Toaster, ToasterComponent, ToasterProvider} from '@gravity-ui/uikit';
import {BrowserRouter} from 'react-router-dom';

import '@gravity-ui/uikit/styles/fonts.css';
import '@gravity-ui/uikit/styles/styles.css';
import './styles.css';

import {App} from './App';
import {localStorageGet, localStorageSet} from './utils/storage';

const toaster = new Toaster();

function Root() {
    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        const saved = localStorageGet('sw-theme');
        if (saved === 'light' || saved === 'dark') return saved;
        return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    });
    return (
        <ThemeProvider theme={theme}>
            <ToasterProvider toaster={toaster}>
                <BrowserRouter>
                    <App
                        theme={theme}
                        onTheme={(t) => {
                            setTheme(t);
                            localStorageSet('sw-theme', t);
                        }}
                    />
                </BrowserRouter>
                <ToasterComponent />
            </ToasterProvider>
        </ThemeProvider>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <Root />
    </StrictMode>,
);
