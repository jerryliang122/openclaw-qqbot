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

interface GroupCoalescerState {
  busy: boolean;
  activeCtx?: MiddlewareContext;
  buffer: MiddlewareContext[];
  resolve?: () => void;
}

const groupCoalescers = new Map<string, GroupCoalescerState>();

const DEFAULT_MAX_BUFFER_SIZE = 50;

export interface GroupCoalescerOptions {
  /**
   * 最大缓冲消息数，默认 50
   */
  maxBuffer?: number;

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
  const { maxBuffer = DEFAULT_MAX_BUFFER_SIZE, onCoalesce, onBufferFull } = options;

  return async (ctx, next) => {
    const msg = ctx.message;

    // 只处理群聊消息
    if (msg.kind !== 'group') {
      await next();
      return;
    }

    const groupKey = `group:${msg.groupOpenid}`;
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
      } finally {
        // 当前消息处理完成，检查是否有缓冲的消息
        state.busy = false;
        state.activeCtx = undefined;

        if (state.buffer.length > 0) {
          // 合并缓冲的消息（包含当前刚完成的消息）
          const buffered = state.buffer.splice(0);
          
          // 标记所有缓冲消息为已处理
          for (const bufferedCtx of buffered) {
            bufferedCtx.state.coalesced = true;
          }
          
          // 选择 survivor 并合并
          const survivor = onCoalesce(buffered);
          
          // 清除 assembledBody，让下游重新构建
          delete survivor.state.assembledBody;
          
          // 标记为 survivor
          survivor.state.isSurvivor = true;
          
          // 解析 resolve，让 survivor 继续处理
          if (state.resolve) {
            state.resolve();
            state.resolve = undefined;
          }
        }

        // 清理状态
        if (state.buffer.length === 0) {
          groupCoalescers.delete(groupKey);
        }
      }
      return;
    }

    // 有正在处理的消息 → 缓冲当前消息
    if (state.buffer.length >= maxBuffer) {
      ctx.log.debug?.(`[coalescer] buffer full (${maxBuffer}), drop for ${groupKey}`);
      await onBufferFull?.(ctx);
      ctx.stop('coalescer:buffer-full');
      return;
    }

    ctx.log.debug?.(
      `[coalescer] buffered: ${groupKey} (msgId=${ctx.message.messageId} pos=${state.buffer.length + 1})`,
    );

    state.buffer.push(ctx);

    // 等待当前任务完成
    await new Promise<void>((resolve) => {
      state!.resolve = resolve;
    });

    // 不是 survivor，直接返回
    if (!ctx.state.isSurvivor) {
      return;
    }

    // survivor 继续处理
    await next();
  };
}

/**
 * 清理所有群聊合并状态（用于测试或重置）
 */
export function clearAllCoalescers(): void {
  groupCoalescers.clear();
}

/**
 * 获取指定群的合并状态（用于调试）
 */
export function getCoalescerState(groupOpenid: string): GroupCoalescerState | undefined {
  return groupCoalescers.get(`group:${groupOpenid}`);
}
