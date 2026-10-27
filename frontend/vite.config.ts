import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// Шлюз FastAPI по умолчанию на :8000; адрес можно сменить через GATEWAY_URL
const gateway = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8000';

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': {target: gateway, changeOrigin: true, ws: true},
            '/docs': {target: gateway, changeOrigin: true},
            '/openapi.json': {target: gateway, changeOrigin: true},
        },
    },
    build: {chunkSizeWarningLimit: 2500},
});
