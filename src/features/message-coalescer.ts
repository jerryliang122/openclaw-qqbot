/**
 * 群聊消息合并中间件
 *
 * 设计理念：
 * - 群聊：所有消息都应该被处理，快速消息应该被合并
 * - 私聊：用户可以改变主意，新消息取消旧消息
 *
 * 行为：
 * - 如果当前没有正在处理的消息 → 立即开始处理
 * - 如果有正在处理的消息 → 缓冲新消息，等待当前任务完成
 * - 当前任务完成后 → 合并缓冲的消息，一起处理
 *
 * 与私聊的区别：
 * - 群聊使用 coalescing 策略（消息合并）
 * - 私聊使用 exclusive 策略（新消息取消旧消息）
 */
import type { Middleware, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';

interface BufferedMessage {
  ctx: MiddlewareContext;
  next: () => Promise<unknown>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

interface GroupCoalescerState {
  busy: boolean;
  activeCtx?: MiddlewareContext;
  buffer: BufferedMessage[];
}

const groupCoalescers = new Map<string, GroupCoalescerState>();

const DEFAULT_MAX_BUFFER_SIZE = 50;

export interface GroupCoalescerOptions {
  /** 账户 ID；用于隔离不同 bot 下可能重复的 groupOpenid。 */
  accountId?: string;

  /**
   * 最大缓冲消息数，默认 50
   */
  maxBuffer?: number | ((ctx: MiddlewareContext) => number);

  /** 按群动态决定是否启用合并。 */
  isEnabled?: (ctx: MiddlewareContext) => boolean;

  /**
   * 合并回调函数
   * - 接收缓冲的消息列表（包含正在处理的消息）
   * - 返回一个 survivor 作为合并后的消息
   */
  onCoalesce: (buffered: MiddlewareContext[]) => MiddlewareContext;

  /**
   * 缓冲满时的回调
   */
  onBufferFull?: (ctx: MiddlewareContext) => void | Promise<void>;
}

/**
 * 创建群聊消息合并中间件
 */
export function groupMessageCoalescer(options: GroupCoalescerOptions): Middleware {
  const {
    accountId = 'default',
    maxBuffer = DEFAULT_MAX_BUFFER_SIZE,
    isEnabled = () => true,
    onCoalesce,
    onBufferFull,
  } = options;

  return async (ctx, next) => {
    const msg = ctx.message;

    // 只处理群聊消息
    if (msg.kind !== 'group' || !isEnabled(ctx)) {
      await next();
      return;
    }

    const groupKey = `${accountId}:group:${msg.groupOpenid}`;
    let state = groupCoalescers.get(groupKey);

    if (!state) {
      state = { busy: false, buffer: [] };
      groupCoalescers.set(groupKey, state);
    }

    // 如果当前没有正在处理的消息 → 立即开始
    if (!state.busy) {
      state.busy = true;
      state.activeCtx = ctx;

      try {
        await next();
        // 保持 busy=true 逐批排空；处理 survivor 期间到达的消息进入下一批。
        while (state.buffer.length > 0) {
          const batch = state.buffer.splice(0);
          const buffered = batch.map((entry) => entry.ctx);

          try {
            for (const bufferedCtx of buffered) {
              bufferedCtx.state.coalesced = true;
              bufferedCtx.state.mergedMessages = buffered;
            }

            const selected = onCoalesce(buffered);
            const survivorEntry = batch.find((entry) => entry.ctx === selected) ?? batch.at(-1)!;
            const survivor = survivorEntry.ctx;
            delete survivor.state.assembledBody;
            survivor.state.isSurvivor = true;

            await survivorEntry.next();
            for (const entry of batch) entry.resolve();
          } catch (err) {
            for (const entry of batch) entry.reject(err);
            throw err;
          }
        }
      } catch (err) {
        // 当前处理失败时也必须释放所有等待者，不能留下永久挂起的 Promise。
        for (const entry of state.buffer.splice(0)) entry.reject(err);
        throw err;
      } finally {
        state.busy = false;
        state.activeCtx = undefined;
        if (groupCoalescers.get(groupKey) === state) groupCoalescers.delete(groupKey);
      }
      return;
    }

    // 有正在处理的消息 → 缓冲当前消息
    const resolvedMaxBuffer = Math.max(
      0,
      Math.floor(typeof maxBuffer === 'function' ? maxBuffer(ctx) : maxBuffer),
    );
    if (state.buffer.length >= resolvedMaxBuffer) {
      ctx.log.debug?.(`[coalescer] buffer full (${resolvedMaxBuffer}), drop for ${groupKey}`);
      await onBufferFull?.(ctx);
      ctx.stop('coalescer:buffer-full');
      return;
    }

    ctx.log.debug?.(
      `[coalescer] buffered: ${groupKey} (msgId=${ctx.message.messageId} pos=${state.buffer.length + 1})`,
    );

    // 每条消息保存独立 resolver；worker 会调用 survivor 的 next 并释放整批。
    await new Promise<void>((resolve, reject) => {
      state!.buffer.push({ ctx, next, resolve, reject });
    });
  };
}

/**
 * 清理所有群聊合并状态（用于测试或重置）
 */
export function clearAllCoalescers(): void {
  for (const state of groupCoalescers.values()) {
    for (const entry of state.buffer.splice(0)) entry.resolve();
  }
  groupCoalescers.clear();
}

/**
 * 获取指定群的合并状态（用于调试）
 */
export function getCoalescerState(groupOpenid: string): GroupCoalescerState | undefined {
  return groupCoalescers.get(`default:group:${groupOpenid}`);
}
