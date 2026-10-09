// Rollup 统一构建配置：一条 `rollup -c` 产出全部 JS 产物
//
// [client] dist/index.js —— 小程序端单文件 CJS：
//   esbuild 插件转译 TS（target es2015）→ Babel ES5 降级，产出保留缩进换行、不压缩。
//   ES5 降级是硬要求：支付宝小程序 IDE 默认不转译 node_modules，npm 包必须是 ES5 语法；
//   而打包工具最低只能到 ES2015（esbuild/Rollup 都不降 class/const），最后一公里必须 Babel。
//   刻意放弃压缩：产物虽要整包进小程序主包，但实测仅 19 KB → 27 KB（+44%），相对 2 MB 主包
//   上限仍是零头，换来真机 / IDE 报错堆栈与 dist 本身都能直接读懂。
//   压缩版真正丢掉的只是函数内的局部变量与参数名——esbuild 的 transform（非 bundle）模式本就
//   不重命名顶层符号，类名、方法名、this.xxx 属性名压缩前后一致，别指望压缩版堆栈"完全不可读"。
//
// [server] dist/server.js —— Node 端零运行时依赖：
//   ws / qrcode-terminal / minimist 全部打入，小程序端项目安装本包时不再拉入服务端依赖。
//   qrcode-terminal 源码含旧式八进制转义（"\033["），esbuild 按 sloppy CJS 可处理，
//   acorn（Rollup 解析器）+ commonjs 插件对 sloppy 扩展同样兼容。
//
// 中文一律按 utf8 原样输出。dist 里的中文变成 \uXXXX 有两个独立成因，两处都得管住：
//   1) esbuild 默认 charset 是 'ascii'，会把所有非 ASCII 字符转义 —— 三处 esbuild 调用显式设 'utf8'；
//   2) Babel 把模板字符串降级成 "..." + x 时，按 jsesc 默认的「非最小转义」把整串中文写成 \uXXXX。
//      普通字符串不受影响，所以只改 esbuild 会漏掉一半 —— 见 babelEs5 的 generatorOpts.jsescOption。
// 每个中文字符 utf8 下 3 字节 < \uXXXX 的 6 字节，改完产物反而更短。代价是产物不再是纯 ASCII：
// 万一下游工具链按 GBK 一类的非 UTF-8 编码读文件，中文会乱码——需要纯 ASCII 时把 charset 切回 'ascii'。
//
// bufferutil / utf-8-validate 是 ws 的 optional 原生加速模块：打入会携带 .node 二进制
// 导致跨环境损坏，保持 external 让 ws 自行回退纯 JS 实现；Node 内置模块由 preferBuiltins 外置。
//
// d.ts 不在本配置：仍由 tsc -p tsconfig.build.json 生成（见 package.json 的 build 命令）。

import { rmSync, readFileSync } from 'node:fs'
import { transform as esbuildTransform } from 'esbuild'
import { transformAsync as babelTransform, parseSync } from '@babel/core'
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

// chunk 级 esbuild 压缩（仅 server 使用；模块级 minify 留有 Rollup 拼接缝隙，整体压缩更彻底）
function esbuildMinify(target) {
  return {
    name: 'esbuild-minify',
    async renderChunk(code) {
      const out = await esbuildTransform(code, { minify: true, target, charset: 'utf8' })
      return { code: out.code, map: null }
    },
  }
}

// 语法结构比较：剥掉位置、格式与注释信息后，两段代码的 AST 是否同构。
// extra 也剥掉（存的是字面量原始写法，如 1e3 与 "x" 的引号风格），只留语法与值。
const AST_SKIP_KEYS = new Set([
  'start', 'end', 'loc', 'range', 'extra', 'errors',
  'leadingComments', 'trailingComments', 'innerComments', 'comments',
])
function astShape(node) {
  if (Array.isArray(node)) return node.map(astShape)
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const key of Object.keys(node)) {
    if (!AST_SKIP_KEYS.has(key)) out[key] = astShape(node[key])
  }
  return out
}
function sameAst(a, b) {
  const shape = (code) => JSON.stringify(astShape(parseSync(code, { sourceType: 'script' }).program))
  try {
    return shape(a) === shape(b)
  } catch {
    return false // 解析不了说明产物本身不合法，同样按复检失败处理
  }
}

// ES5 语法降级 + 幂等复检（仅客户端产物挂载，server 不降级避免 helper 体积膨胀）
function babelEs5() {
  const options = {
    // 输入已是 CJS 产物，按 script 解析，避免被当成 ESM 处理
    sourceType: 'script',
    babelrc: false,
    configFile: false,
    compact: false, // 保留缩进换行，dist 直接可读（幂等复检已相应改为忽略折行）
    comments: false, // 不把源码注释带进产物；若想让 dist 更易读可改 true（实测仅 +1 KB）
    // 模板字符串降级成 "..." + x 时，Babel 默认按 jsesc 的「非最小转义」把整串非 ASCII 写成 \uXXXX，
    // 中文日志于是变成不可读的转义序列（普通字符串不受影响，只有模板串会）。minimal 只转义必须转义的
    // 字符：中文与 emoji 原样保留，而真实换行、U+2028 / U+2029 仍会被正确转义（ES5 字符串里裸
    // U+2028 是语法错误，这点不能放开）。
    generatorOpts: { jsescOption: { minimal: true } },
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
      // 幂等复检：对降级结果再跑一次同套配置，两次的 AST 必须同构——没有可再降级的语法才算真 ES5。
      // 一旦有人写出新的高阶语法就会立刻报错，而不是等消费方小程序编译时报
      // error[CE1000.02]: The keyword 'const' is reserved
      //
      // 比较 AST 而不是字节：compact:false 的打印器会参考输入里既有的折行位置再折行，
      // 同一棵 AST 两次打印的换行与缩进并不相同（字节不等、语义相同），字节比较会误报；
      // AST 比较既不受打印格式干扰，又能抓住任何真实的 token 差异。
      const again = await babelTransform(result.code, { ...options, filename })
      if (!sameAst(again.code, result.code)) {
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
    esbuildPlugin({ target: 'es2015', charset: 'utf8' }),
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
    esbuildPlugin({ target: 'node18', charset: 'utf8' }),
    esbuildMinify('node18'),
  ],
}

export default [client, server]
