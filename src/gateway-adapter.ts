/**
 * QQBot Gateway 适配器
 *
 * 账户启动/停止/登出
 */

import type { ResolvedQQBotAccount } from './types.js';
import {
  startAccountWithCredentialRecovery,
  stopAccountGracefully,
  logoutAndClearCredentials,
} from './gateway/lifecycle.js';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

/**
 * QQBot Gateway Adapter
 */
export const qqbotGatewayAdapter = {
  startAccount: async (ctx: {
    account: ResolvedQQBotAccount;
    accountId: string;
    abortSignal: AbortSignal;
    cfg: OpenClawConfig;
    log?: any;
    getStatus: () => Record<string, unknown>;
    setStatus: (status: any) => void;
  }) => {
    return startAccountWithCredentialRecovery(ctx);
  },

  stopAccount: async (ctx: { accountId: string; log?: any }) => {
    await stopAccountGracefully({
      accountId: ctx.accountId,
      log: ctx.log,
    });
  },

  logoutAccount: async (params: {
    accountId: string;
    cfg: OpenClawConfig;
  }) => {
    return logoutAndClearCredentials(params);
  },
};
