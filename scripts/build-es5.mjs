// 小程序端产物 ES5 降级
//
// 为什么需要这一步：
// 支付宝小程序 IDE 默认 **不转译 node_modules**
// （mini.project.json 的 compileOptions.transpile.script.ignore 默认忽略 node_modules/**），
// 因此发布到 npm 的包必须是 ES5 语法，否则消费方编译时报：
//   error[CE1000.02]: The keyword 'const' is reserved
//
// 为什么不能只改打包工具的 target：
// - Rolldown（Vite 8 的打包内核）只支持 ES2015 及以上，target: 'es5' 直接报
//   [BUNDLER_INITIALIZE_ERROR] Invalid target 'es5'. Rolldown only supports ES2015 (ES6) and later.
// - esbuild 也无法把 class / const / 默认参数降级到 ES5（"not supported yet"）
// 所以「打什么包」和「降到哪个语法版本」是两件事：Vite(Rolldown) 负责打包，
// 产物再交给 Babel 做纯语法降级。
//
// 只处理小程序端产物；Node 端 server.js 不降级，避免无谓的 helper 体积增长。

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformAsync } from '@babel/core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(root, 'dist')

// 小程序端消费的产物清单（server.js 是 Node 端，不在此列）
const CLIENT_ARTIFACTS = ['index.js']

const babelOptions = {
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

// ES5 复检：对降级结果再跑一次同一套 Babel 配置——
// 若结果字节级不变，说明已无可降级的 ES6+ 语法；一旦有人写出新的高阶语法就会立刻报错。
// （实测：ES2015 产物二次转换会变，ES5 产物字节级幂等）
async function assertEs5(code, label) {
  const again = await transformAsync(code, { ...babelOptions, filename: label })
  if (again?.code !== code) {
    throw new Error(
      `[build-es5] ${label} 仍残留非 ES5 语法，小程序编译器会报 error[CE1000.02]`
    )
  }
}

for (const artifact of CLIENT_ARTIFACTS) {
  const filePath = join(distDir, artifact)
  const source = await readFile(filePath, 'utf8')
  const result = await transformAsync(source, { ...babelOptions, filename: filePath })

  if (!result?.code) {
    throw new Error(`[build-es5] ${artifact} 转译结果为空`)
  }

  await assertEs5(result.code, artifact)
  await writeFile(filePath, result.code)
  console.log(`[build-es5] ✅ ${artifact} 已降级为 ES5（${result.code.length} bytes）`)
}
