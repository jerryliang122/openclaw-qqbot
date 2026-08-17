/**
 * 语音严格模式（telegram 模式）单元测试
 *
 * 锁定判定协议：配置了自有 STT（插件级或框架探测级）且未显式开启
 * asrFallback 时，平台转写（asr_refer_text）完全不参与——
 * - shouldUsePlatformAsr 判定
 * - resolveSTTConfig 的 asrFallback 解析（含框架探测级）
 * - body-assembler 的 - ASR: 行在 transcript 不携带 asrReferText 时不输出
 *
 * 运行方式:  npx tsx tests/voice-strict-mode.test.ts
 */
import assert from 'node:assert';
import { resolveSTTConfig, shouldUsePlatformAsr } from '../src/utils/stt.js';
import { assembleBody } from '../src/dispatch/body-assembler.js';
import { formatVoiceText, type VoiceTranscript } from '../src/utils/voice-text.js';

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

// ── shouldUsePlatformAsr 判定 ─────────────────────────────

console.log('\n=== shouldUsePlatformAsr 判定 ===');

test('未配置 STT → 平台转写保留（唯一来源）', () => {
  assert.equal(shouldUsePlatformAsr(null), true);
});

test('自有 STT + 默认（无 asrFallback）→ 严格模式，平台转写丢弃', () => {
  const cfg = resolveSTTConfig({
    channels: { qqbot: { stt: { baseUrl: 'https://api.example.com', apiKey: 'k' } } },
  })!;
  assert.ok(cfg);
  assert.equal(cfg.asrFallback, false);
  assert.equal(shouldUsePlatformAsr(cfg), false);
});

test('自有 STT + asrFallback: true → 旧行为，平台转写保留', () => {
  const cfg = resolveSTTConfig({
    channels: { qqbot: { stt: { baseUrl: 'https://api.example.com', apiKey: 'k', asrFallback: true } } },
  })!;
  assert.equal(cfg.asrFallback, true);
  assert.equal(shouldUsePlatformAsr(cfg), true);
});

// ── resolveSTTConfig 的 asrFallback 解析 ──────────────────

console.log('\n=== resolveSTTConfig asrFallback 解析 ===');

test('框架探测级（tools.media.audio）无 qqbot.stt → asrFallback 默认 false', () => {
  const cfg = resolveSTTConfig({
    tools: { media: { audio: { models: [{ baseUrl: 'https://api.example.com', apiKey: 'k', model: 'whisper-1' }] } } },
  })!;
  assert.ok(cfg);
  assert.equal(cfg.asrFallback, false);
});

test('框架探测级凭证 + qqbot.stt.asrFallback: true → 开关从 qqbot.stt 读取', () => {
  const cfg = resolveSTTConfig({
    channels: { qqbot: { stt: { asrFallback: true } } },
    tools: { media: { audio: { models: [{ baseUrl: 'https://api.example.com', apiKey: 'k' }] } } },
  })!;
  assert.ok(cfg);
  assert.equal(cfg.asrFallback, true);
});

test('stt.enabled: false → STT 整体关闭（平台转写成为唯一来源）', () => {
  const cfg = resolveSTTConfig({
    channels: { qqbot: { stt: { enabled: false, baseUrl: 'https://api.example.com', apiKey: 'k' } } },
    tools: { media: { audio: { models: [{ baseUrl: 'https://api.example.com', apiKey: 'k' }] } } },
  });
  assert.equal(cfg, null);
});

// ── body-assembler：- ASR: 行不泄漏 ───────────────────────

console.log('\n=== body-assembler - ASR: 行 ===');

function buildAgentBody(transcripts: VoiceTranscript[]): string {
  const ctx = {
    message: { content: 'hello', kind: 'c2c', senderId: 's1', messageId: 'm1' },
    state: {
      processedAttachments: {
        // 与真实链路一致：voiceText 由 formatVoiceText(transcripts) 生成
        voiceText: formatVoiceText(transcripts),
        imageUrls: [],
        otherInfo: '',
        transcripts,
        localMediaPaths: [],
        localMediaTypes: [],
        remoteMediaUrls: [],
        media: [],
      },
    },
    signal: undefined,
  } as never;
  const msg = {
    kind: 'c2c',
    content: 'hello',
    senderId: 's1',
    replyTarget: { scope: 'c2c', targetId: 's1' },
    attachments: [],
  } as never;
  return assembleBody(ctx, msg, { accountId: 'default', appId: 'a', secret: 's' } as never).agentBody;
}

test('严格模式（stt 成功、不携带 asrReferText）→ 无 - ASR: 行', () => {
  const body = buildAgentBody([
    { text: '自有转写结果', source: 'stt', localPath: '/tmp/v.wav' },
  ]);
  assert.ok(!body.includes('- ASR:'), `不应包含 - ASR: 行，实际: ${body}`);
});

test('旧行为（asrFallback: true，携带 asrReferText）→ - ASR: 行保留平台文本', () => {
  const body = buildAgentBody([
    { text: '自有转写结果', source: 'stt', localPath: '/tmp/v.wav', asrReferText: '平台转写文本' },
  ]);
  assert.ok(body.includes('- ASR: 平台转写文本'));
});

test('严格模式 STT 失败（fallback、无 asrReferText）→ 占位文本且无 - ASR: 行', () => {
  const body = buildAgentBody([
    { text: '[Voice message - transcription failed]', source: 'fallback', localPath: '/tmp/v.wav' },
  ]);
  assert.ok(body.includes('[Voice message - transcription failed]'));
  assert.ok(!body.includes('- ASR:'));
});

// ── 汇总 ──────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`FAILED: ${failedTests.join(', ')}`);
  process.exit(1);
}
