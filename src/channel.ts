/**
 * QQ Bot ChannelPlugin 定义
 *
 * 使用 createChatChannelPlugin 构建标准插件
 */

import { createChatChannelPlugin } from 'openclaw/plugin-sdk/channel-core';
import { DEFAULT_ACCOUNT_ID } from 'openclaw/plugin-sdk/account-id';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import type { ResolvedQQBotAccount } from './types.js';
import {
  listQQBotAccountIds,
  resolveQQBotAccount,
  resolveDefaultQQBotAccountId,
  resolveRequireMention,
  resolveToolPolicy,
  resolveGroupConfig,
} from './config.js';
import { createQQBotPluginBase } from './plugin-base.js';
import { qqbotMessageAdapter } from './message-adapter.js';
import { qqbotMessagingAdapter } from './messaging-adapter.js';
import { qqbotStatusAdapter } from './status-adapter.js';
import { qqbotGatewayAdapter } from './gateway-adapter.js';
import { qqbotChannelOutbound } from './outbound-adapter.js';
import { qqbotHeartbeatAdapter } from './heartbeat-adapter.js';
import { qqbotAgentPromptAdapter } from './agent-prompt-adapter.js';
import { qqbotThreadingAdapter } from './threading-adapter.js';
import { getQQBotApprovalCapability } from './features/approval-capability.js';
import { stripMentionText } from './utils/mention.js';

/**
 * QQBot Groups Adapter
 */
const qqbotGroupsAdapter = {
  resolveRequireMention: ({ cfg, accountId, groupId }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    groupId?: string | null;
  }) => {
    if (!groupId) return undefined;
    return resolveRequireMention(cfg, groupId, accountId ?? undefined);
  },

  resolveToolPolicy: ({ cfg, accountId, groupId }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    groupId?: string | null;
  }) => {
    if (!groupId) return undefined;
    const policy = resolveToolPolicy(cfg, groupId, accountId ?? undefined);
    if (policy === 'full') return undefined;
    if (policy === 'none') return { allow: [], deny: ['*'] };
    return { allow: [] };
  },

  resolveGroupIntroHint: ({ cfg, accountId, groupId }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    groupId?: string | null;
  }) => {
    if (!groupId) return undefined;
    const groupCfg = resolveGroupConfig(cfg, groupId, accountId ?? undefined);
    return groupCfg.name ? `当前群: ${groupCfg.name}` : undefined;
  },
};

/**
 * QQBot Mentions Adapter
 */
const qqbotMentionsAdapter = {
  stripMentions: ({ text, ctx }: { text: string; ctx: unknown }) => {
    const mentions = (ctx as any)?.mentions;
    return stripMentionText(text, mentions);
  },
};

/**
 * QQBot Config Adapter
 */
const qqbotConfigAdapter = {
  listAccountIds: (cfg: OpenClawConfig) => listQQBotAccountIds(cfg),
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
    resolveQQBotAccount(cfg, accountId),
  defaultAccountId: (cfg: OpenClawConfig) => resolveDefaultQQBotAccountId(cfg),
  isConfigured: (account?: ResolvedQQBotAccount) => {
    return Boolean(account?.appId && account?.clientSecret);
  },
  describeAccount: (account?: ResolvedQQBotAccount) => ({
    accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
    name: account?.name,
    enabled: account?.enabled ?? false,
    configured: Boolean(account?.appId && account?.clientSecret),
    tokenSource: account?.secretSource,
  }),
};

/**
 * QQBot Channel Plugin
 */
export const qqbotPlugin = createChatChannelPlugin({
  base: {
    ...createQQBotPluginBase(),

    config: qqbotConfigAdapter,

    message: qqbotMessageAdapter,
    messaging: qqbotMessagingAdapter,
    status: qqbotStatusAdapter,
    gateway: qqbotGatewayAdapter,
    outbound: qqbotChannelOutbound,

    agentPrompt: qqbotAgentPromptAdapter,
    heartbeat: qqbotHeartbeatAdapter,
    threading: qqbotThreadingAdapter,
    groups: qqbotGroupsAdapter,
    mentions: qqbotMentionsAdapter,

    approvalCapability: getQQBotApprovalCapability(),
  },
});

// Re-export for backward compatibility
export { stripMentionText } from './utils/mention.js';
export { detectWasMentioned } from './utils/mention.js';
export { TEXT_CHUNK_LIMIT } from './constants.js';
