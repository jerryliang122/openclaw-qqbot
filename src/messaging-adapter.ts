/**
 * QQBot Messaging 适配器
 *
 * 处理目标解析、会话路由
 */

import { normalizeTarget, isQQBotTarget, tryParseTarget } from './outbound/target.js';

/**
 * 解析会话目标
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

  const parsed = tryParseTarget(rawTarget);
  if (!parsed) {
    return null;
  }

  if (parsed.scope !== 'c2c' && parsed.scope !== 'group') {
    return null;
  }

  // 保存完整目标字符串（包括 scope），避免后续解析时丢失 scope 信息
  const fullTarget = `qqbot:${parsed.scope}:${parsed.targetId}`;

  return {
    conversationId: fullTarget,
    parentConversationId: fullTarget,
  };
}

/**
 * 解析投递目标
 */
function resolveQQBotDeliveryTarget(params: {
  conversationId: string;
  parentConversationId?: string;
}): { to: string } | null {
  const targetStr = params.parentConversationId || params.conversationId;
  if (!targetStr) {
    return null;
  }

  const parsed = tryParseTarget(targetStr);
  if (!parsed) {
    return null;
  }

  if (parsed.scope !== 'c2c' && parsed.scope !== 'group') {
    return null;
  }

  return {
    to: `qqbot:${parsed.scope}:${parsed.targetId}`,
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
