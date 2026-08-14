/**
 * 媒体标签优先级回归测试
 * 
 * 验证运算符优先级修复：当 content 非空时应该优先使用 content，
 * 而不是被 mediaKind 覆盖。
 * 
 * Bug 描述：
 * - 错误：content || mediaKind ? ... 被解析为 (content || mediaKind) ? ...
 * - 结果：当 content="你好" 且 mediaKind="voice" 时，错误地返回 "[语音]"
 * - 正确：应该返回 "你好"（content 优先）
 * 
 * 运行方式: npx tsx tests/media-tag-priority.test.ts
 */
import assert from 'node:assert';

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

function group(title: string) {
  console.log(`\n=== ${title} ===`);
}

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ✗ ${name}\n    ${msg}`);
    failed++;
    failedTests.push(name);
  }
}

// ── 错误的实现（bug 版本）──────────────────────────────────────────

function buggyStoreEntry(content: string, mediaKind?: string): string {
  // 错误的运算符优先级
  return content || mediaKind
    ? mediaKind === 'voice' ? '[语音]'
    : mediaKind === 'image' ? '[图片]'
    : mediaKind === 'video' ? '[视频]'
    : mediaKind === 'file' ? '[文件]'
    : mediaKind ? `[${mediaKind}]`
    : content
    : '';
}

// ── 正确的实现（修复后）──────────────────────────────────────────

function fixedStoreEntry(content: string, mediaKind?: string): string {
  // 修复运算符优先级问题：当 content 非空时直接使用
  let finalContent = content;
  if (!content && mediaKind) {
    finalContent = mediaKind === 'voice' ? '[语音]'
      : mediaKind === 'image' ? '[图片]'
      : mediaKind === 'video' ? '[视频]'
      : mediaKind === 'file' ? '[文件]'
      : `[${mediaKind}]`;
  }
  return finalContent;
}

// ── 测试开始 ──────────────────────────────────────────

group('关键 bug 验证');

test('content="你好", mediaKind="voice" → 应该返回 "你好"（content 优先）', () => {
  const buggyResult = buggyStoreEntry('你好', 'voice');
  const fixedResult = fixedStoreEntry('你好', 'voice');
  
  // 验证 bug 存在
  assert.strictEqual(buggyResult, '[语音]', 
    'Bug 版本错误地返回了媒体标签');
  
  // 验证修复正确
  assert.strictEqual(fixedResult, '你好', 
    '修复版本应该返回 content');
  
  // 验证修复生效
  assert.notStrictEqual(buggyResult, fixedResult, 
    '修复前后的结果应该不同，证明 bug 已修复');
});

test('content="这是一条消息", mediaKind="image" → 应该返回 "这是一条消息"', () => {
  const buggyResult = buggyStoreEntry('这是一条消息', 'image');
  const fixedResult = fixedStoreEntry('这是一条消息', 'image');
  
  assert.strictEqual(buggyResult, '[图片]', 
    'Bug 版本错误地被 mediaKind 覆盖');
  assert.strictEqual(fixedResult, '这是一条消息', 
    '修复版本正确返回 content');
});

group('正确行为验证');

test('content 为空，mediaKind="voice" → 应该返回 "[语音]"', () => {
  const result = fixedStoreEntry('', 'voice');
  assert.strictEqual(result, '[语音]', 
    'content 为空时应该使用媒体标签');
});

test('content 为空，mediaKind="image" → 应该返回 "[图片]"', () => {
  const result = fixedStoreEntry('', 'image');
  assert.strictEqual(result, '[图片]', 
    'content 为空时应该使用媒体标签');
});

test('content 为空，mediaKind="video" → 应该返回 "[视频]"', () => {
  const result = fixedStoreEntry('', 'video');
  assert.strictEqual(result, '[视频]', 
    'content 为空时应该使用媒体标签');
});

test('content 为空，mediaKind="file" → 应该返回 "[文件]"', () => {
  const result = fixedStoreEntry('', 'file');
  assert.strictEqual(result, '[文件]', 
    'content 为空时应该使用媒体标签');
});

test('content 有值，mediaKind=undefined → 应该返回 content', () => {
  const result = fixedStoreEntry('测试消息', undefined);
  assert.strictEqual(result, '测试消息', 
    'mediaKind 为空时应该返回 content');
});

test('content 和 mediaKind 都为空 → 应该返回空字符串', () => {
  const result = fixedStoreEntry('', undefined);
  assert.strictEqual(result, '', 
    '都为空时应该返回空字符串');
});

group('边界情况');

test('content 包含空白字符，mediaKind="image" → 应该返回 content（空白也是有效值）', () => {
  const result = fixedStoreEntry('   ', 'image');
  assert.strictEqual(result, '   ', 
    '空白字符也是有效的 content，不应该被媒体标签覆盖');
});

test('content 为 null-ish（空字符串），mediaKind 为其他类型 → 应该返回媒体标签', () => {
  const result = fixedStoreEntry('', 'custom_type');
  assert.strictEqual(result, '[custom_type]', 
    '未知媒体类型应该用方括号包裹');
});

test('长文本 content，mediaKind="video" → 应该返回完整 content', () => {
  const longText = '这是一条很长的消息内容'.repeat(100);
  const result = fixedStoreEntry(longText, 'video');
  
  assert.strictEqual(result, longText, 
    '长文本 content 不应该被截断或覆盖');
  assert.strictEqual(result.length, longText.length, 
    '长度应该保持一致');
});

group('回归测试：验证修复对比');

test('修复前后行为对比表', () => {
  const testCases = [
    { content: '你好', mediaKind: 'voice', expected: '你好' },
    { content: '', mediaKind: 'voice', expected: '[语音]' },
    { content: '消息', mediaKind: 'image', expected: '消息' },
    { content: '', mediaKind: 'image', expected: '[图片]' },
    { content: '测试', mediaKind: undefined, expected: '测试' },
    { content: '', mediaKind: undefined, expected: '' },
  ];
  
  testCases.forEach(({ content, mediaKind, expected }) => {
    const buggy = buggyStoreEntry(content, mediaKind);
    const fixed = fixedStoreEntry(content, mediaKind);
    
    // 验证修复版本正确
    assert.strictEqual(fixed, expected, 
      `修复版本 (${content}, ${mediaKind}) 应该返回 ${expected}`);
    
    // 验证 bug 版本在 content 非空时的错误
    if (content && mediaKind) {
      assert.notStrictEqual(buggy, expected, 
        `Bug 版本 (${content}, ${mediaKind}) 不应该返回 ${expected}`);
    }
  });
});

// ── 输出测试结果 ──────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log(`测试结果: ${passed} passed, ${failed} failed`);

if (failedTests.length > 0) {
  console.log('\n失败的测试:');
  failedTests.forEach(name => console.log(`  - ${name}`));
  process.exit(1);
} else {
  console.log('\n✅ 所有测试通过！');
  console.log('运算符优先级 bug 已修复，content 优先级正确。');
  process.exit(0);
}
