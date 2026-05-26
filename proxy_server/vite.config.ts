import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: './src/index.ts',
      },
      formats: ['cjs'],
      fileName: (format, entryName) => `${entryName}.js`
    },
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      external: ['ws', 'qrcode-terminal', 'os', 'minimist'],
      output: {
        preserveModules: false
      }
    },
    minify: 'esbuild',
    sourcemap: false,
    target: 'node18',
    ssr: true
  }
});
