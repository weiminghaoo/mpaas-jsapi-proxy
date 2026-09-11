import { defineConfig } from 'vite';

// vite 只负责小程序端单文件产物 dist/index.js；
// Node 端 dist/server.js 由 scripts/build-server.mjs 用 esbuild 单独构建（原因见该文件头注释）。
//
// 必须单文件：多入口时 Rollup 会为共享代码（objectSpread2 helper）切出独立 chunk，
// 而小程序 npm 构建要求单文件——多文件相对 require 在小程序 npm 构建里更容易出问题，
// 手工拷贝调试也麻烦。
export default defineConfig({
  build: {
    lib: {
      entry: './src/index.ts',
      formats: ['cjs'],
      fileName: () => 'index.js',
    },
    outDir: 'dist',
    // 本构建最先执行，负责清空 dist；随后 esbuild 写入 server.js
    emptyOutDir: true,
    minify: 'esbuild',
    sourcemap: false,
    target: 'es2015', // 再往下（ES5）由 scripts/build-es5.mjs 用 Babel 降级
    ssr: true,
  },
});
