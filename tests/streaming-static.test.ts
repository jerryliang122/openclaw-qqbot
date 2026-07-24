/**
 * StreamingController 静态下发通道 (sendMode: 'static') 测试
 *
 * 验证：partial 接收逻辑保持不变，仅把文本下发通道从 QQ 流式打印机
 * (openStream/session.update/session.complete) 替换为流结束时一条普通 sendText。
 *
 * 同时对 stream 模式做最小回归，确保默认行为不变。
 *
 * 运行方式:  npx tsx tests/streaming-static.test.ts
 */

import assert from "node:assert";

// ============ Mock 记录 ============

/** 记录流式 API 调用：openStream 次数、update 内容、complete 次数 */
let openStreamCalls = 0;
let streamUpdates: string[] = [];
let streamCompletes = 0;

/** 记录 sendStatic 调用 */
let staticSendCalls: string[] = [];

function resetMocks(): void {
  openStreamCalls = 0;
  streamUpdates = [];
  streamCompletes = 0;
  staticSendCalls = [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等待 controller 串行队列消费完 */
async function flush(): Promise<void> {
  await sleep(20);
}

// ============ Mock gateway / session ============

function createMockGateway() {
  return {
    openStream() {
      openStreamCalls++;
      return {
        update: async (text: string) => {
          streamUpdates.push(text);
        },
        complete: async () => {
          streamCompletes++;
          return { id: "stream-done", timestamp: Date.now() };
        },
      };
    },
  };
}

// ============ Controller 工厂 ============

const { StreamingController } = await import("../src/outbound/streaming-controller.ts");
type Ctrl = InstanceType<typeof StreamingController>;

const logs: string[] = [];

interface MakeOpts {
  sendMode?: "stream" | "static";
  sendStatic?: (text: string) => Promise<void>;
}

function makeController(opts: MakeOpts = {}): Ctrl {
  logs.length = 0;
  const gateway = createMockGateway() as any;
  return new StreamingController({
    gateway,
    target: { scope: "c2c", targetId: "user-1", msgId: "msg-1" },
    accountId: "test",
    replyToId: "msg-1",
    log: {
      info: (m: string) => logs.push(`[INFO] ${m}`),
      error: (m: string) => logs.push(`[ERROR] ${m}`),
      warn: (m: string) => logs.push(`[WARN] ${m}`),
      debug: () => {},
    },
    sendMode: opts.sendMode,
    sendStatic: opts.sendStatic ?? (async (text: string) => { staticSendCalls.push(text); }),
  });
}

// ============ 测试框架 ============

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  resetMocks();
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    const relevant = logs.filter((l) => !l.includes("[DEBUG]")).slice(-8);
    if (relevant.length) {
      console.log(`     --- 日志 ---`);
      for (const l of relevant) console.log(`       ${l}`);
    }
    failed++;
    failedTests.push(name);
  }
}

// ============ 静态模式测试 ============

console.log("\n=== 1. 静态模式 (sendMode: 'static') ===");

await test("静态: 多次 partial 仅累积，不调用 openStream", async () => {
  const ctrl = makeController({ sendMode: "static" });

  await ctrl.onPartialReply("你好");
  await flush();
  await ctrl.onPartialReply("你好世界");
  await flush();
  await ctrl.onPartialReply("你好世界，这是测试");

  assert.strictEqual(openStreamCalls, 0, "静态模式不应打开流式会话");
  assert.strictEqual(streamUpdates.length, 0, "静态模式不应调用 session.update");
  assert.strictEqual(staticSendCalls.length, 0, "累积阶段不应调用 sendStatic");
  assert.strictEqual(ctrl.hasStarted, true, "hasStarted 应为 true");
  assert.strictEqual(ctrl.hasSentChunks, true, "hasSentChunks 应为 true");
});

await test("静态: finalize 时一次性发送累积的完整文本", async () => {
  const ctrl = makeController({ sendMode: "static" });

  await ctrl.onPartialReply("你好");
  await flush();
  await ctrl.onPartialReply("你好世界");
  await flush();
  await ctrl.finalize();

  assert.strictEqual(staticSendCalls.length, 1, "应仅发送 1 条普通消息");
  assert.strictEqual(staticSendCalls[0], "你好世界", "内容应为最后一次累积的全量文本");
  assert.strictEqual(openStreamCalls, 0, "不应调用任何流式 API");
  assert.strictEqual(ctrl.currentPhase, "done", "终态应为 done");
  assert.strictEqual(ctrl.shouldFallbackToStatic, false, "不应触发降级");
});

await test("静态: 空文本不发送内容，0 分片触发降级", async () => {
  const ctrl = makeController({ sendMode: "static" });

  await ctrl.onPartialReply("");
  await ctrl.onPartialReply("");
  await flush();
  await ctrl.finalize();

  assert.strictEqual(staticSendCalls.length, 0, "空文本不应发送");
  assert.strictEqual(ctrl.hasSentChunks, false, "空文本不应产生分片");
  assert.strictEqual(ctrl.shouldFallbackToStatic, true, "0 分片应触发降级兜底");
});

await test("静态: onAssistantMessageStart 第一段开始时无内容可 flush（空跳过）", async () => {
  const ctrl = makeController({ sendMode: "static" });

  // 第一段开始时框架回调 onAssistantMessageStart，但尚未累积任何文本
  await ctrl.flushSegment();
  await flush();
  assert.strictEqual(staticSendCalls.length, 0, "第一段开始无累积内容，不应发送");
  assert.strictEqual(ctrl.currentPhase, "idle", "应为 idle 态，等待首个 partial");
});

await test("静态: onAssistantMessageStart 触发分段 — 旧文本立即发，不进终态", async () => {
  const ctrl = makeController({ sendMode: "static" });

  // 段A 累积（模拟 onPartialReply 持续增长）
  await ctrl.onPartialReply("正在查询您的邮件");
  await flush();
  await ctrl.onPartialReply("正在查询您的邮件，请稍候");
  await flush();
  assert.strictEqual(staticSendCalls.length, 0, "累积阶段不应发送");
  assert.strictEqual(ctrl.isTerminal, false, "累积阶段应为非终态");

  // 工具调用后，框架回调 onAssistantMessageStart → flushSegment 发出段A
  await ctrl.flushSegment();
  await flush();
  assert.deepStrictEqual(staticSendCalls, ["正在查询您的邮件，请稍候"], "段A 应在 flushSegment 时立即发送");
  assert.strictEqual(ctrl.isTerminal, false, "flushSegment 后应保持非终态，可继续累积新段");

  // 段B 累积（新一段，从短重新开始）
  await ctrl.onPartialReply("查到3封邮件");
  await flush();
  assert.strictEqual(staticSendCalls.length, 1, "段B 累积阶段不应额外发送");

  // 兜底 finalize 发最后一段
  await ctrl.finalize();
  assert.deepStrictEqual(staticSendCalls, ["正在查询您的邮件，请稍候", "查到3封邮件"], "最后一段应在 finalize 发送");
  assert.strictEqual(ctrl.currentPhase, "done", "finalize 后应为 done");
});

await test("静态: 多工具调用多段推理 — onAssistantMessageStart 驱动逐段即时发送", async () => {
  const ctrl = makeController({ sendMode: "static" });

  // 精确模拟用户报告的真实场景：
  //   用户问题 → 中途文本A(推理) → 工具调用 → 中途文本B(推理) → 工具调用 → 最终回复C
  // 框架回调顺序（对齐 OpenClaw embedded-agent-subscribe.handlers.messages.ts）：
  //   onAssistantMessageStart(段A开始) → onPartialReply(A...) → onAssistantMessageStart(段B开始,工具后)
  //   → onPartialReply(B...) → onAssistantMessageStart(段C开始,工具后) → onPartialReply(C...) → final

  // 段A：第一段开始 + 累积
  await ctrl.flushSegment(); // 段A 开始（无内容，空跳过）
  await ctrl.onPartialReply("中途文本A");
  await flush();

  // 段B：工具调用后新一段开始 → flushSegment 立即发段A
  await ctrl.flushSegment();
  await flush();
  await ctrl.onPartialReply("中途文本B");
  await flush();

  // 段C：又一次工具调用后 → flushSegment 立即发段B
  await ctrl.flushSegment();
  await flush();
  await ctrl.onPartialReply("最终回复C");
  await flush();

  // turn 结束兜底 finalize 发段C
  await ctrl.finalize();

  // 关键断言：逐段即时，顺序严格，无粘连
  assert.deepStrictEqual(
    staticSendCalls,
    ["中途文本A", "中途文本B", "最终回复C"],
    "应按段顺序逐条发送：A在B开始时发，B在C开始时发，C在兜底finalize发",
  );
  assert.strictEqual(ctrl.currentPhase, "done", "最终应为 done");
  assert.strictEqual(openStreamCalls, 0, "静态模式全程不应调用 openStream");
});

await test("静态: 两段长度相等不粘连（启发式缺陷已修复）", async () => {
  const ctrl = makeController({ sendMode: "static" });

  // 此前靠"文本长度回退"启发式时，两段长度相等（如"中途文本2"→"中途文本3"）
  // 会被误判为"模型重写尾部"而追加成"中途文本23"。改用 onAssistantMessageStart
  // 后，分段由框架明确信号驱动，不再依赖长度启发式。
  await ctrl.onPartialReply("中途文本2");
  await flush();
  // 工具调用后框架回调 onAssistantMessageStart → 正确分段
  await ctrl.flushSegment();
  await flush();
  await ctrl.onPartialReply("中途文本3");
  await flush();
  await ctrl.finalize();

  assert.deepStrictEqual(
    staticSendCalls,
    ["中途文本2", "中途文本3"],
    "两段长度相等也能正确分段，不粘连",
  );
});

await test("静态: abort 时不发送文本", async () => {
  const ctrl = makeController({ sendMode: "static" });

  await ctrl.onPartialReply("正在生成…");
  await flush();
  await ctrl.abort("user_cancel");

  assert.strictEqual(staticSendCalls.length, 0, "abort 不应发送文本");
  assert.strictEqual(ctrl.currentPhase, "failed", "abort 后应为 failed");
});

await test("静态: sendStatic 抛错 → 标记 failed", async () => {
  const ctrl = makeController({
    sendMode: "static",
    sendStatic: async () => { throw new Error("send error"); },
  });

  await ctrl.onPartialReply("内容");
  await flush();
  await ctrl.finalize();

  assert.strictEqual(ctrl.currentPhase, "failed", "sendStatic 失败应标记 failed");
});

// ============ Stream 模式回归（默认行为不变） ============

console.log("\n=== 2. Stream 模式回归（默认行为） ===");

await test("stream: 多次 partial → openStream + update，finalize complete", async () => {
  const ctrl = makeController({ sendMode: "stream" });

  await ctrl.onPartialReply("你好");
  await flush();
  await ctrl.onPartialReply("你好世界");
  await flush();
  await ctrl.finalize();

  assert.strictEqual(openStreamCalls, 1, "stream 模式应打开 1 个流式会话");
  assert.ok(streamUpdates.length >= 2, `应至少 2 次 update，实际 ${streamUpdates.length}`);
  assert.strictEqual(streamCompletes, 1, "finalize 应 complete 一次");
  assert.strictEqual(staticSendCalls.length, 0, "stream 模式不应调用 sendStatic");
  assert.strictEqual(ctrl.currentPhase, "done", "终态应为 done");
});

await test("默认（无 sendMode）= stream 行为，向后兼容", async () => {
  const ctrl = makeController(); // 不传 sendMode

  await ctrl.onPartialReply("hi");
  await flush();
  await ctrl.finalize();

  assert.strictEqual(openStreamCalls, 1, "默认应为 stream 模式");
  assert.strictEqual(staticSendCalls.length, 0, "默认不应走静态");
});

// ============ 汇总 ============

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
if (failed > 0) {
  console.log("失败用例:");
  for (const t of failedTests) console.log(`  - ${t}`);
  process.exit(1);
}
