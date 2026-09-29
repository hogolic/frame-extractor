/**
 * Frame Extractor · 回归测试
 *
 * 用法：node tests/test.js
 *
 * 原理：index.html 是单文件应用，不便直接 require。
 * 本脚本会读取 index.html，用括号配对从源码中抽出纯函数
 * （clampTime / parseBatch / crc32 / frameName / buildZip），
 * 放进一个沙箱里执行，再对它们做断言。
 * 这样测的是真实源码，而不是复制品。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'index.html');

/* ---------- 从源码里抽函数 ---------- */

function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error('源码里找不到：' + signature);

  let i = src.indexOf('{', start);
  if (i === -1) throw new Error('函数体缺失：' + signature);

  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('括号不配对：' + signature);
}

/* ---------- 搭沙箱 ---------- */

function buildSandbox(html) {
  const pieces = [
    'const MAX_FRAMES = 400;',
    'let duration = 10;',
    'let baseName = "test_video";',
    'let frames = [];',
    'let crcTable = null;',
    'const __captured = [];',
    'const URL = { createObjectURL: function (b) { __captured.push(b); return "blob:mock"; } };',
    'function encodeText(str) { return new TextEncoder().encode(str); }',
    extractFunction(html, 'function clampTime(t)'),
    extractFunction(html, 'function parseBatch(str)'),
    extractFunction(html, 'function frameName(f)'),
    extractFunction(html, 'function crc32(data)'),
    extractFunction(html, 'function buildZip()'),
    `return {
      clampTime: clampTime,
      parseBatch: parseBatch,
      crc32: crc32,
      buildZip: buildZip,
      captured: __captured,
      setDuration: function (d) { duration = d; },
      setFrames: function (f) { frames = f; }
    };`
  ];
  // eslint-disable-next-line no-new-func
  return new Function(pieces.join('\n'))();
}

/* ---------- 断言工具 ---------- */

let passed = 0;
let failed = 0;

function ok(label, condition, detail) {
  if (condition) {
    passed++;
    console.log('  PASS  ' + label);
  } else {
    failed++;
    console.log('  FAIL  ' + label + (detail ? '\n        ' + detail : ''));
  }
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(label, a === e, 'got ' + a + ', want ' + e);
}

function throws(label, fn) {
  try {
    fn();
    ok(label, false, '预期抛错，但正常返回了');
  } catch (e) {
    ok(label + '  →  ' + e.message, true);
  }
}

/* ---------- 跑测试 ---------- */

function main() {
  const html = fs.readFileSync(HTML_PATH, 'utf-8');
  const sb = buildSandbox(html);

  console.log('\nFrame Extractor · 回归测试\n');
  console.log('源码：' + path.relative(process.cwd(), HTML_PATH) +
    '  (' + Buffer.byteLength(html, 'utf-8') + ' bytes)\n');

  /* --- 1. parseBatch：时间点解析 --- */
  console.log('[1] parseBatch — 指定时间点');
  sb.setDuration(10);
  eq('0, 1.5, 3, end', sb.parseBatch('0, 1.5, 3, end'), [0, 1.5, 3, 9.96]);
  eq('中文逗号分隔', sb.parseBatch('0，2， 4'), [0, 2, 4]);
  eq('end 的中文写法', sb.parseBatch('0, 末尾'), [0, 9.96]);
  eq('换行也能分隔', sb.parseBatch('1\n2\n3'), [1, 2, 3]);
  eq('重复值原样保留', sb.parseBatch('2, 2'), [2, 2]);
  eq('0 秒可取', sb.parseBatch('0'), [0]);

  console.log('\n[2] parseBatch — 按间隔');
  eq('every:1 从 0 开始', sb.parseBatch('every:1').slice(0, 3), [0, 1, 2]);
  eq('every:1 含尾帧共 11 个', [sb.parseBatch('every:1').length], [11]);
  eq('every:0.5 共 21 个', [sb.parseBatch('every:0.5').length], [21]);
  eq('every:0.1 最后一个不超过片长',
    sb.parseBatch('every:0.1').every(function (t) { return t <= 9.96; }), true);

  console.log('\n[3] parseBatch — 异常输入必须拦下');
  throws('乱填文字', function () { sb.parseBatch('abc'); });
  throws('超出片长', function () { sb.parseBatch('20'); });
  throws('超出片长的混合输入', function () { sb.parseBatch('0, 99'); });
  throws('空输入', function () { sb.parseBatch('   '); });
  throws('负时间', function () { sb.parseBatch('-1'); });
  throws('间隔为 0', function () { sb.parseBatch('every:0'); });

  console.log('\n[4] parseBatch — 短片边界');
  sb.setDuration(3.5);
  eq('3.5 秒片 every:1', sb.parseBatch('every:1'), [0, 1, 2, 3, 3.46]);

  sb.setDuration(0.02);
  eq('极短片 every: 只出 1 帧（不足一个间隔，仅剩尾帧）', sb.parseBatch('every:1'), [0]);
  eq('极短片时间点模式不产生负时间', sb.parseBatch('0, end'), [0, 0]);

  console.log('\n[5] clampTime — 边界夹取');
  sb.setDuration(10);
  eq('负数夹到 0', sb.clampTime(-5), 0);
  eq('超长夹到片尾', sb.clampTime(999), 9.96);
  eq('中间值不动', sb.clampTime(4), 4);
  eq('零长度视频不崩', (sb.setDuration(0), sb.clampTime(1)), 0);

  console.log('\n[6] crc32 — 标准测试向量');
  const bytes = function (s) { return new TextEncoder().encode(s); };
  eq('crc32("123456789") = 0xCBF43926',
    sb.crc32(bytes('123456789')).toString(16), 'cbf43926');
  eq('crc32("") = 0', sb.crc32(bytes('')), 0);
  eq('crc32("a") = 0xE8B7BE43',
    sb.crc32(bytes('a')).toString(16), 'e8b7be43');

  console.log('\n[7] buildZip — 手写 ZIP 结构');
  sb.setDuration(10);
  sb.setFrames([
    { fullUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==', t: 0, w: 1, h: 1 },
    { fullUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==', t: 1.5, w: 1, h: 1 }
  ]);
  const url = sb.buildZip();
  ok('返回了 objectURL', typeof url === 'string' && url.length > 0);

  const blob = sb.captured[sb.captured.length - 1];
  ok('产出了 Blob', !!blob);

  if (blob && typeof blob.arrayBuffer === 'function') {
    blob.arrayBuffer().then(function (ab) {
      const buf = Buffer.from(ab);

      ok('以本地文件头 PK\\x03\\x04 开头',
        buf.slice(0, 4).toString('hex') === '504b0304');
      ok('以中央目录结束记录 PK\\x05\\x06 结尾',
        buf.slice(buf.length - 22, buf.length - 18).toString('hex') === '504b0506');

      // EOCD 里的条目总数（偏移 10，2 字节小端）
      const count = buf.readUInt16LE(buf.length - 22 + 10);
      eq('EOCD 记录 2 个条目', count, 2);

      // 中央目录偏移（偏移 16，4 字节小端）
      const cdOffset = buf.readUInt32LE(buf.length - 22 + 16);
      ok('中央目录偏移落在文件内', cdOffset > 0 && cdOffset < buf.length);
      eq('中央目录签名正确',
        buf.slice(cdOffset, cdOffset + 4).toString('hex'), '504b0102');

      // 文件名应出现在字节流中
      const text = buf.toString('latin1');
      ok('含首帧文件名', text.indexOf('test_video_001_0.00s.png') !== -1);
      ok('含第二帧文件名', text.indexOf('test_video_002_1.50s.png') !== -1);

      finish();
    }).catch(function (e) {
      failed++;
      console.log('  FAIL  ZIP 异步校验出错: ' + e.message);
      finish();
    });
  } else {
    failed++;
    console.log('  FAIL  Blob 不可用，跳过 ZIP 结构校验');
    finish();
  }
}

function finish() {
  console.log('\n' + '─'.repeat(52));
  console.log('结果：' + passed + ' 通过 / ' + failed + ' 失败');
  console.log('─'.repeat(52) + '\n');
  process.exit(failed ? 1 : 0);
}

main();
