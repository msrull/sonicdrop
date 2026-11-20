import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig(() => {
  const useSsl = process.env.HTTPS === 'true';
  return {
    plugins: useSsl ? [basicSsl()] : [],
    base: './',
    build: {
      target: 'esnext',
      outDir: 'dist',
    },
    server: {
      port: 3000,
      host: true,
    },
  };
});
