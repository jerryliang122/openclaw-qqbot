/**
 * QQBot Status 适配器
 *
 * 账户状态探测、审计、快照构建
 */

import { DEFAULT_ACCOUNT_ID } from './config.js';
import type { ResolvedQQBotAccount } from './types.js';

/**
 * 默认运行时状态
 */
function createDefaultChannelRuntimeState(accountId: string) {
  return {
    accountId,
    running: false,
    connected: false,
    lastConnectedAt: null as number | null,
    lastError: null as string | null,
    lastInboundAt: null as number | null,
    lastOutboundAt: null as number | null,
  };
}

/**
 * QQBot Status Adapter
 */
export const qqbotStatusAdapter = {
  defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),

  buildChannelSummary: ({ snapshot }: { snapshot: any }) => ({
    configured: snapshot.configured ?? false,
    tokenSource: snapshot.tokenSource ?? 'none',
    running: snapshot.running ?? false,
    connected: snapshot.connected ?? false,
    lastConnectedAt: snapshot.lastConnectedAt ?? null,
    lastError: snapshot.lastError ?? null,
  }),

  resolveAccountSnapshot: ({ account, runtime }: {
    account?: ResolvedQQBotAccount;
    runtime?: any;
  }) => ({
    accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
    name: account?.name,
    enabled: account?.enabled ?? false,
    configured: Boolean(account?.appId && account?.clientSecret),
    tokenSource: account?.secretSource,
    running: Boolean(runtime?.running ?? false),
    connected: Boolean(runtime?.connected ?? false),
    lastConnectedAt: runtime?.lastConnectedAt ?? null,
    lastError: runtime?.lastError ?? null,
    lastInboundAt: runtime?.lastInboundAt ?? null,
    lastOutboundAt: runtime?.lastOutboundAt ?? null,
  }),
};
