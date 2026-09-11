/**
 * URL 编码字符串解析工具
 * 将类似 "url=ws%3A%2F%2F192.168.0.12%3A3000&id=123" 的字符串解析为对象
 */

// scheme:// 前缀，如 xlmpaas://、alipays://
const SCHEME_PREFIX_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//

// 容错解码：单个参数含裸 % 时不让整串解析失败
function safeDecode(str) {
  try {
    return decodeURIComponent(str)
  } catch (error) {
    return str
  }
}

function parseUrlString(input) {
  if (!input || typeof input !== 'string') {
    return {}
  }

  try {
    const result = {}
    const pairs = input.split('&')

    for (const pair of pairs) {
      const equalIndex = pair.indexOf('=')
      if (equalIndex === -1) {
        continue
      }

      const key = safeDecode(pair.substring(0, equalIndex))
      const value = safeDecode(pair.substring(equalIndex + 1))

      if (key) {
        result[key] = value
      }
    }

    return result
  } catch (error) {
    console.error('解析 URL 字符串失败:', error)
    return {}
  }
}

// 只接受 ws:// / wss:// 地址，其余一律视为无效
function normalizeServerUrl(value) {
  if (!value || typeof value !== 'string') {
    return ''
  }
  const url = value.trim()
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    return url
  }
  return ''
}

/**
 * 从扫码结果 / scheme 链接中提取服务器地址，兼容三种格式：
 * 1. xlmpaas://2026052614145188?url=ws%3A%2F%2F192.168.0.219%3A7521 （服务端二维码）
 * 2. url=ws%3A%2F%2F192.168.0.12%3A3000&deviceId=xxx                   （裸参数串）
 * 3. ws://192.168.0.219:7521                                          （地址本身）
 * 解析不到有效地址时返回空字符串
 */
function parseServerUrl(input) {
  if (!input || typeof input !== 'string') {
    return ''
  }

  const raw = input.trim()

  // 1. 直接就是 ws 地址
  const direct = normalizeServerUrl(raw)
  if (direct) {
    return direct
  }

  // 2. scheme 形式：剥掉 scheme://<host>，只解析 ? 之后的查询串
  if (SCHEME_PREFIX_RE.test(raw)) {
    const queryIndex = raw.indexOf('?')
    if (queryIndex === -1) {
      return ''
    }
    return normalizeServerUrl(parseUrlString(raw.substring(queryIndex + 1)).url)
  }

  // 3. 裸参数串
  return normalizeServerUrl(parseUrlString(raw).url)
}

export { parseUrlString, parseServerUrl }
