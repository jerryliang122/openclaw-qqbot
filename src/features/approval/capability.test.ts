import { describe, expect, it, vi } from "vitest";

vi.mock("../../exec-approvals.js", () => ({
  resolveQQBotExecApprovalConfig: vi.fn(),
  isQQBotExecApprovalClientEnabled: vi.fn(),
  shouldHandleQQBotExecApprovalRequest: vi.fn(),
  authorizeQQBotApprovalAction: vi.fn(),
  matchesQQBotApprovalAccount: vi.fn(),
}));
vi.mock("../../config.js", () => ({
  resolveQQBotAccount: vi.fn(),
}));

import {
  resolveQQBotExecApprovalConfig,
  authorizeQQBotApprovalAction,
} from "../../exec-approvals.js";
import { resolveQQBotAccount } from "../../config.js";
import { getQQBotApprovalCapability } from "./capability.js";

const baseCfg = {} as any;

describe("getQQBotApprovalCapability", () => {
  it("reports enabled when QQBot account is enabled and secret is resolved", () => {
    vi.mocked(resolveQQBotExecApprovalConfig).mockReturnValue(undefined);
    vi.mocked(resolveQQBotAccount).mockReturnValue({
      enabled: true,
      secretSource: "config",
    } as any);

    const cap = getQQBotApprovalCapability();
    const state = cap.getActionAvailabilityState?.({
      cfg: baseCfg,
      accountId: "a",
      action: "approve",
    });
    expect(state).toEqual({ kind: "enabled" });
  });

  it("reports disabled when QQBot account is disabled", () => {
    vi.mocked(resolveQQBotExecApprovalConfig).mockReturnValue(undefined);
    vi.mocked(resolveQQBotAccount).mockReturnValue({
      enabled: false,
      secretSource: "config",
    } as any);

    const cap = getQQBotApprovalCapability();
    const state = cap.getActionAvailabilityState?.({
      cfg: baseCfg,
      accountId: "a",
      action: "approve",
    });
    expect(state).toEqual({ kind: "disabled" });
  });

  it("delegates authorizeActorAction to authorizeQQBotApprovalAction", () => {
    vi.mocked(authorizeQQBotApprovalAction).mockReturnValue({ authorized: true });
    const cap = getQQBotApprovalCapability();
    const result = cap.authorizeActorAction?.({
      cfg: baseCfg,
      accountId: "a",
      senderId: "u",
      action: "approve",
      approvalKind: "exec",
    });
    expect(vi.mocked(authorizeQQBotApprovalAction)).toHaveBeenCalledWith({
      cfg: baseCfg,
      accountId: "a",
      senderId: "u",
      approvalKind: "exec",
    });
    expect(result).toEqual({ authorized: true });
  });
});