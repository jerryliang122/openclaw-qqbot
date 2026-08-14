/**
 * 出站消息 → typing 续期信号
 *
 * QQ 客户端收到机器人消息后会自动终止"正在输入"显示。若框架任务
 * 仍在进行（如思维链等中间消息），typing 中间件需要在消息发出后
 * 延迟数秒补发一次续期，恢复指示器显示。
 *
 * 本模块提供进程内信号：出站层（QQBotGateway）在消息发送成功后
 * notify，活跃的 typing 会话按 accountId + scope + targetId 订阅。
 * 任务已完成的会话已取消订阅，notify 自然不产生任何效果。
 */

type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();

function key(accountId: string, scope: string, targetId: string): string {
  return `${accountId}:${scope}:${targetId}`;
}

/**
 * 订阅指定会话的出站消息信号。
 * @returns 取消订阅函数
 */
export function subscribeOutboundMessage(
  accountId: string,
  scope: string,
  targetId: string,
  listener: Listener,
): () => void {
  const k = key(accountId, scope, targetId);
  let set = listeners.get(k);
  if (!set) {
    set = new Set();
    listeners.set(k, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(k);
  };
}

/**
 * 消息发送成功后由出站层调用：通知该会话活跃的 typing 会话补发续期。
 */
export function notifyOutboundMessageSent(accountId: string, scope: string, targetId: string): void {
  const set = listeners.get(key(accountId, scope, targetId));
  if (!set) return;
  for (const listener of [...set]) listener();
}
