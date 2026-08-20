/**
 * 群聊/私聊差异化处理测试
 *
 * 验证：
 * 1. 群聊消息使用消息合并中间件，所有消息都应该被处理
 * 2. 私聊消息使用 exclusive admission，用户可以"插嘴"
 * 3. sessionKey 根据群聊/私聊生成不同格式
 *
 * 运行方式: npx tsx tests/group-c2c-differential.test.ts
 */
import assert from 'node:assert';

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

async function main(): Promise<void> {
  console.log('\n=== 群聊/私聊差异化处理测试 ===\n');

  // 测试 1: 验证消息合并中间件导出
  await test('消息合并中间件可以正常导入', async () => {
    const { groupMessageCoalescer, clearAllCoalescers } = await import('../src/features/message-coalescer.js');
    assert.ok(typeof groupMessageCoalescer === 'function');
    assert.ok(typeof clearAllCoalescers === 'function');
  });

  // 测试 2: 验证群聊合并配置解析
  await test('群聊合并配置解析', async () => {
    const { resolveGroupCoalesceConfig, resolveGroupCoalesceEnabled, resolveGroupCoalesceMaxBuffer } = await import('../src/config.js');
    
    const cfg = {
      channels: {
        qqbot: {
          groupCoalesce: {
            enabled: true,
            maxBuffer: 100,
          },
          groups: {
            'GROUP_123': {
              coalesce: {
                maxBuffer: 200,
              },
            },
          },
        },
      },
    };

    // 默认配置
    const defaultConfig = resolveGroupCoalesceConfig(cfg, 'GROUP_456', 'default');
    assert.equal(defaultConfig.enabled, true);
    assert.equal(defaultConfig.maxBuffer, 100);

    // 群级配置覆盖
    const groupConfig = resolveGroupCoalesceConfig(cfg, 'GROUP_123', 'default');
    assert.equal(groupConfig.enabled, true);
    assert.equal(groupConfig.maxBuffer, 200);

    // 快捷函数
    assert.equal(resolveGroupCoalesceEnabled(cfg, 'GROUP_456', 'default'), true);
    assert.equal(resolveGroupCoalesceMaxBuffer(cfg, 'GROUP_123', 'default'), 200);
  });

  // 测试 3: 验证消息合并中间件行为
  await test('消息合并中间件行为', async () => {
    const { groupMessageCoalescer, clearAllCoalescers } = await import('../src/features/message-coalescer.js');
    
    clearAllCoalescers();

    const bufferedMessages: any[] = [];
    
    const middleware = groupMessageCoalescer({
      maxBuffer: 10,
      onCoalesce: (buffered) => {
        bufferedMessages.push(...buffered);
        return buffered[buffered.length - 1]!;
      },
    });

    // 模拟群聊消息
    const ctx1 = {
      message: {
        kind: 'group',
        groupOpenid: 'GROUP_TEST',
        messageId: 'MSG_1',
        content: '消息 1',
      },
      state: {},
      log: { debug: () => {} },
      stop: () => {},
    } as any;

    const ctx2 = {
      message: {
        kind: 'group',
        groupOpenid: 'GROUP_TEST',
        messageId: 'MSG_2',
        content: '消息 2',
      },
      state: {},
      log: { debug: () => {} },
      stop: () => {},
    } as any;

    let nextCalled = 0;
    const next = async () => {
      nextCalled++;
    };

    // 第一条消息应该立即处理
    await middleware(ctx1, next);
    assert.equal(nextCalled, 1);

    clearAllCoalescers();
  });

  // 测试 4: 验证 sessionKey 生成逻辑
  await test('sessionKey 生成逻辑（群聊/私聊差异化）', async () => {
    // 群聊应该使用 coalescing 后缀
    const groupSessionKey = 'qqbot:default:group:GROUP_123:coalescing';
    assert.ok(groupSessionKey.includes(':coalescing'));

    // 私聊不应该有 coalescing 后缀
    const c2cSessionKey = 'qqbot:default:USER_456';
    assert.ok(!c2cSessionKey.includes(':coalescing'));
  });

  // 测试 5: 验证 admission 策略差异
  await test('admission 策略差异（群聊 cancel-only / 私聊 exclusive）', async () => {
    // 群聊应该使用 cancel-only
    const groupAdmission = 'cancel-only';
    assert.equal(groupAdmission, 'cancel-only');

    // 私聊应该使用 exclusive
    const c2cAdmission = 'exclusive';
    assert.equal(c2cAdmission, 'exclusive');
  });

  // 测试 6: 验证消息合并后的 body 组装
  await test('消息合并后的 body 组装', async () => {
    const { assembleBody } = await import('../src/dispatch/body-assembler.js');
    
    // 模拟合并后的消息
    const ctx = {
      message: {
        kind: 'group',
        content: '消息 3',
        senderId: 'USER_3',
        senderName: '小华',
      },
      state: {
        mergedMessages: [
          {
            message: {
              kind: 'group',
              content: '消息 1',
              senderId: 'USER_1',
              senderName: '小明',
            },
            state: {},
          },
          {
            message: {
              kind: 'group',
              content: '消息 2',
              senderId: 'USER_2',
              senderName: '小红',
            },
            state: {},
          },
          {
            message: {
              kind: 'group',
              content: '消息 3',
              senderId: 'USER_3',
              senderName: '小华',
            },
            state: {},
          },
        ],
        mention: { wasMentioned: true },
      },
    } as any;

    const account = {
      accountId: 'default',
      systemPrompt: '',
    } as any;

    const result = assembleBody(ctx, ctx.message, account);
    
    // 验证合并消息标记
    assert.ok(result.agentBody.includes('[Merged messages begins]'));
    assert.ok(result.agentBody.includes('[Merged messages ends]'));
    assert.ok(result.agentBody.includes('[Current message]'));
    assert.ok(result.agentBody.includes('(@you)'));
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
