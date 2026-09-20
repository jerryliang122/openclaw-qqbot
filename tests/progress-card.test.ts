/**
 * 进度卡片推送测试（progress_card → QQ）
 *
 * 覆盖：
 * 1. renderProgressCardText：多状态渲染 / 完成·待办折叠 / 截断 / explanation 回退 / 空内容
 * 2. createProgressCardPusher：首推立即、无变化去重、间隔节流、每轮上限、
 *    配额保底（剩余 <2 跳过）、绝不主动、发送失败回滚配额
 * 3. dispatch 接线：replyOptions.onPlanUpdate + suppressDefaultToolProgressMessages
 *    注入条件（c2c 默认开 / enabled:false 关 / 群默认关 / 群级开启 / room_event 不注入）
 *
 * 运行方式: npx tsx tests/progress-card.test.ts
 */
import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

function group(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ✗ ${name}\n    ${msg}`);
    failed++;
    failedTests.push(name);
  }
}

// ── 被测模块（真实实现，不做逻辑复制）──

const {
  renderProgressCardText,
  createProgressCardPusher,
  DEFAULT_PROGRESS_MIN_INTERVAL_MS,
} = await import('../src/features/progress-card.ts');
const {
  clearQuotaCache,
  __test_getQuotaCache,
  checkAndConsumePassiveReplyQuota,
} = await import('../src/features/quota-manager.ts');

// ── 工具 ──

function steps(...entries: Array<[string, 'pending' | 'in_progress' | 'completed']>) {
  return entries.map(([step, status]) => ({ step, status }));
}

function quotaCount(accountId: string, scope: 'c2c' | 'group', msgId: string): number {
  return __test_getQuotaCache().get(`${accountId}:${scope}:${msgId}`)?.count ?? 0;
}

/** 预消耗 n 条配额（模拟 typing/其他回复已占用） */
function preConsume(accountId: string, scope: 'c2c' | 'group', msgId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const r = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope });
    assert.ok(r.canReply, `preConsume 第 ${i + 1} 次应成功`);
  }
}

interface PusherHarness {
  msgId: string;
  sent: string[];
  failures: Array<string | Error>;
  now: () => number;
  advance: (ms: number) => void;
  push: (payload: {
    steps?: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }>;
    explanation?: string;
  }) => Promise<void>;
}

function makePusher(opts: {
  accountId?: string;
  msgId?: string;
  scope?: 'c2c' | 'group';
  failSend?: boolean;
  minIntervalMs?: number;
  maxPerTurn?: number;
} = {}): PusherHarness {
  const accountId = opts.accountId ?? 'acct';
  const msgId = opts.msgId ?? `m-${Math.random().toString(36).slice(2, 8)}`;
  const scope = opts.scope ?? 'c2c';
  const sent: string[] = [];
  const failures: Array<string | Error> = [];
  let t = 1_000_000;

  const pusher = createProgressCardPusher({
    accountId,
    to: scope === 'group' ? `qqbot:group:${msgId}` : `qqbot:c2c:${msgId}`,
    scope,
    replyToId: msgId,
    send: async (text) => {
      if (opts.failSend) {
        failures.push(text);
        throw new Error('QQ API unavailable');
      }
      sent.push(text);
      return {};
    },
    minIntervalMs: opts.minIntervalMs,
    maxPerTurn: opts.maxPerTurn,
    now: () => t,
  });

  return {
    msgId,
    sent,
    failures,
    now: () => t,
    advance: (ms: number) => { t += ms; },
    push: (payload) => pusher.handlePlanUpdate(payload),
  };
}

// ── 1. 渲染 ──

group('渲染: renderProgressCardText');

await test('多状态基本渲染（头部计数 + 状态行序）', () => {
  const text = renderProgressCardText({
    steps: steps(
      ['完成A', 'completed'],
      ['进行B', 'in_progress'],
      ['待办C', 'pending'],
    ),
  });
  assert.equal(text, [
    '📋 进度 1/3',
    '✅ 完成A',
    '🔄 进行B',
    '⬜ 待办C',
  ].join('\n'));
});

await test('完成项 >3 折叠：计数行 + 最近 2 项', () => {
  const text = renderProgressCardText({
    steps: steps(
      ['s1', 'completed'],
      ['s2', 'completed'],
      ['s3', 'completed'],
      ['s4', 'completed'],
      ['s5', 'completed'],
      ['s6', 'pending'],
    ),
  })!;
  const lines = text.split('\n');
  assert.equal(lines[0], '📋 进度 5/6');
  assert.equal(lines[1], '✅ 前面 3 项已完成');
  assert.ok(lines.includes('✅ s4'), '应保留倒数第 2 个完成项');
  assert.ok(lines.includes('✅ s5'), '应保留最后 1 个完成项');
  assert.ok(!lines.includes('✅ s1'), '最早完成项应被折叠');
  assert.ok(lines.includes('⬜ s6'));
});

await test('待办项 >3 折叠：前 3 条 + 计数行', () => {
  const text = renderProgressCardText({
    steps: steps(
      ['p1', 'pending'],
      ['p2', 'pending'],
      ['p3', 'pending'],
      ['p4', 'pending'],
      ['p5', 'pending'],
      ['p6', 'pending'],
    ),
  })!;
  const lines = text.split('\n');
  assert.ok(lines.includes('⬜ p1') && lines.includes('⬜ p3'));
  assert.ok(!lines.includes('⬜ p4'));
  assert.ok(lines.includes('⬜ …另有 3 项待办'));
});

await test('步骤文本超宽截断（约 20 汉字）', () => {
  const long = '这是一个非常非常非常非常非常非常非常长的步骤名称需要被截断处理掉';
  const text = renderProgressCardText({ steps: steps([long, 'in_progress']) })!;
  const line = text.split('\n')[1];
  assert.ok(line.endsWith('…'), `应截断加省略号，实际: ${line}`);
  assert.ok(line.length < long.length + 4);
});

await test('无 steps 有 explanation → 单行解释', () => {
  assert.equal(renderProgressCardText({ explanation: '正在整理思路' }), '📋 正在整理思路');
});

await test('空内容返回 null（卡片清空/空 payload）', () => {
  assert.equal(renderProgressCardText({}), null);
  assert.equal(renderProgressCardText({ steps: [] }), null);
  assert.equal(renderProgressCardText({ steps: [{ step: '   ', status: 'pending' }] }), null);
  assert.equal(renderProgressCardText(undefined as never), null);
});

// ── 2. 推送器 ──

group('推送器: createProgressCardPusher（真实 quota-manager）');

await test('首次建卡立即推送（不受间隔限制）并占 1 条配额', async () => {
  clearQuotaCache();
  const h = makePusher({ accountId: 'p1' });
  await h.push({ steps: steps(['a', 'pending']) });
  assert.equal(h.sent.length, 1, '首推应立即发送');
  assert.ok(h.sent[0].startsWith('📋 进度'));
  assert.equal(quotaCount('p1', 'c2c', h.msgId), 1);
});

await test('渲染无变化 → 静默跳过', async () => {
  clearQuotaCache();
  const h = makePusher({ accountId: 'p2' });
  const payload = { steps: steps(['a', 'pending']) };
  await h.push(payload);
  h.advance(60_000);
  await h.push(payload); // 完全相同
  await h.push({ steps: steps(['a', 'pending']) }); // 新对象同内容
  assert.equal(h.sent.length, 1, '内容无变化不应重复推送');
});

await test('间隔节流：<minIntervalMs 的更新被跳过，超过后放行', async () => {
  clearQuotaCache();
  const h = makePusher({ accountId: 'p3' });
  await h.push({ steps: steps(['a', 'pending']) });
  h.advance(5_000);
  await h.push({ steps: steps(['a', 'completed'], ['b', 'in_progress']) });
  assert.equal(h.sent.length, 1, `间隔 ${DEFAULT_PROGRESS_MIN_INTERVAL_MS}ms 内不推`);
  h.advance(DEFAULT_PROGRESS_MIN_INTERVAL_MS + 1);
  await h.push({ steps: steps(['a', 'completed'], ['b', 'in_progress']) });
  assert.equal(h.sent.length, 2, '超过间隔后状态变化应推送');
});

await test('每轮上限：达到 maxPerTurn 后不再推送', async () => {
  clearQuotaCache();
  const h = makePusher({ accountId: 'p4', maxPerTurn: 2 });
  await h.push({ steps: steps(['a', 'pending']) }); // 1
  h.advance(30_000);
  await h.push({ steps: steps(['a', 'completed']) }); // 2
  h.advance(30_000);
  await h.push({ steps: steps(['b', 'completed']) }); // cap
  h.advance(30_000);
  await h.push({ steps: steps(['c', 'completed']) }); // cap
  assert.equal(h.sent.length, 2, '超过每轮上限后应全部跳过');
});

await test('配额保底：剩余 1 条时跳过且绝不主动发送', async () => {
  clearQuotaCache();
  const msgId = `q-${Math.random().toString(36).slice(2, 8)}`;
  const accountId = 'p5';
  preConsume(accountId, 'c2c', msgId, 3); // 4-3=1 条剩余
  const h = makePusher({ accountId, msgId });
  await h.push({ steps: steps(['a', 'pending']) });
  assert.equal(h.sent.length, 0, '剩余额度不足时应跳过（不发送）');
  assert.equal(quotaCount(accountId, 'c2c', msgId), 3, '跳过时不应额外消耗配额');
});

await test('配额耗尽：跳过', async () => {
  clearQuotaCache();
  const msgId = `q-${Math.random().toString(36).slice(2, 8)}`;
  const accountId = 'p6';
  preConsume(accountId, 'c2c', msgId, 4);
  const h = makePusher({ accountId, msgId });
  await h.push({ steps: steps(['a', 'pending']) });
  assert.equal(h.sent.length, 0);
});

await test('剩余额度充足（=2）时正常推送，消耗后仍留 1 条给最终回复', async () => {
  clearQuotaCache();
  const msgId = `q-${Math.random().toString(36).slice(2, 8)}`;
  const accountId = 'p7';
  preConsume(accountId, 'c2c', msgId, 2); // 剩 2
  const h = makePusher({ accountId, msgId });
  await h.push({ steps: steps(['a', 'pending']) });
  assert.equal(h.sent.length, 1, '剩余 2 条时应允许推送');
  assert.equal(quotaCount(accountId, 'c2c', msgId), 3, '推送后剩 1 条给最终回复');
});

await test('发送抛错 → 回滚配额，后续更新可重试', async () => {
  clearQuotaCache();
  const msgId = `q-${Math.random().toString(36).slice(2, 8)}`;
  const accountId = 'p8';
  const failing = makePusher({ accountId, msgId, failSend: true });
  await failing.push({ steps: steps(['a', 'pending']) });
  assert.equal(quotaCount(accountId, 'c2c', msgId), 0, '发送失败后配额应回滚');

  // 同一 msgId 换正常 pusher，状态变化后可重试（时钟重新从 0 开始，首推路径）
  const ok = makePusher({ accountId, msgId });
  await ok.push({ steps: steps(['a', 'completed']) });
  assert.equal(ok.sent.length, 1, '配额回滚后重试应成功');
});

await test('群 scope：走 group 配额（上限 5），推送正常', async () => {
  clearQuotaCache();
  const msgId = `g-${Math.random().toString(36).slice(2, 8)}`;
  const accountId = 'p9';
  const h = makePusher({ accountId, msgId, scope: 'group' });
  await h.push({ steps: steps(['a', 'pending']) });
  assert.equal(h.sent.length, 1);
  assert.equal(quotaCount(accountId, 'group', msgId), 1);
});

// ── 3. dispatch 接线 ──

group('dispatch 接线: replyOptions 注入条件');

const { dispatchToOpenClaw } = await import('../src/dispatch/dispatch.ts');
const { registerGateway } = await import('../src/outbound/outbound-service.ts');
const { _resetAdaptersCache } = await import('../src/adapter/resolve.ts');

function makeFakeRuntime(dispatchReply: (params: any) => any) {
  return {
    version: 'test',
    channel: {
      inbound: {
        run: async (params: any) => {
          const plan = params.adapter.resolveTurn({}, 'provider_message_sending', {});
          await plan.runDispatch();
          return { dispatched: true };
        },
        buildContext: (params: any) => ({ ...params, __built: true }),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: (params: any) => dispatchReply(params),
      },
      routing: {
        resolveAgentRoute: (params: any) => ({
          sessionKey: `qqbot:test:${params.peer.id}`,
          accountId: params.accountId,
          agentId: 'default',
        }),
      },
      session: {
        resolveStorePath: () => '',
        recordInboundSession: async () => {},
      },
    },
    config: { current: {} },
  } as any;
}

function makeMsgAndCtx(overrides: { scope?: 'group' | 'c2c'; targetId?: string } = {}) {
  const scope = overrides.scope ?? 'c2c';
  const targetId = overrides.targetId ?? 'USER_123';
  const messageId = `msg-${Math.random().toString(36).slice(2, 10)}`;
  const msg = {
    kind: scope === 'group' ? 'group' : 'c2c',
    messageId,
    content: 'hello',
    senderId: 'USER_123',
    senderName: 'Tester',
    attachments: [],
    replyTarget: { scope, targetId },
    timestamp: Date.now(),
  } as any;
  const ctx = { state: {}, message: { content: 'hello' }, signal: undefined } as any;
  return { msg, ctx, messageId };
}

function makeAccount(config: any = {}): any {
  return {
    accountId: 'test-account',
    appId: 'x',
    config: { deliverDebounce: { enabled: false }, streaming: false, ...config },
  };
}

function installFakeGateway() {
  const sentTexts: Array<{ target: any; text: string; opts: any }> = [];
  const gw = {
    sendText: async (target: any, text: string, sendOpts: any) => {
      sentTexts.push({ target, text, opts: sendOpts });
      return { id: `out-${sentTexts.length}` };
    },
    sendMedia: async () => ({ id: 'media-out' }),
  } as any;
  registerGateway('test-account', gw);
  return { sentTexts };
}

const SAMPLE_PLAN = {
  steps: steps(['调研方案A', 'completed'], ['调研方案B', 'in_progress']),
};

await test('c2c 默认：注入 onPlanUpdate + suppressDefaultToolProgressMessages', async () => {
  _resetAdaptersCache();
  clearQuotaCache();
  const { msg, ctx, messageId } = makeMsgAndCtx();
  let replyOptions: any;
  const runtime = makeFakeRuntime((p) => { replyOptions = p.replyOptions; return { queuedFinal: true }; });
  const account = makeAccount();
  const { sentTexts } = installFakeGateway();
  await dispatchToOpenClaw(ctx, msg, account, runtime);

  assert.equal(typeof replyOptions?.onPlanUpdate, 'function', 'onPlanUpdate 应被注入');
  assert.equal(replyOptions?.suppressDefaultToolProgressMessages, true, 'suppress 标志应被注入');

  await replyOptions.onPlanUpdate(SAMPLE_PLAN);
  assert.equal(sentTexts.length, 1, '进度更新应推送到网关');
  assert.ok(sentTexts[0].text.startsWith('📋 进度 1/2'), `渲染头部错误: ${sentTexts[0].text}`);
  assert.equal(sentTexts[0].opts?.msgId ?? sentTexts[0].opts?.msgid, messageId, '应作为被动回复指向触发消息');

  // 渲染无变化 → 不重复推送
  await replyOptions.onPlanUpdate(SAMPLE_PLAN);
  assert.equal(sentTexts.length, 1);
});

await test('progressCard.enabled=false：两个标志均不注入（零行为变化）', async () => {
  _resetAdaptersCache();
  clearQuotaCache();
  const { msg, ctx } = makeMsgAndCtx();
  let replyOptions: any;
  const runtime = makeFakeRuntime((p) => { replyOptions = p.replyOptions; return { queuedFinal: true }; });
  const account = makeAccount({ progressCard: { enabled: false } });
  installFakeGateway();
  await dispatchToOpenClaw(ctx, msg, account, runtime);

  assert.equal(replyOptions?.onPlanUpdate, undefined);
  assert.equal(replyOptions?.suppressDefaultToolProgressMessages, undefined);
});

await test('群聊默认关闭：不注入；群级 progressCard=true：注入并推送', async () => {
  _resetAdaptersCache();
  clearQuotaCache();
  const { msg, ctx, messageId } = makeMsgAndCtx({ scope: 'group', targetId: 'GROUP_X' });

  // 默认关
  let replyOptions: any;
  let runtime = makeFakeRuntime((p) => { replyOptions = p.replyOptions; return { queuedFinal: true }; });
  let account = makeAccount();
  installFakeGateway();
  await dispatchToOpenClaw(ctx, msg, account, runtime);
  assert.equal(replyOptions?.onPlanUpdate, undefined, '群聊默认不应注入进度推送');
  assert.equal(replyOptions?.suppressDefaultToolProgressMessages, undefined);

  // 群级开启
  _resetAdaptersCache();
  clearQuotaCache();
  let replyOptions2: any;
  runtime = makeFakeRuntime((p) => { replyOptions2 = p.replyOptions; return { queuedFinal: true }; });
  account = makeAccount({ groups: { GROUP_X: { progressCard: true } } });
  const { sentTexts } = installFakeGateway();
  await dispatchToOpenClaw(ctx, msg, account, runtime);
  assert.equal(typeof replyOptions2?.onPlanUpdate, 'function', '群级开启后应注入');
  await replyOptions2.onPlanUpdate(SAMPLE_PLAN);
  assert.equal(sentTexts.length, 1, '群级开启后应推送到群');
  assert.equal(sentTexts[0].opts?.msgId ?? sentTexts[0].opts?.msgid, messageId);
});

await test('账号级 progressCard.group=true 也可为群开启', async () => {
  _resetAdaptersCache();
  clearQuotaCache();
  const { msg, ctx } = makeMsgAndCtx({ scope: 'group', targetId: 'GROUP_Y' });
  let replyOptions: any;
  const runtime = makeFakeRuntime((p) => { replyOptions = p.replyOptions; return { queuedFinal: true }; });
  const account = makeAccount({ progressCard: { group: true } });
  installFakeGateway();
  await dispatchToOpenClaw(ctx, msg, account, runtime);
  assert.equal(typeof replyOptions?.onPlanUpdate, 'function');
});

await test('room_event 群（结构性沉默）：不注入进度推送，保持 message_tool_only', async () => {
  _resetAdaptersCache();
  clearQuotaCache();
  const { msg, ctx } = makeMsgAndCtx({ scope: 'group', targetId: 'GROUP_R' });
  let replyOptions: any;
  const runtime = makeFakeRuntime((p) => { replyOptions = p.replyOptions; return { queuedFinal: true }; });
  // 即使群级显式开启进度推送，room_event 也不推
  const account = makeAccount({ groups: { GROUP_R: { unmentionedInbound: 'room_event', progressCard: true } } });
  installFakeGateway();
  await dispatchToOpenClaw(ctx, msg, account, runtime);

  assert.equal(replyOptions?.onPlanUpdate, undefined, 'room_event 群不应注入进度推送');
  assert.equal(replyOptions?.sourceReplyDeliveryMode, 'message_tool_only', 'room_event 投递模式不受影响');
});

// ── 结果 ──

console.log('\n' + '='.repeat(60));
console.log(`测试结果: ${passed} passed, ${failed} failed`);
if (failedTests.length > 0) {
  console.log('\n失败的测试:');
  failedTests.forEach((name) => console.log(`  - ${name}`));
  process.exit(1);
}
console.log('\n✅ 所有测试通过！');
process.exit(0);
