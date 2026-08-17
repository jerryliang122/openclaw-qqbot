/**
 * 语音严格模式（telegram 模式）单元测试
 *
 * 锁定判定协议：平台转写（asr_refer_text）仅在显式配置
 * channels.qqbot.stt.asrFallback: true 时参与；缺省、false 或 stt 块
 * 整体不存在时一律丢弃——包括 STT 未配置的场景（语音落占位文本）。
 * - shouldUsePlatformAsr 判定（独立于 STT 凭证解析成败）
 * - resolveSTTConfig 不再携带 asrFallback（开关移入独立读取）
 * - processAttachments 集成链路：占位文本 / asrReferText 丢弃
 * - body-assembler 的 - ASR: 行在 transcript 不携带 asrReferText 时不输出
 *
 * 运行方式:  npx tsx tests/voice-strict-mode.test.ts
 */
import assert from 'node:assert';
import { resolveSTTConfig, shouldUsePlatformAsr } from '../src/utils/stt.js';
import { processAttachments } from '../src/middleware/attachment.js';
import { assembleBody } from '../src/dispatch/body-assembler.js';
import { formatVoiceText, type VoiceTranscript } from '../src/utils/voice-text.js';

// ── 测试基础设施 ──────────────────────────────────────────

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ ${name}\n    ${msg}`);
    failed++;
    failedTests.push(name);
  }
}

// 注意：本文件不得使用顶层 await——attachment.ts 的依赖链
// （adapter/media.ts 的 __filename）依赖同步模块图，顶层 await 会破坏 tsx 的 CJS shim。

async function main(): Promise<void> {

// ── shouldUsePlatformAsr 判定 ─────────────────────────────

console.log('\n=== shouldUsePlatformAsr 判定 ===');

await test('未配置 STT（无 asrFallback）→ 平台转写丢弃', () => {
  assert.equal(shouldUsePlatformAsr({}), false);
});

await test('自有 STT + 默认（无 asrFallback）→ 平台转写丢弃', () => {
  const raw = {
    channels: { qqbot: { stt: { baseUrl: 'https://api.example.com', apiKey: 'k' } } },
  };
  assert.ok(resolveSTTConfig(raw));
  assert.equal(shouldUsePlatformAsr(raw), false);
});

await test('自有 STT + asrFallback: true → 平台转写保留', () => {
  const raw = {
    channels: { qqbot: { stt: { baseUrl: 'https://api.example.com', apiKey: 'k', asrFallback: true } } },
  };
  assert.ok(resolveSTTConfig(raw));
  assert.equal(shouldUsePlatformAsr(raw), true);
});

await test('stt 块无凭证 + asrFallback: true → 平台转写保留（显式 opt-in 不依赖凭证）', () => {
  const raw = { channels: { qqbot: { stt: { asrFallback: true } } } };
  assert.equal(resolveSTTConfig(raw), null);
  assert.equal(shouldUsePlatformAsr(raw), true);
});

// ── resolveSTTConfig 与开关解耦 ───────────────────────────

console.log('\n=== resolveSTTConfig（asrFallback 已移入独立读取） ===');

await test('框架探测级（tools.media.audio）无 qqbot.stt → STT 解析成功，开关默认 false', () => {
  const raw = {
    tools: { media: { audio: { models: [{ baseUrl: 'https://api.example.com', apiKey: 'k', model: 'whisper-1' }] } } },
  };
  const cfg = resolveSTTConfig(raw)!;
  assert.ok(cfg);
  assert.equal('asrFallback' in cfg, false);
  assert.equal(shouldUsePlatformAsr(raw), false);
});

await test('框架探测级凭证 + qqbot.stt.asrFallback: true → 开关从 qqbot.stt 读取', () => {
  const raw = {
    channels: { qqbot: { stt: { asrFallback: true } } },
    tools: { media: { audio: { models: [{ baseUrl: 'https://api.example.com', apiKey: 'k' }] } } },
  };
  assert.ok(resolveSTTConfig(raw));
  assert.equal(shouldUsePlatformAsr(raw), true);
});

await test('stt.enabled: false → STT 关闭，默认丢弃平台转写', () => {
  const raw = {
    channels: { qqbot: { stt: { enabled: false, baseUrl: 'https://api.example.com', apiKey: 'k' } } },
    tools: { media: { audio: { models: [{ baseUrl: 'https://api.example.com', apiKey: 'k' }] } } },
  };
  assert.equal(resolveSTTConfig(raw), null);
  assert.equal(shouldUsePlatformAsr(raw), false);
});

// ── processAttachments 集成链路 ───────────────────────────

console.log('\n=== processAttachments 集成链路 ===');

const voiceAtt = {
  content_type: 'voice',
  url: '//qqbot.ugcimg.cn/uservoice/demo.wav',
  voice_wav_url: '//qqbot.ugcimg.cn/uservoice/demo.wav',
  asr_refer_text: '平台转写文本',
} as never;

await test('STT 未配置 + 平台转写存在 → 占位文本、asrReferText 丢弃', async () => {
  const result = await processAttachments([voiceAtt], {}, undefined);
  const t = result.transcripts[0]!;
  assert.equal(t.source, 'fallback');
  assert.equal(t.text, '[Voice message - transcription unavailable]');
  assert.equal(t.asrReferText, undefined);
  assert.ok(result.voiceText.includes('transcription unavailable'));
});

await test('STT 未配置 + asrFallback: true → 平台转写保留', async () => {
  const result = await processAttachments(
    [voiceAtt],
    { channels: { qqbot: { stt: { asrFallback: true } } } },
    undefined,
  );
  const t = result.transcripts[0]!;
  assert.equal(t.source, 'asr');
  assert.equal(t.text, '平台转写文本');
  assert.equal(t.asrReferText, '平台转写文本');
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

await test('严格模式（stt 成功、不携带 asrReferText）→ 无 - ASR: 行', () => {
  const body = buildAgentBody([
    { text: '自有转写结果', source: 'stt', localPath: '/tmp/v.wav' },
  ]);
  assert.ok(!body.includes('- ASR:'), `不应包含 - ASR: 行，实际: ${body}`);
});

await test('旧行为（asrFallback: true，携带 asrReferText）→ - ASR: 行保留平台文本', () => {
  const body = buildAgentBody([
    { text: '自有转写结果', source: 'stt', localPath: '/tmp/v.wav', asrReferText: '平台转写文本' },
  ]);
  assert.ok(body.includes('- ASR: 平台转写文本'));
});

await test('严格模式 STT 失败（fallback、无 asrReferText）→ 占位文本且无 - ASR: 行', () => {
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

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
