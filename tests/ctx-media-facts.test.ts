/**
 * ctx-builder media facts 单元测试
 *
 * 锁定正规媒体通道协议：全部附件（图片/语音/文件）按原始顺序映射为
 * core ChannelInboundMediaInput 形状（path / url / contentType / kind / transcribed），
 * 字段名必须是 path（不是 localPath），语音转写成功时带 transcribed: true。
 *
 * 运行方式:  npx tsx tests/ctx-media-facts.test.ts
 */
import assert from 'node:assert';
import { buildCtxPayload } from '../src/dispatch/ctx-builder.js';

// ── 测试基础设施 ──────────────────────────────────────────

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ ${name}\n    ${msg}`);
    failed++;
    failedTests.push(name);
  }
}

// ── 最小可用 mock ─────────────────────────────────────────

/** identity buildInboundContext：原样返回入参，便于断言传给 core 的字段 */
const adapters = {
  buildInboundContext: (params: Record<string, unknown>) => params,
} as never;

function buildPayload(processedMedia: unknown) {
  const ctx = { state: { processedAttachments: { media: processedMedia } }, signal: undefined } as never;
  const msg = {
    replyTarget: { scope: 'c2c', targetId: 'user-1' },
    senderId: 'user-1',
    senderName: 'Alice',
    messageId: 'msg-1',
    content: 'hello',
    timestamp: '2026-08-17T00:00:00Z',
  } as never;
  const envelope = {
    targetId: 'qqbot:c2c:user-1',
    chatScope: 'direct',
    senderId: 'user-1',
    senderName: 'Alice',
    messageId: 'msg-1',
  } as never;
  const route = { sessionKey: 'qqbot:default:user-1', accountId: 'default' };
  return buildCtxPayload({
    assembled: { webBody: 'hi', agentBody: 'hi', rawBody: 'hello' },
    envelope,
    route,
    msg,
    ctx,
    adapters,
  });
}

// ── 用例 ──────────────────────────────────────────────────

console.log('\n=== media facts 正规通道映射 ===');

test('图片 + 文件 + 语音：全部附件按原始顺序映射，字段名为 path', () => {
  const payload = buildPayload([
    { kind: 'image', localPath: '/tmp/a.jpg', contentType: 'image/png' },
    { kind: 'document', localPath: '/tmp/doc.pdf', contentType: 'application/pdf', filename: 'doc.pdf' },
    { kind: 'audio', localPath: '/tmp/v.wav', contentType: 'audio/wav', transcribed: true },
  ]);
  const media = payload.media as Array<Record<string, unknown>>;
  assert.equal(media.length, 3);
  assert.deepEqual(media[0], { kind: 'image', path: '/tmp/a.jpg', url: '/tmp/a.jpg', contentType: 'image/png' });
  assert.deepEqual(media[1], { kind: 'document', path: '/tmp/doc.pdf', url: '/tmp/doc.pdf', contentType: 'application/pdf' });
  assert.deepEqual(media[2], { kind: 'audio', path: '/tmp/v.wav', url: '/tmp/v.wav', contentType: 'audio/wav', transcribed: true });
  // 绝不能再出现 localPath 字段（core 不识别）
  assert.ok(!('localPath' in media[0]));
});

test('无本地文件的附件回退到 remoteUrl（只有 url，无 path）', () => {
  const payload = buildPayload([
    { kind: 'image', remoteUrl: 'https://example.multimedia.qq.com.cn/i.jpg', contentType: 'image/jpeg' },
  ]);
  const media = payload.media as Array<Record<string, unknown>>;
  assert.deepEqual(media[0], { kind: 'image', url: 'https://example.multimedia.qq.com.cn/i.jpg', contentType: 'image/jpeg' });
});

test('语音转写失败（fallback）时不带 transcribed 标记', () => {
  const payload = buildPayload([
    { kind: 'audio', localPath: '/tmp/v.wav', contentType: 'audio/wav', transcribed: false },
  ]);
  const media = payload.media as Array<Record<string, unknown>>;
  assert.ok(!('transcribed' in media[0]));
});

test('无附件时 media 为 undefined', () => {
  const payload = buildPayload([]);
  assert.equal(payload.media, undefined);
});

test('processedAttachments 缺失（纯文本消息）时 media 为 undefined 且不抛错', () => {
  const payload = buildPayload(undefined);
  assert.equal(payload.media, undefined);
});

// ── 汇总 ──────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`FAILED: ${failedTests.join(', ')}`);
  process.exit(1);
}
