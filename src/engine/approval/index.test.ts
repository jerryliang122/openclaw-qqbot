import { describe, expect, it } from "vitest";
import type { PendingApprovalView } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  buildApprovalKeyboard,
  buildExecApprovalText,
  buildPluginApprovalText,
  parseApprovalButtonData,
  resolveApprovalTarget,
} from "./index.js";

const baseView = (overrides: Partial<PendingApprovalView> = {}): PendingApprovalView => ({
  approvalId: "exec:550e8400-e29b-41d4-a716-446655440000",
  approvalKind: "exec",
  commandText: "rm -rf /tmp/foo",
  expiresAtMs: Date.now() + 60_000,
  actions: [
    { id: "allow", label: "Allow once", decision: "allow-once" },
    { id: "always", label: "Always", decision: "allow-always" },
    { id: "deny", label: "Deny", decision: "deny" },
  ],
  ...overrides,
} as PendingApprovalView);

describe("buildExecApprovalText", () => {
  it("renders the lock header and command preview", () => {
    const text = buildExecApprovalText(baseView({ commandText: "echo hi" }), 0);
    expect(text).toContain("命令执行审批");
    expect(text).toContain("echo hi");
  });

  it("renders the timeout countdown when expiresAtMs is in the future", () => {
    const text = buildExecApprovalText(baseView(), Date.now());
    expect(text).toMatch(/超时: \d+ 秒/);
  });
});

describe("buildPluginApprovalText", () => {
  it("uses the critical severity icon when severity is critical", () => {
    const text = buildPluginApprovalText(
      baseView({ approvalKind: "plugin", title: "Need permission", severity: "critical", description: undefined, commandText: undefined, cwd: undefined, agentId: undefined } as Partial<PendingApprovalView>),
      0,
    );
    expect(text).toContain("🔴");
    expect(text).toContain("Need permission");
  });
});

describe("buildApprovalKeyboard", () => {
  it("encodes the approvalId with v2 prefix and URL encoding", () => {
    const keyboard = buildApprovalKeyboard(
      "exec:550e8400-e29b-41d4-a716-446655440000",
      "exec",
    );
    const row = keyboard.content.rows[0];
    const allow = row.buttons.find((b) => b.id === "allow")!;
    expect(allow.action.data).toBe(
      "approve:v2:exec:exec%3A550e8400-e29b-41d4-a716-446655440000:allow-once",
    );
  });

  it("uses the approval group id and click limit 1", () => {
    const keyboard = buildApprovalKeyboard("plugin:abc", "plugin");
    for (const button of keyboard.content.rows[0].buttons) {
      expect(button.group_id).toBe("approval");
      expect(button.action.type).toBe(1);
      expect(button.action.click_limit).toBe(1);
      expect(button.action.permission?.type).toBe(2);
    }
  });

  it("honours allowedDecisions by omitting unselected buttons", () => {
    const keyboard = buildApprovalKeyboard("plugin:abc", "plugin", ["deny"]);
    const ids = keyboard.content.rows[0].buttons.map((b) => b.id);
    expect(ids).toEqual(["deny"]);
  });
});

describe("parseApprovalButtonData", () => {
  it("decodes a v2 button and returns the approval payload", () => {
    const parsed = parseApprovalButtonData(
      "approve:v2:exec:exec%3A550e8400-e29b-41d4-a716-446655440000:allow-once",
    );
    expect(parsed).toEqual({
      approvalId: "exec:550e8400-e29b-41d4-a716-446655440000",
      approvalKind: "exec",
      decision: "allow-once",
    });
  });

  it("returns null for legacy approve:exec:UUID:... format", () => {
    expect(parseApprovalButtonData("approve:exec:550e8400-...:allow-once")).toBeNull();
  });

  it("returns null for unknown shape", () => {
    expect(parseApprovalButtonData("nonsense")).toBeNull();
  });
});

describe("resolveApprovalTarget", () => {
  it("resolves c2c from sessionKey", () => {
    expect(resolveApprovalTarget("agent:main:qqbot:c2c:OPENID1", null)).toEqual({
      type: "c2c",
      id: "OPENID1",
    });
  });

  it("resolves group from sessionKey", () => {
    expect(resolveApprovalTarget("agent:main:qqbot:group:G1", null)).toEqual({
      type: "group",
      id: "G1",
    });
  });

  it("resolves from turnSourceTo when sessionKey missing", () => {
    expect(resolveApprovalTarget(null, "agent:main:qqbot:direct:OPENID2")).toEqual({
      type: "c2c",
      id: "OPENID2",
    });
  });

  it("returns null when no match", () => {
    expect(resolveApprovalTarget(null, "not-a-qqbot-target")).toBeNull();
  });
});