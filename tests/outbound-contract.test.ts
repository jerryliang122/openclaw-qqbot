/**
 * 框架 outbound 契约回归测试
 *
 * 背景: openclaw 框架在发送链路（message CLI / cron / agent 回复）中通过
 * channel-selection → resolveOutboundChannelPlugin 判定通道可用性，判定条件为:
 *
 *   outbound.sendText (function)
 *   || outbound.deliveryMode === "gateway"
 *   || message.send.text (function)
 *
 * 任一满足才认为通道可发送；否则抛出 "Channel is unavailable: qqbot"。
 * （见 openclaw src/infra/outbound/channel-resolution.ts 的
 * channelPluginHasActivatedOutboundSurface，以及 channel-bootstrap.runtime.ts
 * 的 channelEntryCanSend —— 两处均要求 outbound.sendText 或 message.send.text。）
 *
 * 重构（refactor/channel-plugin-standard）曾把这些框架契约入口替换成内部
 * quota 包装（sendTextWithQuota / sendMediaWithQuota），导致 CLI 发送报
 * "Channel is unavailable: qqbot"。本测试模拟框架的精确判定逻辑防止回归。
 *
 * 运行方式: npx tsx tests/outbound-contract.test.ts
 */

import assert from 'node:assert';
import { qqbotPlugin } from '../src/channel.js';
import { createQQBotChannelOutbound } from '../src/outbound-adapter.js';
import { TEXT_CHUNK_LIMIT } from '../src/constants.js';

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    failedTests.push(name);
    console.error(`✗ ${name}`);
    console.error(err instanceof Error ? err.message : err);
  }
}

// ── 框架判定逻辑的精确复刻（openclaw channel-resolution.ts）──

function resolveSendCapableMessageAdapter(plugin: typeof qqbotPlugin) {
  const message = (plugin as { message?: { send?: { text?: unknown } } }).message;
  return typeof message?.send?.text === 'function' ? message : undefined;
}

function channelPluginHasActivatedOutboundSurface(plugin: typeof qqbotPlugin): boolean {
  const outbound = plugin?.outbound as
    | { sendText?: unknown; deliveryMode?: string }
    | undefined;
  return Boolean(
    outbound?.sendText ||
      outbound?.deliveryMode === 'gateway' ||
      resolveSendCapableMessageAdapter(plugin),
  );
}

function channelEntryCanSend(plugin: typeof qqbotPlugin): boolean {
  const outbound = plugin?.outbound as { sendText?: unknown } | undefined;
  const message = (plugin as { message?: { send?: { text?: unknown } } }).message;
  return Boolean(outbound?.sendText ?? (typeof message?.send?.text === 'function' ? 1 : undefined));
}

async function main() {
  console.log('\n=== Outbound Framework Contract Tests ===\n');

  await test('框架可用性判定: channelPluginHasActivatedOutboundSurface 为 true', () => {
    assert.ok(
      channelPluginHasActivatedOutboundSurface(qqbotPlugin),
      '框架要求 outbound.sendText / deliveryMode==="gateway" / message.send.text 至少满足一个，' +
        '否则 message CLI 报 "Channel is unavailable: qqbot"',
    );
  });

  await test('框架可用性判定: channelEntryCanSend（bootstrap 侧）为 true', () => {
    assert.ok(
      channelEntryCanSend(qqbotPlugin),
      'bootstrapOutboundChannelPlugin 通过 channelEntryCanSend 检查 outbound.sendText',
    );
  });

  await test('outbound.sendText 是框架契约函数', () => {
    assert.strictEqual(typeof qqbotPlugin.outbound?.sendText, 'function');
  });

  await test('outbound.sendMedia 是框架契约函数', () => {
    assert.strictEqual(typeof qqbotPlugin.outbound?.sendMedia, 'function');
  });

  await test('sendText 委托底层服务并透传 replyToId，成功返回 {channel, messageId}', async () => {
    const outbound = createQQBotChannelOutbound({
      sendText: async (params) => {
        assert.strictEqual(params.to, 'qqbot:c2c:user1');
        assert.strictEqual(params.text, 'hello');
        assert.strictEqual(params.replyToId, 'reply-msg-1');
        return { messageId: 'sent-1' };
      },
    });
    const result = await outbound.sendText({
      to: 'qqbot:c2c:user1',
      text: 'hello',
      replyToId: 'reply-msg-1',
      cfg: {},
    });
    assert.strictEqual(result.channel, 'qqbot');
    assert.strictEqual(result.messageId, 'sent-1');
  });

  await test('sendText 底层失败时抛错（框架依赖异常上报失败）', async () => {
    const outbound = createQQBotChannelOutbound({
      sendText: async () => ({ error: 'Bot "default" not running' }),
    });
    await assert.rejects(
      () =>
        outbound.sendText({
          to: 'qqbot:c2c:user1',
          text: 'hello',
          cfg: {},
        }),
      /not running/,
    );
  });

  await test('sendMedia 委托底层服务（mediaUrl→source），成功返回 {channel, messageId}', async () => {
    const outbound = createQQBotChannelOutbound({
      sendMedia: async (params) => {
        assert.strictEqual(params.to, 'qqbot:c2c:user2');
        assert.strictEqual(params.source, 'https://example.com/a.png');
        assert.strictEqual(params.text, 'caption');
        return { messageId: 'media-1' };
      },
    });
    const result = await outbound.sendMedia({
      to: 'qqbot:c2c:user2',
      text: 'caption',
      mediaUrl: 'https://example.com/a.png',
      cfg: {},
    });
    assert.strictEqual(result.channel, 'qqbot');
    assert.strictEqual(result.messageId, 'media-1');
  });

  await test('sendMedia 底层失败时抛错', async () => {
    const outbound = createQQBotChannelOutbound({
      sendMedia: async () => ({ error: 'sendMedia: source is required' }),
    });
    await assert.rejects(
      () =>
        outbound.sendMedia({
          to: 'qqbot:c2c:user2',
          mediaUrl: '',
          cfg: {},
        }),
      /source is required/,
    );
  });

  await test('chunker 存在且不在 GFM 表格内部切分', () => {
    const outbound = qqbotPlugin.outbound as {
      chunker?: (text: string, limit: number) => string[];
    };
    assert.strictEqual(typeof outbound.chunker, 'function');
    const chunker = outbound.chunker!;

    const row = '| a | b |';
    const table = ['| h1 | h2 |', '|---|---|', row, row, row, row].join('\n');
    const text = `${'x'.repeat(40)}\n${table}\n${'y'.repeat(40)}`;
    const chunks = chunker(text, 50);
    for (const chunk of chunks) {
      if (chunk.includes('|---|---|')) {
        assert.ok(chunk.includes('| a | b |'), '表格数据行必须与表头在同一个 chunk');
      }
    }
    assert.strictEqual(chunks.join('\n').length > 0, true);
  });

  await test('chunkerMode 为 markdown，textChunkLimit 为 TEXT_CHUNK_LIMIT', () => {
    const outbound = qqbotPlugin.outbound as {
      chunkerMode?: string;
      textChunkLimit?: number;
    };
    assert.strictEqual(outbound.chunkerMode, 'markdown');
    assert.strictEqual(outbound.textChunkLimit, TEXT_CHUNK_LIMIT);
  });

  await test('sanitizeText 剥离内部脚手架标签', () => {
    const outbound = qqbotPlugin.outbound as {
      sanitizeText?: (params: { text: string }) => string;
    };
    assert.strictEqual(typeof outbound.sanitizeText, 'function');
    const out = outbound.sanitizeText!({
      text: '<system-reminder>hidden</system-reminder>visible',
    });
    assert.strictEqual(out, 'visible');
  });

  await test('shouldSuppressLocalPayloadPrompt 识别审批 payload', () => {
    const outbound = qqbotPlugin.outbound as {
      shouldSuppressLocalPayloadPrompt?: (params: { payload: unknown }) => boolean;
    };
    assert.strictEqual(typeof outbound.shouldSuppressLocalPayloadPrompt, 'function');
    assert.strictEqual(
      outbound.shouldSuppressLocalPayloadPrompt!({
        payload: { text: 'Exec approval required for bash' },
      }),
      true,
    );
    assert.strictEqual(
      outbound.shouldSuppressLocalPayloadPrompt!({ payload: { text: 'plain' } }),
      false,
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`\nFAILED TESTS:\n${failedTests.map((t) => `  - ${t}`).join('\n')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
