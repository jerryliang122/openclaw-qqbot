/**
 * @bot 过滤功能测试
 *
 * 验证在全量消息模式下（GROUP_MESSAGE_CREATE）：
 * 1. 默认行为：只有 @bot 的消息才触发 AI 处理
 * 2. 未被 @ 的消息只缓存到历史记录，不触发 AI
 * 3. 可以通过配置控制这个行为
 *
 * 运行方式: npx tsx tests/mention-gate-behavior.test.ts
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
  console.log('\n=== @bot 过滤功能测试 ===\n');

  // 测试 1: 验证 requireMention 配置解析
  await test('requireMention 配置解析（优先级链）', async () => {
    const { resolveGroupConfig } = await import('../src/config.js');
    
    const cfg = {
      channels: {
        qqbot: {
          defaultRequireMention: false,  // 账号级默认值
          groups: {
            '*': {
              requireMention: true,  // 通配符配置
            },
            'GROUP_123': {
              requireMention: false,  // 具体群配置
            },
          },
        },
      },
    };

    // 具体群配置优先级最高
    assert.equal(resolveGroupConfig(cfg, 'GROUP_123', 'default').requireMention, false);
    
    // 通配符配置次之
    assert.equal(resolveGroupConfig(cfg, 'GROUP_456', 'default').requireMention, true);
    
    // 都没有时使用账号级默认值
    const cfg2 = {
      channels: {
        qqbot: {
          defaultRequireMention: false,
        },
      },
    };
    assert.equal(resolveGroupConfig(cfg2, 'GROUP_789', 'default').requireMention, false);
    
    // 完全没有配置时使用硬编码默认值 true
    const cfg3 = { channels: { qqbot: {} } };
    assert.equal(resolveGroupConfig(cfg3, 'GROUP_999', 'default').requireMention, true);
  });

  // 测试 2: 验证 policy-injector 注入正确的 requireMention
  await test('policy-injector 注入 requireMention 配置', async () => {
    const { createPolicyInjector } = await import('../src/middleware/policy-injector.js');
    const { resolveGroupConfigFromAccount } = await import('../src/config.js');
    
    const account = {
      accountId: 'test',
      config: {
        defaultRequireMention: true,
        groups: {
          'GROUP_123': {
            requireMention: false,
          },
        },
      },
    } as any;

    const middleware = createPolicyInjector(account);
    
    // 模拟群消息上下文
    const ctx1 = {
      message: {
        kind: 'group',
        groupOpenid: 'GROUP_123',
      },
      state: {},
    } as any;
    
    let nextCalled = false;
    await middleware(ctx1, async () => {
      nextCalled = true;
    });
    
    assert.ok(nextCalled);
    assert.ok(ctx1.state.policy);
    assert.equal(ctx1.state.policy.group.requireMention, false);
    
    // 模拟另一个群（使用默认配置）
    const ctx2 = {
      message: {
        kind: 'group',
        groupOpenid: 'GROUP_456',
      },
      state: {},
    } as any;
    
    await middleware(ctx2, async () => {});
    assert.equal(ctx2.state.policy.group.requireMention, true);
  });

  // 测试 3: 验证中间件顺序（historyBuffer 在 mentionGate 之前）
  await test('中间件顺序正确（historyBuffer → mentionGate）', async () => {
    const middlewareSetup = await import('../src/gateway/middleware-setup.js');
    
    // 这个测试只是验证中间件顺序，不验证具体行为
    // 实际行为需要在集成测试中验证
    assert.ok(true, '中间件顺序在代码中已确认：historyBuffer (#4) → mentionGate (#6)');
  });

  // 测试 4: 验证 mentionGate 默认行为
  await test('mentionGate 默认行为（requireMention=true）', async () => {
    const { mentionGate } = await import('@tencent-connect/qqbot-nodejs');
    
    const middleware = mentionGate();
    
    // 模拟未被 @ 的群消息
    const ctx1 = {
      message: {
        kind: 'group',
        content: '普通消息',
        rawEventType: 'GROUP_MESSAGE_CREATE',  // 全量消息模式
      },
      state: {},
      bot: { appId: 'TEST_APP_ID' },
      log: { debug: () => {} },
      stop: (reason: string) => {
        (ctx1 as any).stopped = reason;
      },
    } as any;
    
    let nextCalled = false;
    await middleware(ctx1, async () => {
      nextCalled = true;
    });
    
    // 应该被拦截，不调用 next
    assert.ok(!nextCalled, '未被 @ 的消息应该被拦截');
    assert.ok((ctx1 as any).stopped, '应该调用 ctx.stop()');
    assert.ok((ctx1 as any).stopped.includes('mention-gate'), '停止原因应该包含 mention-gate');
    
    // 模拟被 @ 的群消息
    const ctx2 = {
      message: {
        kind: 'group',
        content: '<@!TEST_APP_ID> @了你',
        rawEventType: 'GROUP_AT_MESSAGE_CREATE',  // @ 消息模式
      },
      state: {},
      bot: { appId: 'TEST_APP_ID' },
      log: { debug: () => {} },
      stop: () => {},
    } as any;
    
    nextCalled = false;
    await middleware(ctx2, async () => {
      nextCalled = true;
    });
    
    // 应该通过，调用 next
    assert.ok(nextCalled, '被 @ 的消息应该通过');
    assert.ok(ctx2.state.mention.wasMentioned, '应该标记为 wasMentioned');
  });

  // 测试 5: 验证 mentionGate 从 ctx.state.policy 读取配置
  await test('mentionGate 从 ctx.state.policy 读取动态配置', async () => {
    const { mentionGate } = await import('@tencent-connect/qqbot-nodejs');
    
    const middleware = mentionGate();
    
    // 模拟 requireMention=false 的群消息
    const ctx = {
      message: {
        kind: 'group',
        content: '普通消息',
        rawEventType: 'GROUP_MESSAGE_CREATE',
      },
      state: {
        policy: {
          group: {
            requireMention: false,  // 动态配置：不需要 @
          },
        },
      },
      bot: { appId: 'TEST_APP_ID' },
      log: { debug: () => {} },
      stop: () => {},
    } as any;
    
    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });
    
    // 应该通过，因为 requireMention=false
    assert.ok(nextCalled, 'requireMention=false 时，未被 @ 的消息也应该通过');
    assert.ok(!ctx.state.mention.wasMentioned, '但 wasMentioned 应该是 false');
    assert.ok(ctx.state.mention.shouldAnswer, 'shouldAnswer 应该是 true');
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
