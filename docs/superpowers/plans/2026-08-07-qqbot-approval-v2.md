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
- `src/bridge/approval/capability.ts` — `createQQBotApprovalCapability()` returning a `ChannelApprovalCapability`.
- `src/bridge/approval/capability.test.ts` — vitest unit tests for capability availability + delivery suppression.
- `src/bridge/approval/handler-runtime.ts` — `qqbotApprovalNativeRuntime` adapter implementing `ChannelApprovalNativeRuntimeSpec`.
- `src/bridge/approval/handler-runtime.test.ts` — vitest unit tests for the adapter's presentation + transport.

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

## Task 2: Wire `approvalCapability` into `channel.ts`

**Files:**
- Modify: `src/channel.ts` (one line added in the `qqbotPlugin` object literal)

**Interfaces:**
- Consumes: `getQQBotApprovalCapability` from Task 3 (not yet imported here — use the import shape `import { getQQBotApprovalCapability } from "./bridge/approval/capability.js";` once Task 3 lands).

- [ ] **Step 1: Add the import and field**

In `src/channel.ts`, locate the `qqbotPlugin: ChannelPlugin<ResolvedQQBotAccount> = { ... }` object literal and add (near `approvalCapability`-looking peers if any; otherwise before `groups:` or right after `config:`):

```ts
  approvalCapability: getQQBotApprovalCapability(),
```

Plus the import at the top:

```ts
import { getQQBotApprovalCapability } from "./bridge/approval/capability.js";
```

- [ ] **Step 2: Run typecheck to verify the import resolves (will FAIL until Task 3 lands)**

```bash
cd /root/openclaw-qqbot
npx tsc --noEmit
```

Expected at this stage: `error TS2307: Cannot find module './bridge/approval/capability.js'`. We accept this; Task 3 fixes it.

- [ ] **Step 3: Skip — defer the actual verification until Task 3**

No commit yet. Task 3 will be the first commit that compiles `channel.ts` end-to-end.

---

## Task 3: `bridge/approval/capability.ts` + `bridge/approval/handler-runtime.ts`

**Files:**
- Create: `src/bridge/approval/capability.ts`
- Create: `src/bridge/approval/handler-runtime.ts`

**Interfaces:**
- Consumes: pure helpers from Task 1.
- Produces:
  - `getQQBotApprovalCapability(): ChannelApprovalCapability` (cached singleton).
  - `qqbotApprovalNativeRuntime: ChannelApprovalNativeRuntimeAdapter` (lazy-loaded by `capability.ts`).

- [ ] **Step 1: Write the failing test for `capability.ts`**

Create `src/bridge/approval/capability.test.ts`:

```ts
import { describe, expect, it } from "vitest";

vi.mock("../../exec-approvals.js", () => ({
  resolveQQBotExecApprovalConfig: vi.fn(),
  isQQBotExecApprovalClientEnabled: vi.fn(),
  shouldHandleQQBotExecApprovalRequest: vi.fn(),
  authorizeQQBotApprovalAction: vi.fn(),
  matchesQQBotApprovalAccount: vi.fn(),
}));

import {
  resolveQQBotExecApprovalConfig,
  isQQBotExecApprovalClientEnabled,
  shouldHandleQQBotExecApprovalRequest,
  authorizeQQBotApprovalAction,
} from "../../exec-approvals.js";
import { resolveQQBotAccount } from "../config.js";
import { getQQBotApprovalCapability } from "./capability.js";

vi.mock("../config.js", () => ({
  resolveQQBotAccount: vi.fn(),
}));

const baseCfg = {} as any;

describe("getQQBotApprovalCapability", () => {
  it("reports enabled when QQBot account is enabled and secret is resolved", () => {
    vi.mocked(resolveQQBotExecApprovalConfig).mockReturnValue(undefined);
    vi.mocked(resolveQQBotAccount).mockReturnValue({
      enabled: true,
      secretSource: "config",
    } as any);

    const cap = getQQBotApprovalCapability();
    const state = cap.getActionAvailabilityState?.({ cfg: baseCfg, accountId: "a", action: "approve" });
    expect(state).toEqual({ kind: "enabled" });
  });

  it("reports disabled when QQBot account is disabled", () => {
    vi.mocked(resolveQQBotExecApprovalConfig).mockReturnValue(undefined);
    vi.mocked(resolveQQBotAccount).mockReturnValue({
      enabled: false,
      secretSource: "config",
    } as any);

    const cap = getQQBotApprovalCapability();
    const state = cap.getActionAvailabilityState?.({ cfg: baseCfg, accountId: "a", action: "approve" });
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

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /root/openclaw-qqbot
npx vitest run src/bridge/approval/capability.test.ts
```

Expected: FAIL with "Cannot find module './capability.js'".

- [ ] **Step 3: Implement `capability.ts`**

Create `src/bridge/approval/capability.ts`:

```ts
import { createChannelApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { resolveApprovalRequestSessionConversation } from "openclaw/plugin-sdk/approval-native-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveApprovalTarget } from "../../engine/approval/index.js";
import {
  isQQBotExecApprovalClientEnabled,
  matchesQQBotApprovalAccount,
  shouldHandleQQBotExecApprovalRequest,
  resolveQQBotExecApprovalConfig,
  authorizeQQBotApprovalAction,
} from "../../exec-approvals.js";
import { ensurePlatformAdapter } from "../bootstrap.js";
import { resolveQQBotAccount } from "../config.js";
import { getBridgeLogger } from "../logger.js";

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
  return isNativeDeliveryEnabled(params) ? { kind: "enabled" as const } : { kind: "disabled" as const };
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
        const result = isNativeDeliveryEnabled({ cfg: input.cfg, accountId });
        getBridgeLogger().debug?.(
          `[qqbot:approval] shouldSuppressForwardingFallback channel=${channel} accountId=${accountId} → ${result}`,
        );
        return result;
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
      isConfigured: ({ cfg, accountId }) => {
        const result = isNativeDeliveryEnabled({ cfg, accountId });
        getBridgeLogger().debug?.(
          `[qqbot:approval] nativeRuntime.isConfigured accountId=${accountId} → ${result}`,
        );
        return result;
      },
      shouldHandle: ({ cfg, accountId, request }) => {
        const result = shouldHandleRequest({ cfg, accountId, request: request as never });
        getBridgeLogger().debug?.(
          `[qqbot:approval] nativeRuntime.shouldHandle accountId=${accountId} → ${result}`,
        );
        return result;
      },
      load: async () => {
        ensurePlatformAdapter();
        return (await import("./handler-runtime.js"))
          .qqbotApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter;
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

NOTE on imports — the project may use different module paths:
- `../bootstrap.js`, `../config.js`, `../logger.js` — relative to `src/bridge/approval/`, so they resolve to `src/bridge/bootstrap.js`, `src/bridge/config.js`, `src/bridge/logger.js`. Verify these exist; rename if the actual filenames differ (e.g., `bootstrap.ts` compiled to `.js`).
- `../../engine/approval/index.js` — resolves to `src/engine/approval/index.ts` compiled.
- `../../exec-approvals.js` — resolves to `src/exec-approvals.ts` if it exists. If it does not exist in this plugin (the reference implementation has it; this plugin might not), use the inlined `authorizeQQBotApprovalAction` defined in the next bullet.

If `src/exec-approvals.ts` is missing in this plugin, create it as a thin shim:

```ts
// src/exec-approvals.ts
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveQQBotAccount } from "./bridge/config.js";

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
  const allowFrom = account.config?.allowFrom ?? [];
  if (allowFrom.length === 0 || allowFrom.includes("*")) {
    return { authorized: true };
  }
  return allowFrom.includes(params.senderId ?? "")
    ? { authorized: true }
    : { authorized: false, reason: "Sender is not in allowFrom." };
}

export function matchesQQBotApprovalAccount(_params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: unknown;
}): boolean {
  return true;
}
```

Adjust `account.config` shape and `resolveQQBotAccount` return type to match this plugin's actual types — read `src/bridge/config.ts` or wherever account resolution lives.

- [ ] **Step 4: Implement `handler-runtime.ts`**

Create `src/bridge/approval/handler-runtime.ts`:

```ts
import type { ChannelApprovalNativeRuntimeSpec } from "openclaw/plugin-sdk/approval-handler-runtime";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { resolveApprovalRequestSessionConversation } from "openclaw/plugin-sdk/approval-native-runtime";
import {
  buildApprovalKeyboard,
  buildExecApprovalText,
  buildPluginApprovalText,
  resolveApprovalTarget,
  type ApprovalDecision,
} from "../../engine/approval/index.js";
import { getMessageApi, accountToCreds } from "../../engine/messaging/sender.js";
import type { ChatScope, InlineKeyboard, MessageResponse } from "../../engine/types.js";
import {
  matchesQQBotApprovalAccount,
  resolveQQBotExecApprovalConfig,
  isQQBotExecApprovalClientEnabled,
  shouldHandleQQBotExecApprovalRequest,
} from "../../exec-approvals.js";
import { ensurePlatformAdapter } from "../bootstrap.js";
import { resolveQQBotAccount } from "../config.js";
import { getBridgeLogger } from "../logger.js";

type PendingPayload = { text: string; keyboard: InlineKeyboard };
type PreparedTarget = { type: ChatScope; id: string };
type PendingEntry = { messageId?: string; targetType: ChatScope; targetId: string };

function resolveQQTarget(request: { request: { sessionKey?: string | null; turnSourceTo?: string | null } }): PreparedTarget | null {
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
    const kind: ChatScope = sessionConversation.kind === "group" ? "group" : "c2c";
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
      const target = resolveQQTarget(request as { request: { sessionKey?: string | null; turnSourceTo?: string | null } });
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
      const allowedDecisions = (view.actions ?? []).map(
        (a) => a.decision as ApprovalDecision,
      );
      const keyboard = buildApprovalKeyboard(
        view.approvalId,
        view.approvalKind,
        allowedDecisions.length > 0 ? allowedDecisions : ["allow-once", "allow-always", "deny"],
      );
      return { text, keyboard };
    },
    buildResolvedResult: () => ({ kind: "leave" }),
    buildExpiredResult: () => ({ kind: "leave" }),
  },
  transport: {
    prepareTarget: ({ request }) => {
      const target = resolveQQTarget(request as { request: { sessionKey?: string | null; turnSourceTo?: string | null } });
      if (!target) return null;
      return { target, dedupeKey: `${target.type}:${target.id}` };
    },
    deliverPending: async ({ cfg, accountId, preparedTarget, pendingPayload }) => {
      ensurePlatformAdapter();
      const account = resolveQQBotAccount(cfg, accountId ?? undefined);
      const creds = accountToCreds(account);
      const messageApi = getMessageApi(account.appId);
      let result: MessageResponse;
      try {
        result = await messageApi.sendMessage(
          preparedTarget.type,
          preparedTarget.id,
          pendingPayload.text,
          creds,
          { inlineKeyboard: pendingPayload.keyboard },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to send approval message to ${preparedTarget.type}:${preparedTarget.id}: ${msg}`,
          { cause: err },
        );
      }
      return {
        messageId: result.id,
        targetType: preparedTarget.type,
        targetId: preparedTarget.id,
      };
    },
  },
};

export const qqbotApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter(
  qqbotApprovalRuntimeSpec,
) as unknown as ChannelApprovalNativeRuntimeAdapter;
```

NOTE: `getMessageApi` and `accountToCreds` come from `src/engine/messaging/sender.ts`. If this plugin does not have that file yet, look for the equivalent in `src/outbound/` or `src/bot-instance.ts`. The reference implementation has these; this plugin's `outbound/` may need a small adapter.

- [ ] **Step 5: Write the failing test for `handler-runtime.ts`**

Create `src/bridge/approval/handler-runtime.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../engine/messaging/sender.js", () => ({
  getMessageApi: vi.fn(),
  accountToCreds: vi.fn(),
}));
vi.mock("../../exec-approvals.js", () => ({
  resolveQQBotExecApprovalConfig: vi.fn().mockReturnValue(undefined),
  isQQBotExecApprovalClientEnabled: vi.fn().mockReturnValue(true),
  shouldHandleQQBotExecApprovalRequest: vi.fn(),
  matchesQQBotApprovalAccount: vi.fn().mockReturnValue(true),
}));
vi.mock("../bootstrap.js", () => ({ ensurePlatformAdapter: vi.fn() }));
vi.mock("../config.js", () => ({
  resolveQQBotAccount: vi.fn().mockReturnValue({ enabled: true, secretSource: "config", appId: "app" }),
}));

import { getMessageApi, accountToCreds } from "../../engine/messaging/sender.js";
import { qqbotApprovalNativeRuntime } from "./handler-runtime.js";

const sendMessage = vi.fn();

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

  it("deliverPending calls sendMessage with inlineKeyboard", async () => {
    vi.mocked(getMessageApi).mockReturnValue({ sendMessage } as any);
    vi.mocked(accountToCreds).mockReturnValue({} as any);
    sendMessage.mockResolvedValue({ id: "msg1" });

    const adapter = qqbotApprovalNativeRuntime as any;
    await adapter.spec.transport.deliverPending({
      ctx: { cfg: {}, accountId: "a" },
      preparedTarget: { type: "c2c", id: "U1" },
      request: { id: "x", request: {} },
      approvalKind: "exec",
      view: baseView,
      pendingPayload: { text: "hello", keyboard: { content: { rows: [{ buttons: [] }] } } as any },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "c2c",
      "U1",
      "hello",
      {},
      expect.objectContaining({ inlineKeyboard: expect.any(Object) }),
    );
  });
});
```

- [ ] **Step 6: Run both tests; iterate until they pass**

```bash
cd /root/openclaw-qqbot
npx vitest run src/bridge/approval/capability.test.ts src/bridge/approval/handler-runtime.test.ts
```

Expected: PASS for both files. If mocks fail because `vi` is not imported, prepend `import { vi } from "vitest";` to each test file.

- [ ] **Step 7: Run typecheck and full test suite**

```bash
cd /root/openclaw-qqbot
npx tsc --noEmit
npx vitest run
```

Expected: typecheck passes (or only fails in legacy tests we are about to delete). Existing tests pass; new tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/bridge/approval/capability.ts src/bridge/approval/capability.test.ts src/bridge/approval/handler-runtime.ts src/bridge/approval/handler-runtime.test.ts
git commit -m "feat: add v2 approval capability and native runtime adapter"
```

---

## Task 4: Wire capability into `channel.ts` and remove legacy code

**Files:**
- Modify: `src/channel.ts` (add `approvalCapability` field + import)
- Delete: `src/features/approval-handler.ts`
- Delete: `src/features/approval-utils.ts`
- Modify: `src/gateway/lifecycle.ts` (remove approval-handler lines)
- Modify: `src/gateway/event-handlers.ts` (remove `handleApproval`)
- Modify: `src/adapter/gateway.ts` (remove `loadApprovalGatewayRuntime` + `ApprovalGatewayClient`)

- [ ] **Step 1: Verify `src/channel.ts` already imports `getQQBotApprovalCapability`**

The import + field were added in Task 2. Confirm by reading `src/channel.ts`:

```bash
grep -n "approvalCapability\|getQQBotApprovalCapability" /root/openclaw-qqbot/src/channel.ts
```

Expected: two matches — one for the import line and one for the field assignment. If only one or zero, re-add per Task 2 Step 1.

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