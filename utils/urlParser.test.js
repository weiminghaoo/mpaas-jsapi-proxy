const { parseUrlString } = require('./urlParser');

describe('parseUrlString', () => {
  test('解析简单的 URL 编码字符串', () => {
    const input = 'url=ws%3A%2F%2F192.168.0.12%3A3000';
    const result = parseUrlString(input);

    expect(result).toEqual({
      url: 'ws://192.168.0.12:3000'
    });
  });

  test('解析多个参数的 URL 编码字符串', () => {
    const input = 'url=ws%3A%2F%2F192.168.0.12%3A3000&id=123&name=test%20user';
    const result = parseUrlString(input);

    expect(result).toEqual({
      url: 'ws://192.168.0.12:3000',
      id: '123',
      name: 'test user'
    });
  });

  test('解析包含中文字符的 URL 编码字符串', () => {
    const input = 'url=ws%3A%2F%2F192.168.0.12%3A3000&name=%E5%BC%A0%E4%B8%89';
    const result = parseUrlString(input);

    expect(result).toEqual({
      url: 'ws://192.168.0.12:3000',
      name: '张三'
    });
  });

  test('处理空字符串返回空对象', () => {
    const result = parseUrlString('');
    expect(result).toEqual({});
  });

  test('处理没有等号的字符串返回空对象', () => {
    const result = parseUrlString('just_a_string');
    expect(result).toEqual({});
  });

  test('解析包含特殊字符的 URL 编码字符串', () => {
    const input = 'email=test%40example.com&token=abc%20123';
    const result = parseUrlString(input);

    expect(result).toEqual({
      email: 'test@example.com',
      token: 'abc 123'
    });
  });
});
