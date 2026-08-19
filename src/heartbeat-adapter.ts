/**
 * QQBot Heartbeat 适配器
 *
 * Typing 指示器
 */

import { startTypingWithRenewal, stopTyping } from './typing-lifecycle.js';
import { inferQQBotScope } from './features/quota-manager.js';

/**
 * QQBot Heartbeat Adapter
 */
export const qqbotHeartbeatAdapter = {
  sendTyping: async (params: {
    cfg: any;
    to: string;
    accountId?: string;
    threadId?: string | number;
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
      sendTyping: async () => {
        return true;
      },
    });
  },
};
