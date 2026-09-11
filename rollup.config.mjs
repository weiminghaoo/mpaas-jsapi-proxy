// Rollup 统一构建配置：一条 `rollup -c` 产出全部 JS 产物
//
// [client] dist/index.js —— 小程序端单文件 CJS：
//   esbuild 插件转译 TS（target es2015）→ chunk 级 esbuild 压缩 → Babel ES5 降级。
//   ES5 降级是硬要求：支付宝小程序 IDE 默认不转译 node_modules，npm 包必须是 ES5 语法；
//   而打包工具最低只能到 ES2015（esbuild/Rollup 都不降 class/const），最后一公里必须 Babel。
//
// [server] dist/server.js —— Node 端零运行时依赖：
//   ws / qrcode-terminal / minimist 全部打入，小程序端项目安装本包时不再拉入服务端依赖。
//   qrcode-terminal 源码含旧式八进制转义（"\033["），esbuild 按 sloppy CJS 可处理，
//   acorn（Rollup 解析器）+ commonjs 插件对 sloppy 扩展同样兼容。
//
// bufferutil / utf-8-validate 是 ws 的 optional 原生加速模块：打入会携带 .node 二进制
// 导致跨环境损坏，保持 external 让 ws 自行回退纯 JS 实现；Node 内置模块由 preferBuiltins 外置。
//
// d.ts 不在本配置：仍由 tsc -p tsconfig.build.json 生成（见 package.json 的 build 命令）。

import { rmSync, readFileSync } from 'node:fs'
import { transform as esbuildTransform } from 'esbuild'
import { transformAsync as babelTransform } from '@babel/core'
import nodeResolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import esbuildPlugin from 'rollup-plugin-esbuild'

// 清空 dist（Rollup 没有 emptyOutDir；仅挂在首个配置上，避免重复清空删掉后续产物）
function cleanDist() {
  return {
    name: 'clean-dist',
    buildStart() {
      rmSync('dist', { recursive: true, force: true })
    },
  }
}

// chunk 级 esbuild 压缩（模块级 minify 留有 Rollup 拼接缝隙，整体压缩更彻底）
function esbuildMinify(target) {
  return {
    name: 'esbuild-minify',
    async renderChunk(code) {
      const out = await esbuildTransform(code, { minify: true, target })
      return { code: out.code, map: null }
    },
  }
}

// ES5 语法降级 + 幂等复检（仅客户端产物挂载，server 不降级避免 helper 体积膨胀）
function babelEs5() {
  const options = {
    // 输入已是 CJS 产物，按 script 解析，避免被当成 ESM 处理
    sourceType: 'script',
    babelrc: false,
    configFile: false,
    compact: true,
    comments: false,
    presets: [
      [
        '@babel/preset-env',
        {
          targets: { ie: '11' }, // 等价于「全量 ES5 语法降级」
          modules: false, // 保持既有 CJS 结构不动
          useBuiltIns: false, // 绝不注入 core-js：小程序环境里没有 core-js 可 require
        },
      ],
    ],
  }
  return {
    name: 'babel-es5',
    async renderChunk(code, chunk) {
      if (!chunk.isEntry) return null
      const filename = `dist/${chunk.fileName}`
      const result = await babelTransform(code, { ...options, filename })
      // 幂等复检：对降级结果再跑一次同套配置，字节级不变才算真 ES5；
      // 一旦有人写出新的高阶语法就会立刻报错，而不是等消费方小程序编译时报
      // error[CE1000.02]: The keyword 'const' is reserved
      const again = await babelTransform(result.code, { ...options, filename })
      if (again.code !== result.code) {
        this.error(`${filename} 仍残留非 ES5 语法，小程序编译器会报 error[CE1000.02]`)
      }
      return { code: result.code, map: null }
    },
  }
}

// qrcode-terminal 源码含 legacy 八进制转义（"\033["），Rollup 按 strict（ESM）语义解析
// 会报 Legacy octal escape is not permitted in strict mode（Rolldown 报 PARSE_ERROR 同根因）。
// 在 load 阶段（parse 之前）把它规范化为等价 hex 转义（\033 → \x1b），语义不变且 strict 合法。
// 注：该包无正则字面量数字反引用（backreference），此替换不会误伤。
function patchLegacyOctalEscape() {
  return {
    name: 'patch-legacy-octal-escape',
    load(id) {
      // \x00 前缀是 commonjs 插件生成的虚拟代理模块，内容由插件自行生成，交给它处理
      if (id.startsWith('\0') || !/[\\/]qrcode-terminal[\\/]/.test(id)) return null
      const filePath = id.replace(/\?.*$/, '') // 剥掉插件附加的 query 后缀
      const code = readFileSync(filePath, 'utf8')
      return code.replace(/\\([0-7]{1,3})/g, (_, oct) => {
        return '\\x' + parseInt(oct, 8).toString(16).padStart(2, '0')
      })
    },
  }
}

const client = {
  input: 'src/index.ts',
  output: { file: 'dist/index.js', format: 'cjs', inlineDynamicImports: true },
  plugins: [
    cleanDist(),
    esbuildPlugin({ target: 'es2015' }),
    esbuildMinify('es2015'),
    babelEs5(),
  ],
}

const server = {
  input: 'src/server/index.ts',
  output: { file: 'dist/server.js', format: 'cjs' },
  external: ['bufferutil', 'utf-8-validate'],
  plugins: [
    patchLegacyOctalEscape(),
    nodeResolve({ preferBuiltins: true }),
    commonjs(),
    esbuildPlugin({ target: 'node18' }),
    esbuildMinify('node18'),
  ],
}

export default [client, server]
