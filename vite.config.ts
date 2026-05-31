import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: 'public/html', // ソースファイルがある場所
  base: './', // どこにデプロイしても動くように相対パスにする
  assetsInclude: ['**/*.glb', '**/*.md'], // GLBとMarkdownファイルをアセットとして認識
  worker: {
    format: 'es',
  },
  build: {
    chunkSizeWarningLimit: 2000, // 警告が出るしきい値を2MBに引き上げ
    outDir: '../../dist', // ビルド済みJSの出力先
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'public/html/index.html'),
        explower: resolve(__dirname, 'public/html/explower.html'),
        'plower/index': resolve(__dirname, 'public/html/plower/index.html'),
        'plower/manual': resolve(__dirname, 'public/html/plower/manual.html'),
        profile: resolve(__dirname, 'public/html/profile.html'),
        kitaiti: resolve(__dirname, 'public/html/kitaiti.html'),
        '404': resolve(__dirname, 'public/html/404.html'),
      },
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