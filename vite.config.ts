import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: 'public/html', // ソースファイルがある場所
  base: './', // どこにデプロイしても動くように相対パスにする
  assetsInclude: ['**/*.glb'], // GLBファイルをアセットとして認識
  build: {
    chunkSizeWarningLimit: 2000, // 警告が出るしきい値を2MBに引き上げ
    outDir: '../../dist', // ビルド済みJSの出力先
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'public/html/index.html'),
      output: {
        manualChunks: {
          // 大型のライブラリをベンダーチャックとして分離
          'three-vendor': ['three', '@react-three/fiber', '@react-three/drei'],
          'react-vendor': ['react', 'react-dom'],
        },
      },
    },
  },
});