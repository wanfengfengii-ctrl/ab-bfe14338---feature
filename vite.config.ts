import type { UserConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default {
  plugins: [react()],
  server: { host: true, port: 5173 },
  build: { outDir: 'dist', sourcemap: false },
} satisfies UserConfig;
