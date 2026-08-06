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