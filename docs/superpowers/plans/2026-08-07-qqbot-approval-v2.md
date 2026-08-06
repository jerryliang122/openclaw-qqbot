# QQBot Approval v2 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate QQBot approval flow to the framework's v2 button protocol so that clicking an "allow once / allow always / deny" button on an approval card resolves the pending approval instead of timing out.

**Architecture:** Replace the plugin's hand-rolled `QQBotApprovalHandler` (legacy WebSocket gateway client + custom `approve:exec:UUID:...` button data) with the framework's `ChannelApprovalCapability` contract. The plugin exposes a `createChannelApprovalCapability` that wraps an `ExecApprovalRequest`-driven native runtime adapter; the framework owns INTERACTION_CREATE parsing and click-to-RPC translation. The QQ Bot SDK stays; only the approval pathway changes.

**Tech Stack:** TypeScript 5.9, `@tencent-connect/qqbot-nodejs` (existing WebSocket SDK), `openclaw/plugin-sdk/approval-delivery-runtime` + `approval-handler-adapter-runtime` + `approval-handler-runtime` (existing peer dep), vitest 4 (tested via `npx vitest run`).

**Reference implementation:** `/root/openclaw/extensions/qqbot/src/bridge/approval/capability.ts` and `/root/openclaw/extensions/qqbot/src/engine/approval/index.ts` — same shapes, adapted to this plugin's code style and account-resolution helpers.

## Global Constraints

- **No click-side reply.** Per spec "Decisions §1": click → card auto-switches to `visited_label` (✅ 已处理 / ❌ 已拒绝). Do NOT send any extra text message on click. The `buildResolvedResult` adapter returns `{ kind: "leave" }`.
- **No legacy fallback.** Per spec "Decisions §2": no `loadApprovalGatewayRuntime()` dynamic import. Delete `src/features/approval-handler.ts` and `src/features/approval-utils.ts` entirely.
- **Single kind branch in pure helpers.** Both `buildExecApprovalText` and `buildPluginApprovalText` accept the unified `PendingApprovalView` and dispatch on `view.approvalKind`. There is no separate `buildExecApprovalRequest`/`buildPluginApprovalRequest` overload.
- **Test runner is vitest.** Use `npx vitest run tests/path/to/file.test.ts`. The repo has no `test` script; vitest is invoked via `npx`.
- **Typecheck is `npx tsc --noEmit`.** `lint:runtime` references a missing file and is not part of the loop.
- **No comments unless explicitly necessary.** Match the existing style in `src/engine/messaging/` and `src/bridge/`.
- **One commit per task.** Use the message style of recent commits (`feat: ...`, `fix: ...`, `docs: ...`).

---

## File Structure

Created:
- `src/engine/approval/index.ts` — pure helpers: `buildExecApprovalText`, `buildPluginApprovalText`, `buildApprovalKeyboard`, `resolveApprovalTarget`, `parseApprovalButtonData`.
- `src/engine/approval/index.test.ts` — vitest unit tests for the helpers above.
- `src/features/approval/capability.ts` — `createQQBotApprovalCapability()` returning a `ChannelApprovalCapability`.
- `src/features/approval/capability.test.ts` — vitest unit tests for capability availability + delivery suppression.
- `src/features/approval/handler-runtime.ts` — `qqbotApprovalNativeRuntime` adapter implementing `ChannelApprovalNativeRuntimeSpec`.
- `src/features/approval/handler-runtime.test.ts` — vitest unit tests for the adapter's presentation + transport.

Modified:
- `src/channel.ts` — register `approvalCapability: getQQBotApprovalCapability()` on the `qqbotPlugin` object.
- `src/gateway/lifecycle.ts` — drop approval-handler registration lines.
- `src/gateway/event-handlers.ts` — drop `handleApproval` and its `getApprovalHandler` import.
- `CHANGELOG.zh.md` — add a fix entry describing the migration.
- `README.zh.md` — drop the obsolete "审批功能降级" footnote.

Deleted:
- `src/features/approval-handler.ts`
- `src/features/approval-utils.ts`

Removed from `src/adapter/gateway.ts`:
- `loadApprovalGatewayRuntime` export.
- `ApprovalGatewayClient` type.
- Any test-only exports that depended on these.

---

## Task 1: Approval pure helpers + tests

**Files:**
- Create: `src/engine/approval/index.ts`
- Create: `src/engine/approval/index.test.ts`

**Interfaces:**
- Produces:
  - `buildExecApprovalText(view: PendingApprovalView, nowMs?: number): string`
  - `buildPluginApprovalText(view: PendingApprovalView, nowMs?: number): string`
  - `buildApprovalKeyboard(approvalId: string, approvalKind: "exec" | "plugin", allowedDecisions?: readonly ApprovalDecision[]): InlineKeyboard`
  - `resolveApprovalTarget(sessionKey: string | null | undefined, turnSourceTo: string | null | undefined): { type: ChatScope; id: string } | null`
  - `parseApprovalButtonData(buttonData: string): { approvalId: string; approvalKind: "exec" | "plugin"; decision: ApprovalDecision } | null`

- [ ] **Step 1: Write the failing test**

Create `src/engine/approval/index.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /root/openclaw-qqbot
npx vitest run src/engine/approval/index.test.ts
```

Expected: FAIL with "Cannot find module './index.js'".

- [ ] **Step 3: Implement the helpers**

Create `src/engine/approval/index.ts`:

```ts
import type {
  ExecApprovalPendingView,
  PendingApprovalView,
  PluginApprovalPendingView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { resolveExecApprovalCommandDisplay } from "openclaw/plugin-sdk/approval-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { ChatScope, InlineKeyboard, KeyboardButton } from "../types.js";

const COMMAND_PREVIEW_MAX_LENGTH = 300;
const COMMAND_PREVIEW_GRAPHEMES_PER_LINE = 24;
const COMMAND_PREVIEW_WRAP_MARKER = "↩";
const commandPreviewSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function splitCommandPreviewGraphemes(commandText: string): string[] {
  return commandPreviewSegmenter
    ? Array.from(commandPreviewSegmenter.segment(commandText), ({ segment }) => segment)
    : Array.from(commandText);
}

function formatCommandPreview(commandText: string): string {
  const lines = [""];
  const displayText = commandText.replaceAll(COMMAND_PREVIEW_WRAP_MARKER, "\\u{21A9}");
  let previewLength = 0;
  let lineGraphemes = 0;
  let truncated = false;
  let wrapped = false;
  for (const grapheme of splitCommandPreviewGraphemes(displayText)) {
    if (previewLength + grapheme.length > COMMAND_PREVIEW_MAX_LENGTH) {
      if (previewLength === 0) {
        lines[0] = truncateUtf16Safe(grapheme, COMMAND_PREVIEW_MAX_LENGTH);
      }
      truncated = true;
      break;
    }
    previewLength += grapheme.length;
    if (lineGraphemes === COMMAND_PREVIEW_GRAPHEMES_PER_LINE) {
      lines[lines.length - 1] += COMMAND_PREVIEW_WRAP_MARKER;
      lines.push("");
      lineGraphemes = 0;
      wrapped = true;
    }
    lines[lines.length - 1] += grapheme;
    lineGraphemes += 1;
  }
  const preview = `${lines.join("\n")}${truncated ? "\n…[truncated]" : ""}`;
  const longestBacktickRun = Math.max(0, ...(preview.match(/`+/g)?.map((run) => run.length) ?? []));
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  const block = `${fence}\n${preview}\n${fence}`;
  return wrapped
    ? `${COMMAND_PREVIEW_WRAP_MARKER} = display wrap only; not command text\n${block}`
    : block;
}

function formatApprovalMetadata(value: string): string {
  const sanitized = resolveExecApprovalCommandDisplay({ command: value }).commandText;
  return formatCommandPreview(sanitized);
}

export type ApprovalDecision = "allow-once" | "allow-always" | "deny";
export type ApprovalKind = "exec" | "plugin";

export interface ApprovalTarget {
  type: ChatScope;
  id: string;
}

export interface ParsedApprovalAction {
  approvalId: string;
  approvalKind: ApprovalKind;
  decision: ApprovalDecision;
}

export function buildExecApprovalText(view: PendingApprovalView, nowMs = Date.now()): string {
  const execView = view as ExecApprovalPendingView;
  const expiresIn = Math.max(0, Math.round((view.expiresAtMs - nowMs) / 1000));
  const lines: string[] = ["\u{1f510} \u547d\u4ee4\u6267\u884c\u5ba1\u6279", ""];
  if (execView.commandText) {
    lines.push(formatCommandPreview(execView.commandText));
  }
  if (execView.cwd) {
    lines.push(`\u{1f4c1} \u76ee\u5f55:\n${formatApprovalMetadata(execView.cwd)}`);
  }
  if (execView.agentId) {
    lines.push(`\u{1f916} Agent:\n${formatApprovalMetadata(execView.agentId)}`);
  }
  lines.push("", `\u23f1\ufe0f \u8d85\u65f6: ${expiresIn} \u79d2`);
  return lines.join("\n");
}

export function buildPluginApprovalText(view: PendingApprovalView, nowMs = Date.now()): string {
  const pluginView = view as PluginApprovalPendingView;
  const expiresIn = Math.max(0, Math.round((view.expiresAtMs - nowMs) / 1000));
  const severityIcon =
    pluginView.severity === "critical"
      ? "\u{1f534}"
      : pluginView.severity === "info"
        ? "\u{1f535}"
        : "\u{1f7e1}";
  const lines: string[] = [`${severityIcon} \u5ba1\u6279\u8bf7\u6c42`, ""];
  lines.push(`\u{1f4cb} ${pluginView.title}`);
  if (pluginView.description) {
    lines.push(`\u{1f4dd} ${pluginView.description}`);
  }
  if (pluginView.toolName) {
    lines.push(`\u{1f527} \u5de5\u5177: ${pluginView.toolName}`);
  }
  if (pluginView.pluginId) {
    lines.push(`\u{1f50c} \u63d2\u4ef6: ${pluginView.pluginId}`);
  }
  if (pluginView.agentId) {
    lines.push(`\u{1f916} Agent: ${pluginView.agentId}`);
  }
  lines.push("", `\u23f1\ufe0f \u8d85\u65f6: ${expiresIn} \u79d2`);
  return lines.join("\n");
}

export function buildApprovalKeyboard(
  approvalId: string,
  approvalKind: ApprovalKind,
  allowedDecisions: readonly ApprovalDecision[] = ["allow-once", "allow-always", "deny"],
): InlineKeyboard {
  const actionPrefix = `approve:v2:${approvalKind}:${encodeURIComponent(approvalId)}`;
  const makeBtn = (
    id: string,
    label: string,
    visitedLabel: string,
    data: string,
    style: 0 | 1,
  ): KeyboardButton => ({
    id,
    render_data: { label, visited_label: visitedLabel, style },
    action: {
      type: 1,
      data,
      permission: { type: 2 },
      click_limit: 1,
    },
    group_id: "approval",
  });

  const buttons: KeyboardButton[] = [];
  if (allowedDecisions.includes("allow-once")) {
    buttons.push(
      makeBtn(
        "allow",
        "\u2705 \u5141\u8bb8\u4e00\u6b21",
        "\u5df2\u5904\u7406",
        `${actionPrefix}:allow-once`,
        1,
      ),
    );
  }
  if (allowedDecisions.includes("allow-always")) {
    buttons.push(
      makeBtn(
        "always",
        "\u2b50 \u59cb\u7ec8\u5141\u8bb8",
        "\u5df2\u5904\u7406",
        `${actionPrefix}:allow-always`,
        1,
      ),
    );
  }
  if (allowedDecisions.includes("deny")) {
    buttons.push(
      makeBtn("deny", "\u274c \u62d2\u7edd", "\u5df2\u5904\u7406", `${actionPrefix}:deny`, 0),
    );
  }

  return { content: { rows: [{ buttons }] } };
}

export function resolveApprovalTarget(
  sessionKey: string | null | undefined,
  turnSourceTo: string | null | undefined,
): ApprovalTarget | null {
  const sk = sessionKey ?? turnSourceTo;
  if (!sk) return null;
  const m = sk.match(/qqbot:(c2c|direct|group):([A-F0-9]+)/i);
  if (!m) return null;
  const scope = m[1];
  const id = m[2];
  if (scope === undefined || id === undefined) return null;
  const type: ChatScope = scope.toLowerCase() === "group" ? "group" : "c2c";
  return { type, id };
}

export function parseApprovalButtonData(buttonData: string): ParsedApprovalAction | null {
  const m = buttonData.match(/^approve:v2:(exec|plugin):([^:]+):(allow-once|allow-always|deny)$/);
  if (!m || m[0] !== buttonData) return null;
  const kind = m[1];
  const encodedId = m[2];
  const decision = m[3];
  if (
    (kind !== "exec" && kind !== "plugin") ||
    encodedId === undefined ||
    (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny")
  ) {
    return null;
  }
  let approvalId: string;
  try {
    approvalId = decodeURIComponent(encodedId);
  } catch {
    return null;
  }
  if (!approvalId) return null;
  return { approvalId, approvalKind: kind, decision };
}
```

If `src/types.js` does not export `ChatScope`/`InlineKeyboard`/`KeyboardButton`, check `src/types.ts` and adjust imports accordingly. The names should match the existing project types.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /root/openclaw-qqbot
npx vitest run src/engine/approval/index.test.ts
```

Expected: PASS, 14 tests passing (5+1+2+3+3+4 across blocks; verify by running).

- [ ] **Step 5: Commit**

```bash
git add src/engine/approval/index.ts src/engine/approval/index.test.ts
git commit -m "feat: add v2 approval pure helpers"
```

---

---

## Task 3: `features/approval/capability.ts` + `features/approval/handler-runtime.ts` + register on `qqbotPlugin`

**Files:**
- Create: `src/features/approval/capability.ts`
- Create: `src/features/approval/handler-runtime.ts`
- Modify: `src/channel.ts` (add `approvalCapability: getQQBotApprovalCapability()` field + import)
- Create: `src/features/approval/capability.test.ts`
- Create: `src/features/approval/handler-runtime.test.ts`
- Create: `src/exec-approvals.ts` (shim — this plugin doesn't have one)

> **Plan amendment (post-review).** The original brief was authored against
> the reference implementation at `/root/openclaw/extensions/qqbot/`, which
> lives under `src/bridge/` and exposes `getMessageApi`/`accountToCreds`
> helpers. This plugin's structure is flat (`src/features/`, `src/outbound/`,
> `src/config.ts`, `src/bot-instance.ts`) and its only outbound API is
> `getBotForAccount(accountId).sendTextWithKeyboard(target, content, keyboard)`
> from the QQ Bot SDK. Task 3 has been rewritten to fit this plugin's actual
> structure. Task 4's deletion list (Task 4 §Files) was rewritten to match.

**Interfaces:**
- Consumes: pure helpers from Task 1 (`src/engine/approval/index.ts`).
- Produces:
  - `getQQBotApprovalCapability(): ChannelApprovalCapability` (cached singleton).
  - `qqbotApprovalNativeRuntime: ChannelApprovalNativeRuntimeAdapter` (lazy-loaded by `capability.ts`).

---

### Pre-flight (run before any code)

```bash
cd /root/openclaw-qqbot
grep -n "export function getBotForAccount" src/bot-instance.ts
grep -n "sendTextWithKeyboard" node_modules/@tencent-connect/qqbot-nodejs/dist/QQBot.d.ts
grep -n "export.*resolveQQBotAccount" src/config.ts
grep -n "export.*InlineKeyboard\|export.*KeyboardButton" src/types.ts
```

Expected:
- `getBotForAccount` exists in `src/bot-instance.ts` and returns the SDK `QQBot` instance.
- `sendTextWithKeyboard(target, content, keyboard): Promise<MessageResponse>` exists in the SDK.
- `resolveQQBotAccount(cfg, accountId): ResolvedQQBotAccount` exists in `src/config.ts:258`.
- `src/types.ts` exports `InlineKeyboard` and `KeyboardButton`.

If any check fails, STOP and report BLOCKED with the specific discrepancy.

---

### Step 1: Create `src/exec-approvals.ts` shim

This plugin has no `exec-approvals.ts`. Create a thin shim:

```ts
// src/exec-approvals.ts
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
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
  approvalKind: ChannelApprovalKind;
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
```

The shim's account shape matches `ResolvedQQBotAccount.config.allowFrom?: string[]`
(`src/types.ts:84`).

---

### Step 2: Write the failing test for `capability.ts`

Create `src/features/approval/capability.test.ts`:

```ts
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
```

### Step 3: Run test to verify it fails

```bash
cd /root/openclaw-qqbot
npx vitest run src/features/approval/capability.test.ts
```

Expected: FAIL with "Cannot find module './capability.js'".

### Step 4: Implement `capability.ts`

Create `src/features/approval/capability.ts`:

```ts
import { createChannelApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { resolveApprovalRequestSessionConversation } from "openclaw/plugin-sdk/approval-native-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveQQBotAccount } from "../../config.js";
import { resolveApprovalTarget } from "../../engine/approval/index.js";
import {
  authorizeQQBotApprovalAction,
  isQQBotExecApprovalClientEnabled,
  matchesQQBotApprovalAccount,
  resolveQQBotExecApprovalConfig,
  shouldHandleQQBotExecApprovalRequest,
} from "../../exec-approvals.js";

function hasExecApprovalConfig(params: { cfg: OpenClawConfig; accountId?: string | null }) {
  return resolveQQBotExecApprovalConfig(params) !== undefined;
}

function isNativeDeliveryEnabled(params: { cfg: OpenClawConfig; accountId?: string | null }) {
  if (hasExecApprovalConfig(params)) {
    return isQQBotExecApprovalClientEnabled(params);
  }
  const account = resolveQQBotAccount(params.cfg, params.accountId ?? undefined);
  return account.enabled && account.secretSource !== "none";
}

function shouldHandleRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: { request: { sessionKey?: string | null; turnSourceTo?: string | null; turnSourceAccountId?: string | null } };
}) {
  if (hasExecApprovalConfig(params)) {
    return shouldHandleQQBotExecApprovalRequest(params as never);
  }
  const target = resolveApprovalTarget(
    params.request.request.sessionKey ?? null,
    params.request.request.turnSourceTo ?? null,
  );
  if (!target) return false;
  return matchesQQBotApprovalAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    request: params.request as never,
  });
}

function resolveNativeDeliveryState(params: { cfg: OpenClawConfig; accountId?: string | null }) {
  return isNativeDeliveryEnabled(params)
    ? { kind: "enabled" as const }
    : { kind: "disabled" as const };
}

function createQQBotApprovalCapability(): ChannelApprovalCapability {
  return createChannelApprovalCapability({
    authorizeActorAction: ({ cfg, accountId, senderId, approvalKind }) =>
      authorizeQQBotApprovalAction({ cfg, accountId, senderId, approvalKind }),
    getActionAvailabilityState: resolveNativeDeliveryState,
    getExecInitiatingSurfaceState: resolveNativeDeliveryState,
    describeExecApprovalSetup: ({ accountId }) => {
      const prefix =
        accountId && accountId !== "default"
          ? `channels.qqbot.accounts.${accountId}`
          : "channels.qqbot";
      return `QQBot native exec approvals are enabled by default. To restrict who can approve, configure \`${prefix}.execApprovals.approvers\` with QQ user OpenIDs.`;
    },
    delivery: {
      hasConfiguredDmRoute: () => true,
      shouldSuppressForwardingFallback: (input) => {
        const channel = normalizeOptionalString(input.target?.channel);
        if (channel !== "qqbot") return false;
        const accountId =
          normalizeOptionalString(input.target?.accountId) ??
          normalizeOptionalString(input.request?.request?.turnSourceAccountId);
        return isNativeDeliveryEnabled({ cfg: input.cfg, accountId });
      },
    },
    native: {
      describeDeliveryCapabilities: ({ cfg, accountId }) => ({
        enabled: isNativeDeliveryEnabled({ cfg, accountId }),
        preferredSurface: "origin" as const,
        supportsOriginSurface: true,
        supportsApproverDmSurface: false,
        notifyOriginWhenDmOnly: false,
      }),
      resolveOriginTarget: ({ request }) => {
        const sessionKey = request.request.sessionKey ?? null;
        const turnSourceTo = request.request.turnSourceTo ?? null;
        const target = resolveApprovalTarget(sessionKey, turnSourceTo);
        if (target) return { to: `${target.type}:${target.id}` };
        const sessionConversation = resolveApprovalRequestSessionConversation({
          request: request as never,
          channel: "qqbot",
          bundledFallback: true,
        });
        if (sessionConversation?.id) {
          const kind = sessionConversation.kind === "group" ? "group" : "c2c";
          return { to: `${kind}:${sessionConversation.id}` };
        }
        return null;
      },
    },
    nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
      eventKinds: ["exec", "plugin"],
      isConfigured: ({ cfg, accountId }) => isNativeDeliveryEnabled({ cfg, accountId }),
      shouldHandle: ({ cfg, accountId, request }) =>
        shouldHandleRequest({ cfg, accountId, request: request as never }),
      load: async () => {
        const mod = await import("./handler-runtime.js");
        return mod.qqbotApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter;
      },
    }),
  });
}

const qqbotApprovalCapability = createQQBotApprovalCapability();

let cachedCapability: ChannelApprovalCapability | undefined;

export function getQQBotApprovalCapability(): ChannelApprovalCapability {
  cachedCapability ??= qqbotApprovalCapability;
  return cachedCapability;
}
```

### Step 5: Implement `handler-runtime.ts`

Create `src/features/approval/handler-runtime.ts`:

```ts
import type { ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import type { ChannelApprovalNativeRuntimeSpec } from "openclaw/plugin-sdk/approval-handler-runtime";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { resolveApprovalRequestSessionConversation } from "openclaw/plugin-sdk/approval-native-runtime";
import { getBotForAccount } from "../../bot-instance.js";
import { resolveQQBotAccount } from "../../config.js";
import {
  buildApprovalKeyboard,
  buildExecApprovalText,
  buildPluginApprovalText,
  resolveApprovalTarget,
  type ApprovalDecision,
  type ApprovalTarget,
} from "../../engine/approval/index.js";
import type { InlineKeyboard } from "../../types.js";
import {
  isQQBotExecApprovalClientEnabled,
  matchesQQBotApprovalAccount,
  resolveQQBotExecApprovalConfig,
  shouldHandleQQBotExecApprovalRequest,
} from "../../exec-approvals.js";

type PendingPayload = { text: string; keyboard: InlineKeyboard };
type PreparedTarget = ApprovalTarget;
type PendingEntry = { messageId?: string; targetType: ApprovalTarget["type"]; targetId: string };

function resolveQQTarget(request: {
  request: { sessionKey?: string | null; turnSourceTo?: string | null };
}): PreparedTarget | null {
  const sessionKey = request.request.sessionKey ?? null;
  const turnSourceTo = request.request.turnSourceTo ?? null;
  const direct = resolveApprovalTarget(sessionKey, turnSourceTo);
  if (direct) return direct;
  const sessionConversation = resolveApprovalRequestSessionConversation({
    request: request as never,
    channel: "qqbot",
    bundledFallback: true,
  });
  if (sessionConversation?.id) {
    const kind: ApprovalTarget["type"] = sessionConversation.kind === "group" ? "group" : "c2c";
    return { type: kind, id: sessionConversation.id };
  }
  return null;
}

const qqbotApprovalRuntimeSpec: ChannelApprovalNativeRuntimeSpec<
  PendingPayload,
  PreparedTarget,
  PendingEntry
> = {
  eventKinds: ["exec", "plugin"],
  availability: {
    isConfigured: ({ cfg, accountId }) => {
      if (resolveQQBotExecApprovalConfig({ cfg, accountId }) !== undefined) {
        return isQQBotExecApprovalClientEnabled({ cfg, accountId });
      }
      const account = resolveQQBotAccount(cfg, accountId ?? undefined);
      return account.enabled && account.secretSource !== "none";
    },
    shouldHandle: ({ cfg, accountId, request }) => {
      if (resolveQQBotExecApprovalConfig({ cfg, accountId }) !== undefined) {
        return shouldHandleQQBotExecApprovalRequest({ cfg, accountId, request });
      }
      const target = resolveQQTarget(request as never);
      if (!target) return false;
      return matchesQQBotApprovalAccount({
        cfg,
        accountId,
        request: request as never,
      });
    },
  },
  presentation: {
    buildPendingPayload: ({ view, nowMs }) => {
      const text =
        view.approvalKind === "exec"
          ? buildExecApprovalText(view, nowMs)
          : buildPluginApprovalText(view, nowMs);
      const allowedDecisions: readonly ApprovalDecision[] = (view.actions ?? []).map(
        (a) => a.decision as ApprovalDecision,
      );
      const keyboard = buildApprovalKeyboard(
        view.approvalId,
        view.approvalKind,
        allowedDecisions.length > 0
          ? allowedDecisions
          : ["allow-once", "allow-always", "deny"],
      );
      return { text, keyboard };
    },
    buildResolvedResult: () => ({ kind: "leave" }),
    buildExpiredResult: () => ({ kind: "leave" }),
  },
  transport: {
    prepareTarget: ({ request }) => {
      const target = resolveQQTarget(request as never);
      if (!target) return null;
      return { target, dedupeKey: `${target.type}:${target.id}` };
    },
    deliverPending: async ({ accountId, preparedTarget, pendingPayload }) => {
      const bot = getBotForAccount(accountId ?? "");
      const replyTarget: ReplyTarget = {
        scope: preparedTarget.type,
        targetId: preparedTarget.id,
      };
      try {
        const result = await bot.sendTextWithKeyboard(
          replyTarget,
          pendingPayload.text,
          pendingPayload.keyboard,
        );
        return {
          messageId: result.id,
          targetType: preparedTarget.type,
          targetId: preparedTarget.id,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to send approval message to ${preparedTarget.type}:${preparedTarget.id}: ${msg}`,
          { cause: err },
        );
      }
    },
  },
};

export const qqbotApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter(
  qqbotApprovalRuntimeSpec,
) as unknown as ChannelApprovalNativeRuntimeAdapter;
```

### Step 6: Write the failing test for `handler-runtime.ts`

Create `src/features/approval/handler-runtime.test.ts`:

```ts
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
    const out = await adapter.spec.presentation.buildPendingPayload({
      ctx: { cfg: {}, accountId: "a" },
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
    const resolved = await adapter.spec.presentation.buildResolvedResult({
      ctx: { cfg: {}, accountId: "a" },
      request: { id: "x", request: {} },
      resolved: { id: "x", decision: "allow-once" },
      view: {},
      entry: {},
    });
    const expired = await adapter.spec.presentation.buildExpiredResult({
      ctx: { cfg: {}, accountId: "a" },
      request: { id: "x", request: {} },
      view: {},
      entry: {},
    });
    expect(resolved).toEqual({ kind: "leave" });
    expect(expired).toEqual({ kind: "leave" });
  });

  it("deliverPending calls sendTextWithKeyboard with ReplyTarget and keyboard", async () => {
    const bot = { sendTextWithKeyboard };
    vi.mocked(getBotForAccount).mockReturnValue(bot as any);
    sendTextWithKeyboard.mockResolvedValue({ id: "msg1" });

    const adapter = qqbotApprovalNativeRuntime as any;
    await adapter.spec.transport.deliverPending({
      ctx: { cfg: {}, accountId: "a" },
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
```

### Step 7: Run both tests; iterate until they pass

```bash
cd /root/openclaw-qqbot
npx vitest run src/features/approval/capability.test.ts src/features/approval/handler-runtime.test.ts
```

Expected: PASS for both files.

### Step 8: Wire `approvalCapability` into `src/channel.ts`

Add to the top of `src/channel.ts`:

```ts
import { getQQBotApprovalCapability } from "./features/approval/capability.js";
```

Add a field to the `qqbotPlugin: ChannelPlugin<ResolvedQQBotAccount> = { ... }` object literal, near `groups:` / `messaging:` / `outbound:`:

```ts
  approvalCapability: getQQBotApprovalCapability(),
```

If `src/channel.ts` does not already export `qqbotPlugin` or has a different shape (read first), report BLOCKED with the diff.

### Step 9: Run typecheck and full test suite

```bash
cd /root/openclaw-qqbot
npx tsc --noEmit
npx vitest run
```

Expected: typecheck passes. New tests pass. Pre-existing test failures (8 files under `tests/` per the Task 1 report) reproduce — they are unrelated.

### Step 10: Commit

```bash
git add src/exec-approvals.ts \
        src/features/approval/capability.ts \
        src/features/approval/capability.test.ts \
        src/features/approval/handler-runtime.ts \
        src/features/approval/handler-runtime.test.ts \
        src/channel.ts
git commit -m "feat: add v2 approval capability and native runtime adapter"
```

---

## Task 4: Remove legacy approval-handler

**Files:**
- Delete: `src/features/approval-handler.ts`
- Delete: `src/features/approval-utils.ts`
- Modify: `src/gateway/lifecycle.ts` (remove approval-handler lines)
- Modify: `src/gateway/event-handlers.ts` (remove `handleApproval`)
- Modify: `src/adapter/gateway.ts` (remove `loadApprovalGatewayRuntime` + `ApprovalGatewayClient`)

- [ ] **Step 1: Verify `src/channel.ts` already imports `getQQBotApprovalCapability`**

The import + field were added in Task 3. Confirm by reading `src/channel.ts`:

```bash
grep -n "approvalCapability\|getQQBotApprovalCapability" /root/openclaw-qqbot/src/channel.ts
```

Expected: two matches — one for the import line and one for the field assignment. If only one or zero, re-add per Task 3 Step 8.

- [ ] **Step 2: Delete legacy files**

```bash
cd /root/openclaw-qqbot
git rm src/features/approval-handler.ts
git rm src/features/approval-utils.ts
```

- [ ] **Step 3: Edit `src/gateway/lifecycle.ts`**

Find lines that reference `QQBotApprovalHandler`, `registerApprovalHandler`, `unregisterApprovalHandler`, `getApprovalHandler`, or `approvalLog`, and remove the entire `register approval handler` block. Also remove the `import { QQBotApprovalHandler, ... } from '../features/approval-handler.js';` line if present.

Use `git grep` first to see what to remove:

```bash
cd /root/openclaw-qqbot
git grep -n "approval-handler\|QQBotApprovalHandler\|approvalLog" src/gateway/lifecycle.ts
```

Then delete those lines.

- [ ] **Step 4: Edit `src/gateway/event-handlers.ts`**

Remove `handleApproval` function (around lines 150-179 in the current main branch) and the import `import { getApprovalHandler } from '../features/approval-handler.js';`. Also remove the call to `handleApproval` at the bottom of `handleInteraction` (around line 99).

```bash
cd /root/openclaw-qqbot
git grep -n "handleApproval\|getApprovalHandler\|features/approval-handler" src/gateway/event-handlers.ts
```

Then delete those lines.

- [ ] **Step 5: Edit `src/adapter/gateway.ts`**

Remove the `loadApprovalGatewayRuntime` export and the `ApprovalGatewayClient` type. Also remove any `ApprovalGatewayClient` re-export from `approval-handler.ts` that referenced it.

```bash
cd /root/openclaw-qqbot
git grep -n "loadApprovalGatewayRuntime\|ApprovalGatewayClient" src/adapter/gateway.ts src/features/approval-handler.ts
```

After deletion (since `approval-handler.ts` is already deleted), only `src/adapter/gateway.ts` may have references. Delete the function and the type.

- [ ] **Step 6: Run typecheck**

```bash
cd /root/openclaw-qqbot
npx tsc --noEmit
```

Expected: PASS. If any leftover imports from `approval-handler.js` or `approval-utils.js` remain, remove them. Use `git grep` to find all consumers:

```bash
cd /root/openclaw-qqbot
git grep -n "features/approval-handler\|features/approval-utils" src
```

- [ ] **Step 7: Run full test suite**

```bash
cd /root/openclaw-qqbot
npx vitest run
```

Expected: all non-legacy tests pass. If any existing tests referenced `approval-handler` or `approval-utils`, delete them with `git rm` and note in the commit.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: remove legacy approval handler, wire v2 capability"
```

---

## Task 5: Documentation updates

**Files:**
- Modify: `CHANGELOG.zh.md` (add a fix entry)
- Modify: `README.zh.md` (drop the "审批功能降级" footnote if present)

- [ ] **Step 1: Inspect existing CHANGELOG.zh.md**

```bash
cd /root/openclaw-qqbot
head -30 CHANGELOG.zh.md
```

Find the unreleased / upcoming section. If none exists, prepend a new `## 未发布 / Unreleased` section at the top.

- [ ] **Step 2: Add a fix entry**

```markdown
### 修复 (Fixes)

- **审批按钮无法生效的问题**：迁移至 framework 的 v2 按钮协议 (`approve:v2:<kind>:<encodedId>:<decision>`)。点击"允许一次 / 始终允许 / 拒绝"按钮现在能正确将决策上报给 framework 并立即解除审批等待。最低 openclaw 版本要求提升至内置 `approval-delivery-runtime` 的版本；不再保留旧版 framework 的动态 import fallback。
```

Use the existing Chinese copy style of the file. Place the entry under the most recent changelog header.

- [ ] **Step 3: Inspect `README.zh.md` for "审批功能降级" or similar wording**

```bash
cd /root/openclaw-qqbot
grep -nE "审批|approval" README.zh.md
```

If a paragraph says "审批功能降级为不可用" (or similar), delete or rewrite it to reflect the new behavior. If the README correctly describes approval as enabled, leave it alone.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.zh.md README.zh.md
git commit -m "docs: changelog + readme for v2 approval migration"
```

---

## Self-Review Checklist

After all tasks are done, verify before declaring complete:

1. **Spec coverage:**
   - "v2 button data format with URL encoding" — Task 1.
   - `ChannelApprovalCapability` with auth + availability + delivery + nativeRuntime — Task 3.
   - Remove legacy `QQBotApprovalHandler` and `handleApproval` — Task 4.
   - Remove dynamic-import fallback — Task 4.
   - `buildResolvedResult` returns `{ kind: "leave" }` — Task 3.
   - Tests cover helpers, capability, and runtime — Tasks 1 and 3.
   - CHANGELOG + README updates — Task 5.

2. **No placeholders** — all steps have concrete code blocks or shell commands.

3. **Type consistency:**
   - `approvalId` / `approvalKind` / `decision` flow through `PendingApprovalView` → keyboard data → `parseApprovalButtonData` output.
   - `ApprovalKind` type alias used in helpers matches the SDK's `ChannelApprovalKind` (`"exec" | "plugin"`).
   - `resolveApprovalTarget` returns `{ type: ChatScope, id: string } | null` consistently in both helpers and runtime.

4. **No click-side ack** — `buildResolvedResult` returns `{ kind: "leave" }`; no `interactions.bindPending` implementation. ✓

5. **No legacy fallback** — `loadApprovalGatewayRuntime` deleted; `src/features/approval-handler.ts` deleted. ✓