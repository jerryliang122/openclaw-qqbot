import type {
  ExecApprovalPendingView,
  PendingApprovalView,
  PluginApprovalPendingView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { resolveExecApprovalCommandDisplay } from "openclaw/plugin-sdk/approval-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { InlineKeyboard, KeyboardButton } from "../types.js";

type ChatScope = "c2c" | "group";

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
  const m = sk.match(/qqbot:(c2c|direct|group):([A-Z0-9]+)/i);
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