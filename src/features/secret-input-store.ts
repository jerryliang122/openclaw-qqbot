/**
 * 密钥输入 pending 状态机
 *
 * qqbot_secret_input 工具发卡时登记，secretCapture 中间件消费。
 * 与 multi-question 暂存（question-helpers.ts）同款模式：模块级 Map +
 * TTL setTimeout(unref) 清理。
 *
 * key 绑定 `accountId + c2c senderOpenid` —— pending 天然 per-user：
 * 只有发起密钥输入的同一私聊用户的消息会被捕获，群聊不参与。
 */
import type { SecretStoreKind } from './secret-store-cli.js';

export const DEFAULT_SECRET_INPUT_TTL_MS = 10 * 60 * 1000;

export interface PendingSecretInput {
  accountId: string;
  senderOpenid: string;
  /** 环境变量名（已通过 isValidSecretName 校验） */
  name: string;
  /** 已判定写入方式 */
  kind: SecretStoreKind;
  /** 用途说明（展示在卡片上，可选） */
  description?: string;
  createdAt: number;
  expiresAtMs: number;
}

interface StoredPendingSecretInput extends PendingSecretInput {
  cleanupTimer: ReturnType<typeof setTimeout>;
}

const pendingSecretInputs = new Map<string, StoredPendingSecretInput>();

export function secretInputKey(accountId: string, senderOpenid: string): string {
  return `${accountId}:c2c:${senderOpenid}`;
}

/**
 * 登记一次密钥输入等待。必须在发送卡片之前调用（避免「先发后登」竞态）。
 * 同一用户重复发起直接覆盖旧条目（并清理旧 timer）。
 */
export function registerPendingSecretInput(
  entry: Omit<PendingSecretInput, 'expiresAtMs'>,
  ttlMs: number = DEFAULT_SECRET_INPUT_TTL_MS,
): void {
  const key = secretInputKey(entry.accountId, entry.senderOpenid);
  const existing = pendingSecretInputs.get(key);
  if (existing) clearTimeout(existing.cleanupTimer);

  const stored: StoredPendingSecretInput = {
    ...entry,
    expiresAtMs: Date.now() + ttlMs,
    cleanupTimer: setTimeout(() => {
      if (pendingSecretInputs.get(key) === stored) {
        pendingSecretInputs.delete(key);
      }
    }, ttlMs),
  };
  stored.cleanupTimer.unref?.();
  pendingSecretInputs.set(key, stored);
}

function lookup(accountId: string, senderOpenid: string): StoredPendingSecretInput | undefined {
  const key = secretInputKey(accountId, senderOpenid);
  const entry = pendingSecretInputs.get(key);
  if (!entry) return undefined;
  if (entry.expiresAtMs <= Date.now()) {
    clearTimeout(entry.cleanupTimer);
    pendingSecretInputs.delete(key);
    return undefined;
  }
  return entry;
}

/** 查询进行中的密钥输入（过期条目惰性清除），不消费 */
export function findPendingSecretInput(
  accountId: string,
  senderOpenid: string,
): PendingSecretInput | undefined {
  const entry = lookup(accountId, senderOpenid);
  if (!entry) return undefined;
  const { cleanupTimer: _timer, ...rest } = entry;
  return rest;
}

/** 一次性消费：取出并删除（防同一条 pending 被处理两次） */
export function takePendingSecretInput(
  accountId: string,
  senderOpenid: string,
): PendingSecretInput | undefined {
  const entry = lookup(accountId, senderOpenid);
  if (!entry) return undefined;
  clearTimeout(entry.cleanupTimer);
  pendingSecretInputs.delete(secretInputKey(accountId, senderOpenid));
  const { cleanupTimer: _timer, ...rest } = entry;
  return rest;
}

/** 主动取消（用户发送「取消」/ 发卡失败回滚） */
export function cancelPendingSecretInput(accountId: string, senderOpenid: string): boolean {
  const key = secretInputKey(accountId, senderOpenid);
  const entry = pendingSecretInputs.get(key);
  if (!entry) return false;
  clearTimeout(entry.cleanupTimer);
  pendingSecretInputs.delete(key);
  return true;
}

/** 测试辅助 */
export function pendingSecretInputCount(): number {
  return pendingSecretInputs.size;
}

/** 测试辅助：清空全部 pending（不触发 timer 回调） */
export function clearPendingSecretInputs(): void {
  for (const entry of pendingSecretInputs.values()) clearTimeout(entry.cleanupTimer);
  pendingSecretInputs.clear();
}
