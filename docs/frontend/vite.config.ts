import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

const gateway = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8000';

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {'/api': {target: gateway, changeOrigin: true}},
    },
});
