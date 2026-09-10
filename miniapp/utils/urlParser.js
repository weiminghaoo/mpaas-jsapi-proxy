/**
 * URL 编码字符串解析工具
 * 将类似 "url=ws%3A%2F%2F192.168.0.12%3A3000&id=123" 的字符串解析为对象
 */

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

      const key = decodeURIComponent(pair.substring(0, equalIndex))
      const value = decodeURIComponent(pair.substring(equalIndex + 1))

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

export { parseUrlString }
