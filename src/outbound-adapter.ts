/**
 * QQBot Outbound 适配器
 *
 * 封装 sendText/sendMedia 流式等出站操作，提供配额感知的发送能力
 */

import { checkAndConsumePassiveReplyQuota, checkPassiveReplyQuota, rollbackPassiveReplyQuota, inferQQBotScope } from './features/quota-manager.js';
import type { PluginLogger } from './utils/plugin-logger.js';
import type { ResolvedQQBotAccount } from './types.js';
import type { SendMediaParams, SendMediaResult } from './outbound/media-send.js';
import type { SendResult } from './outbound/outbound-service.js';

export type SendTextFn = (params: {
  to: string;
  text: string;
  accountId?: string;
  replyToId?: string;
  account: ResolvedQQBotAccount;
}) => Promise<SendResult>;

export type SendMediaFn = (params: SendMediaParams) => Promise<SendMediaResult>;

export interface QQBotOutboundAdapterParams {
  sendText?: SendTextFn;
  sendMedia?: SendMediaFn;
  shouldSuppressLocalPayloadPrompt?: (params: { payload: unknown }) => boolean;
  shouldTreatDeliveredTextAsVisible?: (params: { kind: string; text?: string }) => boolean;
  preferFinalAssistantVisibleText?: boolean;
  beforeDeliverPayload?: (params: {
    cfg: unknown;
    target: { to: string; accountId?: string; replyToId?: string };
    hint?: unknown;
    payload?: unknown;
  }) => Promise<{ mode: 'passive' | 'proactive'; msgId?: string } | void>;
}

export interface QQBotOutboundAdapter {
  sendTextWithQuota: (params: {
    to: string;
    text: string;
    accountId?: string;
    replyToId?: string;
    account: ResolvedQQBotAccount;
    log?: PluginLogger;
  }) => Promise<{ messageId?: string; error?: string }>;
  sendMediaWithQuota: (params: {
    to: string;
    source: string;
    text?: string;
    accountId?: string;
    replyToId?: string;
    account: ResolvedQQBotAccount;
    log?: PluginLogger;
  }) => Promise<{ messageId?: string; error?: string }>;
  canSendTyping: (params: {
    to: string;
    accountId: string;
    replyToId: string;
    log?: PluginLogger;
  }) => Promise<boolean>;
  shouldSuppressLocalPayloadPrompt: (params: { payload: unknown }) => boolean;
  shouldTreatDeliveredTextAsVisible: (params: { kind: string; text?: string }) => boolean;
  preferFinalAssistantVisibleText: boolean;
}

let lazySendText: SendTextFn | undefined;
let lazySendMedia: SendMediaFn | undefined;

async function getSendText(): Promise<SendTextFn> {
  if (!lazySendText) {
    const mod = await import('./outbound/outbound-service.js');
    lazySendText = mod.sendText;
  }
  return lazySendText;
}

async function getSendMedia(): Promise<SendMediaFn> {
  if (!lazySendMedia) {
    const mod = await import('./outbound/media-send.js');
    lazySendMedia = mod.sendMedia;
  }
  return lazySendMedia;
}

/**
 * 创建 QQBot Outbound 适配器
 */
export function createQQBotOutboundAdapter(params: QQBotOutboundAdapterParams): QQBotOutboundAdapter {
  const {
    sendText: injectedSendText,
    sendMedia: injectedSendMedia,
    shouldSuppressLocalPayloadPrompt = () => false,
    shouldTreatDeliveredTextAsVisible = () => true,
    preferFinalAssistantVisibleText = true,
    beforeDeliverPayload,
  } = params;

  return {
    sendTextWithQuota: async ({ to, text, accountId, replyToId, account, log }) => {
      const scope = inferQQBotScope(to);
      const resolvedAccountId = accountId || account.accountId;

      // 使用原子操作检查并消耗配额
      const { canReply, rollback } = await checkAndConsumePassiveReplyQuota({
        accountId: resolvedAccountId,
        msgId: replyToId,
        scope,
        log,
      });

      const sendTextFn = injectedSendText || await getSendText();
      const result = await sendTextFn({
        to,
        text,
        accountId: resolvedAccountId,
        replyToId: canReply ? replyToId : undefined,
        account,
      });

      // 发送失败时回滚配额
      if (canReply && replyToId && result.error) {
        rollback();
        log?.debug?.(`[${resolvedAccountId}] rollback quota: send failed`);
      } else if (!canReply) {
        log?.debug?.(`[${resolvedAccountId}] fallback to proactive send: quota exhausted or no msgId`);
      }

      return result;
    },

    sendMediaWithQuota: async ({ to, source, text, accountId, replyToId, account, log }) => {
      const scope = inferQQBotScope(to);
      const resolvedAccountId = accountId || account.accountId;

      // 使用原子操作检查并消耗配额
      const { canReply, rollback } = await checkAndConsumePassiveReplyQuota({
        accountId: resolvedAccountId,
        msgId: replyToId,
        scope,
        log,
      });

      const sendMediaFn = injectedSendMedia || await getSendMedia();
      const result = await sendMediaFn({
        to,
        source,
        text,
        replyToId: canReply ? replyToId : undefined,
        accountId: resolvedAccountId,
        log,
      });

      // 发送失败时回滚配额
      if (canReply && replyToId && result.error) {
        rollback();
        log?.debug?.(`[${resolvedAccountId}] rollback quota: send failed`);
      }

      return result;
    },

    canSendTyping: async ({ to, accountId, replyToId, log }) => {
      const scope = inferQQBotScope(to);

      if (scope !== 'c2c' || !replyToId) {
        return false;
      }

      const canPassiveReply = await checkPassiveReplyQuota({
        accountId,
        msgId: replyToId,
        scope: 'c2c',
      });

      if (!canPassiveReply) {
        return false;
      }

      return true;
    },

    shouldSuppressLocalPayloadPrompt,
    shouldTreatDeliveredTextAsVisible,
    preferFinalAssistantVisibleText,
  };
}

export const qqbotChannelOutbound = {
  ...createQQBotOutboundAdapter({
    shouldSuppressLocalPayloadPrompt: () => false,
    shouldTreatDeliveredTextAsVisible: () => true,
    preferFinalAssistantVisibleText: true,
  }),
  deliveryMode: 'direct' as const,
};
