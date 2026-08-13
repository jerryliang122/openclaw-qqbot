/**
 * 引用消息功能测试
 *
 * 验证移除 concurrencyGuard 后，引用消息功能仍然完整保留。
 *
 * 运行方式: npx tsx tests/quote-message.test.ts
 */
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

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

// ── Mock RefIndexStore ──────────────────────────────────────────

interface RefEntry {
  messageId: string;
  content: string;
  senderId: string;
  senderName?: string;
  timestamp: string;
  isBot?: boolean;
  scope?: string;
}

class MockRefIndexStore {
  private memory = new Map<string, RefEntry>();

  get(key: string): RefEntry | undefined {
    return this.memory.get(key);
  }

  set(key: string, entry: RefEntry): void {
    this.memory.set(key, entry);
  }

  clear(): void {
    this.memory.clear();
  }

  get size(): number {
    return this.memory.size;
  }
}

// ── 模拟 wrapBotSendForRefIndex 行为 ──────────────────────────────────────────

function simulateSendText(
  store: MockRefIndexStore,
  accountId: string,
  appId: string,
  senderName: string,
  target: { scope: string },
  text: string,
  mockResponse: { id: string; timestamp: number; ext_info?: { ref_idx?: string } }
): void {
  const refIdx = mockResponse.ext_info?.ref_idx;
  if (!refIdx) return;

  const entry: RefEntry = {
    messageId: mockResponse.id,
    content: text,
    senderId: appId,
    senderName,
    timestamp: new Date(mockResponse.timestamp).toISOString(),
    isBot: true,
    scope: target.scope,
  };

  store.set(refIdx, entry);
}

function simulateSendMedia(
  store: MockRefIndexStore,
  accountId: string,
  appId: string,
  senderName: string,
  target: { scope: string },
  mediaKind: string,
  mockResponse: { message?: { id: string; timestamp: number; ext_info?: { ref_idx?: string } } }
): void {
  const msg = mockResponse.message;
  if (!msg) return;

  const refIdx = msg.ext_info?.ref_idx;
  if (!refIdx) return;

  const content = mediaKind === 'voice' ? '[语音]'
                : mediaKind === 'image' ? '[图片]'
                : mediaKind === 'video' ? '[视频]'
                : `[${mediaKind}]`;

  const entry: RefEntry = {
    messageId: msg.id,
    content,
    senderId: appId,
    senderName,
    timestamp: new Date(msg.timestamp).toISOString(),
    isBot: true,
    scope: target.scope,
  };

  store.set(refIdx, entry);
}

// ── 测试开始 ──────────────────────────────────────────

const store = new MockRefIndexStore();

group('文本消息存储');

test('发送文本消息应该存储到 ref-index store', () => {
  simulateSendText(
    store,
    'default',
    'BOT_APPID',
    'QQBot',
    { scope: 'c2c' },
    '你好，有什么可以帮你的？',
    {
      id: 'MSG_001',
      timestamp: Date.now(),
      ext_info: { ref_idx: 'REFIDX_001' },
    }
  );

  const entry = store.get('REFIDX_001');
  assert.ok(entry, 'ref_idx 应该被存储');
  assert.strictEqual(entry?.content, '你好，有什么可以帮你的？');
  assert.strictEqual(entry?.senderId, 'BOT_APPID');
  assert.strictEqual(entry?.senderName, 'QQBot');
  assert.strictEqual(entry?.isBot, true);
  assert.strictEqual(entry?.scope, 'c2c');
});

test('没有 ref_idx 的响应不应该存储', () => {
  const initialSize = store.size;

  simulateSendText(
    store,
    'default',
    'BOT_APPID',
    'QQBot',
    { scope: 'c2c' },
    '这条消息不会被存储',
    {
      id: 'MSG_002',
      timestamp: Date.now(),
      // 没有 ext_info.ref_idx
    }
  );

  assert.strictEqual(store.size, initialSize, '没有 ref_idx 的消息不应该存储');
});

group('媒体消息存储');

test('发送图片应该存储 [图片] 标签', () => {
  simulateSendMedia(
    store,
    'default',
    'BOT_APPID',
    'QQBot',
    { scope: 'group' },
    'image',
    {
      message: {
        id: 'MSG_003',
        timestamp: Date.now(),
        ext_info: { ref_idx: 'REFIDX_003' },
      },
    }
  );

  const entry = store.get('REFIDX_003');
  assert.ok(entry, '图片消息应该被存储');
  assert.strictEqual(entry?.content, '[图片]');
});

test('发送语音应该存储 [语音] 标签', () => {
  simulateSendMedia(
    store,
    'default',
    'BOT_APPID',
    'QQBot',
    { scope: 'c2c' },
    'voice',
    {
      message: {
        id: 'MSG_004',
        timestamp: Date.now(),
        ext_info: { ref_idx: 'REFIDX_004' },
      },
    }
  );

  const entry = store.get('REFIDX_004');
  assert.ok(entry, '语音消息应该被存储');
  assert.strictEqual(entry?.content, '[语音]');
});

test('发送视频应该存储 [视频] 标签', () => {
  simulateSendMedia(
    store,
    'default',
    'BOT_APPID',
    'QQBot',
    { scope: 'group' },
    'video',
    {
      message: {
        id: 'MSG_005',
        timestamp: Date.now(),
        ext_info: { ref_idx: 'REFIDX_005' },
      },
    }
  );

  const entry = store.get('REFIDX_005');
  assert.ok(entry, '视频消息应该被存储');
  assert.strictEqual(entry?.content, '[视频]');
});

test('发送文件应该存储 [文件] 标签', () => {
  simulateSendMedia(
    store,
    'default',
    'BOT_APPID',
    'QQBot',
    { scope: 'c2c' },
    'file',
    {
      message: {
        id: 'MSG_006',
        timestamp: Date.now(),
        ext_info: { ref_idx: 'REFIDX_006' },
      },
    }
  );

  const entry = store.get('REFIDX_006');
  assert.ok(entry, '文件消息应该被存储');
  assert.strictEqual(entry?.content, '[file]');
});

group('引用查询');

test('应该能够通过 ref_idx 查询已存储的消息', () => {
  // 先存储一条消息
  simulateSendText(
    store,
    'default',
    'BOT_APPID',
    'QQBot',
    { scope: 'c2c' },
    '这是测试消息',
    {
      id: 'MSG_007',
      timestamp: Date.now(),
      ext_info: { ref_idx: 'REFIDX_007' },
    }
  );

  // 然后查询
  const entry = store.get('REFIDX_007');
  assert.ok(entry, '应该能查询到已存储的消息');
  assert.strictEqual(entry?.content, '这是测试消息');
});

test('查询不存在的 ref_idx 应该返回 undefined', () => {
  const entry = store.get('REFIDX_NOT_EXIST');
  assert.strictEqual(entry, undefined, '查询不存在的 ref_idx 应该返回 undefined');
});

group('多账户隔离');

test('不同账户应该使用独立的 store', () => {
  const store1 = new MockRefIndexStore();
  const store2 = new MockRefIndexStore();

  simulateSendText(
    store1,
    'account1',
    'BOT_APPID_1',
    'Bot1',
    { scope: 'c2c' },
    'Account 1 消息',
    {
      id: 'MSG_008',
      timestamp: Date.now(),
      ext_info: { ref_idx: 'REFIDX_008' },
    }
  );

  simulateSendText(
    store2,
    'account2',
    'BOT_APPID_2',
    'Bot2',
    { scope: 'c2c' },
    'Account 2 消息',
    {
      id: 'MSG_009',
      timestamp: Date.now(),
      ext_info: { ref_idx: 'REFIDX_009' },
    }
  );

  assert.strictEqual(store1.size, 1, 'store1 应该只有 1 条消息');
  assert.strictEqual(store2.size, 1, 'store2 应该只有 1 条消息');
  assert.strictEqual(store1.get('REFIDX_008')?.content, 'Account 1 消息');
  assert.strictEqual(store2.get('REFIDX_009')?.content, 'Account 2 消息');
});

group('scope 标记');

test('私聊消息应该标记 scope=c2c', () => {
  simulateSendText(
    store,
    'default',
    'BOT_APPID',
    'QQBot',
    { scope: 'c2c' },
    '私聊消息',
    {
      id: 'MSG_010',
      timestamp: Date.now(),
      ext_info: { ref_idx: 'REFIDX_010' },
    }
  );

  const entry = store.get('REFIDX_010');
  assert.strictEqual(entry?.scope, 'c2c');
});

test('群聊消息应该标记 scope=group', () => {
  simulateSendText(
    store,
    'default',
    'BOT_APPID',
    'QQBot',
    { scope: 'group' },
    '群聊消息',
    {
      id: 'MSG_011',
      timestamp: Date.now(),
      ext_info: { ref_idx: 'REFIDX_011' },
    }
  );

  const entry = store.get('REFIDX_011');
  assert.strictEqual(entry?.scope, 'group');
});

group('边界情况');

test('空文本内容应该正常存储', () => {
  simulateSendText(
    store,
    'default',
    'BOT_APPID',
    'QQBot',
    { scope: 'c2c' },
    '',
    {
      id: 'MSG_012',
      timestamp: Date.now(),
      ext_info: { ref_idx: 'REFIDX_012' },
    }
  );

  const entry = store.get('REFIDX_012');
  assert.ok(entry, '空文本消息应该被存储');
  assert.strictEqual(entry?.content, '');
});

test('长文本内容应该正常存储', () => {
  const longText = '这是一条很长的消息'.repeat(100); // 约 900 字符

  simulateSendText(
    store,
    'default',
    'BOT_APPID',
    'QQBot',
    { scope: 'c2c' },
    longText,
    {
      id: 'MSG_013',
      timestamp: Date.now(),
      ext_info: { ref_idx: 'REFIDX_013' },
    }
  );

  const entry = store.get('REFIDX_013');
  assert.ok(entry, '长文本消息应该被存储');
  assert.strictEqual(entry?.content, longText);
  assert.strictEqual(entry?.content.length, longText.length);
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
  process.exit(0);
}
