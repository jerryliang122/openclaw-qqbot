/**
 * QQBot 被动回复配额管理
 *
 * C2C: 4 次/msg_id, 60 分钟
 * Group: 5 次/msg_id, 5 分钟
 */

import type { QuotaState, QuotaCheckParams, QuotaConsumeParams } from '../types-plugin.js';

const quotaCache = new Map<string, QuotaState>();
const MAX_CACHE_SIZE = 10000;

const QUOTA_LIMITS = {
  c2c: { count: 4, ttlMs: 60 * 60 * 1000 },
  group: { count: 5, ttlMs: 5 * 60 * 1000 },
};

export async function checkPassiveReplyQuota(params: QuotaCheckParams): Promise<boolean> {
  const { accountId, msgId, scope } = params;

  if (!msgId) {
    return false;
  }

  const key = `${accountId}:${scope}:${msgId}`;
  const now = Date.now();

  const cached = quotaCache.get(key);
  if (cached) {
    if (now > cached.expiresAt) {
      quotaCache.delete(key);
      return true;
    }

    const limit = QUOTA_LIMITS[scope].count;
    if (cached.count >= limit) {
      return false;
    }
  }

  return true;
}

export async function consumePassiveReplyQuota(params: QuotaConsumeParams): Promise<void> {
  const { accountId, msgId, scope, log } = params;
  const key = `${accountId}:${scope}:${msgId}`;
  const now = Date.now();

  const ttl = QUOTA_LIMITS[scope].ttlMs;

  const cached = quotaCache.get(key) || { count: 0, expiresAt: now + ttl };
  cached.count += 1;

  quotaCache.set(key, cached);

  if (quotaCache.size > MAX_CACHE_SIZE) {
    const oldestKey = quotaCache.keys().next().value;
    if (oldestKey) {
      quotaCache.delete(oldestKey);
    }
  }

  log?.debug?.(`[${accountId}] consumed passive quota: ${key} count=${cached.count}`);
}

export function inferQQBotScope(to: string): 'c2c' | 'group' {
  const parts = to.split(':');
  const scope = parts[1];
  return scope === 'group' ? 'group' : 'c2c';
}

export function clearQuotaCache(): void {
  quotaCache.clear();
}

export function getQuotaStats(accountId: string, scope: 'c2c' | 'group'): {
  activeSessions: number;
  totalUsage: number;
} {
  let activeSessions = 0;
  let totalUsage = 0;

  for (const [key, state] of quotaCache.entries()) {
    if (key.startsWith(`${accountId}:${scope}:`)) {
      activeSessions += 1;
      totalUsage += state.count;
    }
  }

  return { activeSessions, totalUsage };
}
