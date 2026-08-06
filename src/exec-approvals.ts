import type { ApprovalKind } from "./engine/approval/index.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveQQBotAccount } from "./config.js";

export function resolveQQBotExecApprovalConfig(_params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): unknown {
  return undefined;
}

export function isQQBotExecApprovalClientEnabled(_params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return true;
}

export function shouldHandleQQBotExecApprovalRequest(_params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: unknown;
}): boolean {
  return true;
}

export function matchesQQBotApprovalAccount(_params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: unknown;
}): boolean {
  return true;
}

export function authorizeQQBotApprovalAction(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
  approvalKind: ApprovalKind;
}): { authorized: boolean; reason?: string } {
  const account = resolveQQBotAccount(params.cfg, params.accountId);
  if (!account.enabled || account.secretSource === "none") {
    return { authorized: false, reason: "Account is not enabled." };
  }
  const allowFrom = account.config.allowFrom ?? [];
  if (allowFrom.length === 0 || allowFrom.includes("*")) {
    return { authorized: true };
  }
  return allowFrom.includes(params.senderId ?? "")
    ? { authorized: true }
    : { authorized: false, reason: "Sender is not in allowFrom." };
}