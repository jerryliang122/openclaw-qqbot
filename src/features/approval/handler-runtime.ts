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
          pendingPayload.keyboard as unknown as Parameters<typeof bot.sendTextWithKeyboard>[2],
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