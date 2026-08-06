import { describe, expect, it, vi } from "vitest";

vi.mock("../../bot-instance.js", () => ({
  getBotForAccount: vi.fn(),
}));
vi.mock("../../config.js", () => ({
  resolveQQBotAccount: vi.fn().mockReturnValue({
    enabled: true,
    secretSource: "config",
    appId: "app",
  }),
}));
vi.mock("../../exec-approvals.js", () => ({
  resolveQQBotExecApprovalConfig: vi.fn().mockReturnValue(undefined),
  isQQBotExecApprovalClientEnabled: vi.fn().mockReturnValue(true),
  shouldHandleQQBotExecApprovalRequest: vi.fn(),
  matchesQQBotApprovalAccount: vi.fn().mockReturnValue(true),
}));

import { getBotForAccount } from "../../bot-instance.js";
import { qqbotApprovalNativeRuntime } from "./handler-runtime.js";

const sendTextWithKeyboard = vi.fn();

const baseView = {
  approvalId: "exec:abc",
  approvalKind: "exec" as const,
  commandText: "ls",
  expiresAtMs: Date.now() + 60_000,
  actions: [
    { id: "allow", decision: "allow-once" },
    { id: "always", decision: "allow-always" },
    { id: "deny", decision: "deny" },
  ],
};

describe("qqbotApprovalNativeRuntime", () => {
  it("buildPendingPayload returns text + v2 keyboard", async () => {
    const adapter = qqbotApprovalNativeRuntime as any;
    const out = await adapter.presentation.buildPendingPayload({
      cfg: {},
      accountId: "a",
      context: {},
      request: { id: "exec:abc", request: {} },
      approvalKind: "exec",
      nowMs: Date.now(),
      view: baseView,
    });
    expect(out.text).toContain("命令执行审批");
    const data = out.keyboard.content.rows[0].buttons[0].action.data;
    expect(data).toMatch(/^approve:v2:exec:exec%3Aabc:allow-once$/);
  });

  it("buildResolvedResult and buildExpiredResult return kind=leave", async () => {
    const adapter = qqbotApprovalNativeRuntime as any;
    const resolved = await adapter.presentation.buildResolvedResult({
      cfg: {},
      accountId: "a",
      context: {},
      request: { id: "x", request: {} },
      resolved: { id: "x", decision: "allow-once" },
      view: {},
    });
    const expired = await adapter.presentation.buildExpiredResult({
      cfg: {},
      accountId: "a",
      context: {},
      request: { id: "x", request: {} },
      view: {},
    });
    expect(resolved).toEqual({ kind: "leave" });
    expect(expired).toEqual({ kind: "leave" });
  });

  it("deliverPending calls sendTextWithKeyboard with ReplyTarget and keyboard", async () => {
    const bot = { sendTextWithKeyboard };
    vi.mocked(getBotForAccount).mockReturnValue(bot as any);
    sendTextWithKeyboard.mockResolvedValue({ id: "msg1" });

    const adapter = qqbotApprovalNativeRuntime as any;
    await adapter.transport.deliverPending({
      cfg: {},
      accountId: "a",
      context: {},
      preparedTarget: { type: "c2c", id: "U1" },
      request: { id: "x", request: {} },
      approvalKind: "exec",
      view: baseView,
      pendingPayload: {
        text: "hello",
        keyboard: { content: { rows: [{ buttons: [] }] } } as any,
      },
    });

    expect(getBotForAccount).toHaveBeenCalledWith("a");
    expect(sendTextWithKeyboard).toHaveBeenCalledWith(
      { scope: "c2c", targetId: "U1" },
      "hello",
      expect.objectContaining({ content: expect.any(Object) }),
    );
  });
});