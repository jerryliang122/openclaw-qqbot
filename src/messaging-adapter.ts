/**
 * QQBot Messaging 适配器
 *
 * 处理目标解析、会话路由
 */

import { normalizeTarget, isQQBotTarget } from './outbound/target.js';

/**
 * 解析 QQBot 目标
 */
function parseQQBotTarget(target: string): { scope: 'c2c' | 'group'; peerId: string } | null {
  const parts = target.split(':');
  if (parts.length < 3 || parts[0] !== 'qqbot') {
    return null;
  }

  const scope = parts[1];
  const peerId = parts[2];

  if (scope !== 'c2c' && scope !== 'group') {
    return null;
  }

  return { scope, peerId };
}

/**
 * 解析会话对话
 */
function resolveQQBotInboundConversation(params: {
  to?: string;
  conversationId?: string;
  threadId?: string | number;
}): { conversationId: string; parentConversationId: string } | null {
  const rawTarget = params.to || params.conversationId || '';
  if (!rawTarget) {
    return null;
  }

  const parsed = parseQQBotTarget(rawTarget);
  if (!parsed) {
    return null;
  }

  return {
    conversationId: parsed.peerId,
    parentConversationId: parsed.peerId,
  };
}

/**
 * 解析投递目标
 */
function resolveQQBotDeliveryTarget(params: {
  conversationId: string;
  parentConversationId?: string;
}): { to: string } | null {
  const parsed = parseQQBotTarget(params.parentConversationId || params.conversationId);
  if (!parsed) {
    return null;
  }

  return {
    to: `qqbot:${parsed.scope}:${parsed.peerId}`,
  };
}

/**
 * QQBot Messaging Adapter
 */
export const qqbotMessagingAdapter = {
  targetPrefixes: ['qqbot'],
  normalizeTarget: (target: string) => normalizeTarget(target),
  resolveInboundConversation: resolveQQBotInboundConversation,
  resolveDeliveryTarget: resolveQQBotDeliveryTarget,
  targetResolver: {
    looksLikeId: isQQBotTarget,
    hint: 'QQ Bot 目标格式: qqbot:c2c:openid (私聊) 或 qqbot:group:groupid (群聊)',
  },
};
