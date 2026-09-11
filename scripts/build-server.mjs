// Node 端产物构建：dist/server.js
//
// 为什么用 esbuild 而不是 vite：
// 1. server 需要把 ws / qrcode-terminal / minimist 全部打进产物，使发布包零运行时依赖——
//    小程序端项目安装本包时不再拉入服务端依赖。vite 的 ssr 构建默认外置 node_modules
//    裸模块（rollupOptions.external 管不到，须用 ssr.noExternal 对抗）。
// 2. qrcode-terminal 源码含旧式八进制转义（"\033["），Rolldown 解析直接报
//    PARSE_ERROR（'0'-prefixed octal literals are deprecated），esbuild 按 sloppy CJS 解析可正常处理。
//
// bufferutil / utf-8-validate 是 ws 的 optional 原生加速模块：打进 bundle 会携带
// .node 二进制导致跨环境损坏，保持 external 让 ws 自行回退纯 JS 实现。
// Node 内置模块由 platform: 'node' 自动外置。

import { build } from 'esbuild'

await build({
  entryPoints: ['src/server/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/server.js',
  minify: true,
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'info',
})
