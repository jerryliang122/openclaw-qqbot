/**
 * QQBot Heartbeat 适配器
 *
 * Typing 指示器
 */

import { startTypingWithRenewal, stopTyping } from './typing-lifecycle.js';
import { inferQQBotScope } from './features/quota-manager.js';
import { getGateway } from './outbound/outbound-service.js';
import { parseTarget } from './outbound/target.js';

/**
 * QQBot Heartbeat Adapter
 */
export const qqbotHeartbeatAdapter = {
  sendTyping: async (params: {
    cfg: any;
    to: string;
    accountId?: string | null;
    threadId?: string | number | null;
    replyToId?: string;
  }) => {
    const { to, accountId, replyToId } = params;

    if (!accountId || !replyToId) {
      return;
    }

    const scope = inferQQBotScope(to);
    if (scope !== 'c2c') {
      return;
    }

    await startTypingWithRenewal({
      accountId,
      to,
      replyToId,
      sendTyping: async ({ to, msgId }) => {
        const gw = getGateway(accountId);
        if (!gw) return false;

        const target = parseTarget(to);
        const targetWithMsgId = msgId ? { ...target, msgId } : target;
        try {
          await gw.sendTyping(targetWithMsgId);
          return true;
        } catch {
          return false;
        }
      },
    });
  },
};
