/**
 * 审批卡片点击 → resolveApprovalOverGateway 调用参数回归测试
 *
 * 2026-09-09 事故：openclaw 2026.9.x 的 resolveApprovalOverGateway 对带身份的
 * 解析请求强制 channel/accountId/senderId 三元组齐全 —— 只传 senderId 时 SDK
 * 在任何网络请求之前直接抛
 * "channel approval resolution requires channel, account, and sender identity"，
 * 异常被 handleApproval 的 catch 吞掉只记日志，决议从未到达框架，审批卡死到
 * 超时。本测试用 loader 钩子拦截 SDK 动态导入，断言点击后实际发出的参数形状。
 *
 * 运行方式: npx tsx tests/approval-resolve.test.ts
 */
import { strict as assert } from 'node:assert';
import { register } from 'node:module';

// 真实 SDK：静态 import 在 register 之前求值，拿到的是未被拦截的原始模块
// （框架内 approval-gateway-resolver 的负向校验在网关连接之前完成，不发网络请求）
import { resolveApprovalOverGateway as realResolveApprovalOverGateway } from 'openclaw/plugin-sdk/approval-gateway-runtime';

register('./approval-resolve-mock.mjs', import.meta.url);

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed += 1;
    failedTests.push(name);
    console.error(`  ❌ ${name}`);
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 测试脚手架 ──

interface CapturedCall {
  cfg?: unknown;
  approvalId?: string;
  approvalKind?: string;
  decision?: string;
  channel?: string;
  accountId?: string;
  senderId?: string;
  clientDisplayName?: string;
}

let captured: CapturedCall[] = [];
(globalThis as Record<string, unknown>).__mockResolveApprovalOverGateway = async (params: CapturedCall) => {
  captured.push(params);
  return { applied: true };
};

const { handleInteraction } = await import('../src/gateway/event-handlers.js');

function fakeLogger() {
  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => log,
  };
  return log as never;
}

function makeEvent(buttonData: string, operatorOpenid = 'OP1') {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    data: { type: 1, resolved: { button_data: buttonData, user_id: operatorOpenid } },
    user_openid: operatorOpenid,
  } as never;
}

async function clickApprovalButton(buttonData: string, cfg: Record<string, unknown> = {}): Promise<CapturedCall[]> {
  captured = [];
  const runtime = { getConfig: () => cfg } as never;
  const account = { accountId: 'default', config: {}, enabled: true } as never;
  let ackCount = 0;
  await handleInteraction(
    makeEvent(buttonData),
    account,
    runtime,
    fakeLogger(),
    async () => {
      ackCount += 1;
    },
  );
  assert.equal(ackCount, 1, 'interaction must be acked exactly once');
  return captured;
}

const EXEC_APPROVAL_ID = 'exec:01923abc-def0-7000-8000-abcdef012345';
const SYSTEM_AGENT_APPROVAL_ID = 'system-agent:01923abc-def0-7000-8000-abcdef012345';

// ── 断言点击 → 框架解析请求的参数形状 ──

console.log('\n=== 1. exec 审批按钮点击 → resolveApprovalOverGateway 参数 ===');

await test('exec allow-once 携带完整 reviewer 身份三元组（channel+accountId+senderId）', async () => {
  const calls = await clickApprovalButton(
    `approve:v2:exec:${encodeURIComponent(EXEC_APPROVAL_ID)}:allow-once`,
  );
  assert.equal(calls.length, 1, 'resolveApprovalOverGateway must be called exactly once');
  const [call] = calls;
  assert.equal(call.approvalId, EXEC_APPROVAL_ID);
  assert.equal(call.approvalKind, 'exec');
  assert.equal(call.decision, 'allow-once');
  assert.equal(call.channel, 'qqbot', 'channel is required alongside senderId (SDK 2026.9+ identity triple)');
  assert.equal(call.accountId, 'default');
  assert.equal(call.senderId, 'OP1');
});

await test('system-agent deny 按钮同样携带身份三元组且 kind 正确透传', async () => {
  const calls = await clickApprovalButton(
    `approve:v2:system-agent:${encodeURIComponent(SYSTEM_AGENT_APPROVAL_ID)}:deny`,
  );
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.approvalKind, 'system-agent');
  assert.equal(call.decision, 'deny');
  assert.equal(call.channel, 'qqbot');
  assert.equal(call.accountId, 'default');
  assert.equal(call.senderId, 'OP1');
});

console.log('\n=== 2. 授权门（allowFrom）仍在插件侧前置拦截 ===');

await test('allowFrom 白名单外的操作者：不调用框架解析', async () => {
  const calls = await clickApprovalButton(
    `approve:v2:exec:${encodeURIComponent(EXEC_APPROVAL_ID)}:allow-once`,
    { channels: { qqbot: { appId: 'app1', secretSource: 'config', allowFrom: ['OTHERUSER'] } } },
  );
  assert.equal(calls.length, 0, 'unauthorized operator must not reach resolveApprovalOverGateway');
});

console.log('\n=== 3. SDK 契约（真实 approval-gateway-runtime，钉住三元组强校验的存在性）===');

await test('真实 SDK：只传 senderId（事故前的参数形状）在连接前即被拒绝', async () => {
  await assert.rejects(
    () =>
      realResolveApprovalOverGateway({
        cfg: {} as never,
        approvalId: EXEC_APPROVAL_ID,
        approvalKind: 'exec',
        decision: 'allow-once',
        senderId: 'OP1',
        clientDisplayName: 'QQBot Approval Handler',
      } as never),
    (err: Error) => {
      assert.match(err.message, /channel, account, and sender identity/);
      return true;
    },
  );
});

console.log(`\n结果: ${passed} passed, ${failed} failed`);
if (failedTests.length) {
  console.error(`失败用例: ${failedTests.join(', ')}`);
  process.exitCode = 1;
}
