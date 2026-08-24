/**
 * QQBotGateway 事件处理
 *
 * 处理 SDK 的 message / interaction 事件：
 * - message: 中间件处理完毕后，将消息转发到 OpenClaw AI
 * - interaction: 配置更新 / 审批按钮 / ask_user 按钮
 */

import type { MiddlewareContext, QQBotInboundMessage, InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { ResolvedQQBotAccount } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import { dispatchToOpenClaw } from '../dispatch/index.js';
import { runWithRequestContext } from '../request-context.js';
import { authorizeQQBotApprovalAction } from '../features/approval-capability.js';
import { parseApprovalButtonData } from '../features/approval-helpers.js';
import {
  getQuestionGatewayRuntime,
  parseQuestionButtonData,
  parseMultiQuestionButtonData,
  parseKeyedAnswerText,
  recordMultiQuestionTap,
  mergeMultiQuestionTextAnswers,
  findPendingMultiQuestionByConversation,
  markMultiQuestionResolved,
  markMultiQuestionResolveFailed,
} from '../features/question-helpers.js';
import { recordKnownUser } from '../features/proactive.js';
import { cacheMsgId, getCachedMsgId } from '../features/msgid-cache.js';
import { getAdapters } from '../adapter/resolve.js';
import { resolveGroupConfigFromAccount, resolveGroupPolicy, resolveMentionPatterns } from '../config.js';
import { getPackageVersion } from '../utils/pkg-version.js';
import { stripMentionText, type MentionEntry } from '../utils/mention.js';
import { getOpenClawVersion, tryGetBotForAccount } from '../bot-instance.js';
import type { ParsedMultiQuestionAction } from '../features/question-helpers.js';

export async function handleMessage(
  ctx: MiddlewareContext,
  msg: QQBotInboundMessage,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
): Promise<void> {
  const hlog = log.child('handle');
  const scope = msg.replyTarget.scope;
  const targetId = scope === 'group'
    ? `qqbot:group:${msg.replyTarget.targetId}`
    : `qqbot:c2c:${msg.replyTarget.targetId}`;

  const mergedCount = (ctx.state.mergedMessages as unknown[] | undefined)?.length;
  // 注意：mergedCount 目前始终为 undefined，因为已移除 concurrencyGuard 中间件
  // 保留此日志以便未来调试或恢复消息合并功能
  if (mergedCount) {
    hlog.info(`merged batch count=${mergedCount} msgId=${msg.messageId}`);
  } else {
    hlog.debug(`enter msgId=${msg.messageId} scope=${scope} contentLen=${(msg.content ?? '').length}`);
  }

  try {
    cacheMsgId(scope, msg.replyTarget.targetId, msg.messageId);

    recordKnownUser({
      type: scope === 'group' ? 'group' : 'c2c',
      openid: scope === 'group' ? msg.replyTarget.targetId : msg.senderId,
      accountId: account.accountId,
      nickname: msg.senderName,
      lastInteractionAt: Date.now(),
    });

    // ── 多问题 ask_user 的文字答案拦截（按钮 + 文字混合作答）──
    // 仅当该会话存在进行中的多问题按钮单、且文本严格是 "题号: 内容" 格式
    // 且全部能合法匹配题目时才消费；否则原样放行，闲聊不受影响。
    if (await tryConsumeMultiQuestionTextAnswer(msg, account, runtime, log)) {
      hlog.debug(`done msgId=${msg.messageId} (consumed as multi-question answer)`);
      return;
    }

    await runWithRequestContext(
      {
        accountId: account.accountId,
        messageId: msg.messageId,
        openId: msg.senderId,
        target: targetId,
      },
      () => dispatchToOpenClaw(ctx, msg, account, runtime, log),
    );
  } catch (err) {
    hlog.error(`dispatch error: ${err}`);
  }
  hlog.debug(`done msgId=${msg.messageId}`);
}

/**
 * 尝试把一条入站文字消息消费为多问题 ask_user 的（部分）答案。
 * 返回 true 表示消息已被消费（调用方不应再走正常派发）。
 */
async function tryConsumeMultiQuestionTextAnswer(
  msg: QQBotInboundMessage,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
): Promise<boolean> {
  try {
    const scope = msg.replyTarget.scope;
    if (scope !== 'c2c' && scope !== 'group') return false;
    // 带附件 / 斜杠命令的消息不作答案处理
    if (msg.attachments?.length) return false;
    const rawText = msg.content?.trim() ?? '';
    if (!rawText || rawText.startsWith('/')) return false;
    // 群聊指令按钮预填会产生 @bot 前缀，先剥掉
    const text = stripMentionText(rawText, msg.mentions as MentionEntry[] | undefined).trim();
    if (!text) return false;

    const pending = findPendingMultiQuestionByConversation(scope, msg.replyTarget.targetId);
    if (!pending) return false;

    const entries = parseKeyedAnswerText(text);
    if (!entries) return false;

    const merged = mergeMultiQuestionTextAnswers(pending.questionId, entries);
    if (merged.status === 'buffered') {
      const pendingTitles = merged.pendingQuestions.map((q) => q.header);
      log.debug(`[question] text answer buffered id=${pending.questionId} answered=${merged.answeredCount}/${merged.total}`);
      await sendMultiQuestionFeedbackText(
        scope,
        msg.replyTarget.targetId,
        account,
        `✅ 已记录 ${merged.answeredCount}/${merged.total}\n还剩：${pendingTitles.join('、')}`,
      );
      return true;
    }
    if (merged.status === 'complete') {
      await dispatchMultiQuestionAnswer(
        merged.replyText,
        pending.questionId,
        scope,
        msg.replyTarget.targetId,
        msg.senderId,
        account,
        runtime,
        log,
      );
      return true;
    }
    // unknown/terminal/resolving/nomatch：一律放行走正常路径
    return false;
  } catch (err) {
    log.error(`[question] text answer intercept error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

const INTERACTION_QUERY  = 2001;
const INTERACTION_UPDATE = 2002;

export async function handleInteraction(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
  acknowledgeInteraction: (id: string, code?: number, data?: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  if (event.data?.type === INTERACTION_QUERY) {
    await handleConfigQuery(event, account, runtime, log, acknowledgeInteraction);
    return;
  }
  if (event.data?.type === INTERACTION_UPDATE) {
    await handleConfigUpdate(event, account, runtime, log);
    try {
      const adapters = getAdapters(runtime);
      const cfg = adapters.getConfig?.() ?? {};
      const groupOpenid = (event as any).group_openid ?? '';
      const updatedCfg = groupOpenid ? resolveGroupConfigFromAccount(account, groupOpenid) : null;
      const requireMention = updatedCfg?.requireMention ?? true;
      const clawCfg = buildClawCfg(requireMention, [], resolveGroupPolicy(cfg, account.accountId));
      await acknowledgeInteraction(event.id, 0, { claw_cfg: clawCfg });
    } catch {
      try { await acknowledgeInteraction(event.id); } catch { /* ignore */ }
    }
    return;
  }

  // question 按钮（ask_user，含单问题 qqbot:q: 与多问题 qqbot:qm:）优先于审批按钮
  const buttonData = event.data?.resolved?.button_data;
  if (buttonData?.startsWith('qqbot:q:') || buttonData?.startsWith('qqbot:qm:')) {
    await handleQuestion(event, account, runtime, log, acknowledgeInteraction);
    return;
  }

  await handleApproval(event, account, runtime, log, acknowledgeInteraction);
}

// ── Interaction 子处理 ──

async function handleConfigQuery(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
  ack: (id: string, code?: number, data?: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const groupOpenid = (event as any).group_openid ?? '';
  try {
    const adapters = getAdapters(runtime);
    const cfg = adapters.getConfig?.() ?? {};
    const groupCfg = groupOpenid ? resolveGroupConfigFromAccount(account, groupOpenid) : null;
    const requireMention = groupCfg?.requireMention ?? true;
    const agentId = groupOpenid
      ? adapters.resolveAgentRoute?.({ cfg, channel: 'qqbot', accountId: account.accountId, peer: { kind: 'group', id: groupOpenid } })?.agentId
      : undefined;
    const mentionPatterns = resolveMentionPatterns(cfg, agentId);
    const clawCfg = buildClawCfg(requireMention, mentionPatterns, resolveGroupPolicy(cfg, account.accountId));
    log.info(`interaction query: group=${groupOpenid} requireMention=${requireMention}`);
    await ack(event.id, 0, { claw_cfg: clawCfg });
  } catch (err) {
    log.warn(`interaction query failed: ${(err as Error)?.message ?? err}, ack without data`);
    try { await ack(event.id); } catch { /* ignore */ }
  }
}

async function handleConfigUpdate(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
): Promise<void> {
  const resolved = (event.data as any)?.resolved;
  const update = resolved?.claw_cfg;
  const groupOpenid = (event as any).group_openid ?? '';

  if (update?.require_mention !== undefined && groupOpenid) {
    try {
      await setGroupRequireMention(runtime, account.accountId, groupOpenid, update.require_mention === 'mention');
      log.info(`interaction: group=${groupOpenid} requireMention=${update.require_mention}`);
    } catch (err) {
      log.error(`interaction update failed: ${err}`);
    }
  }
}

async function handleApproval(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
  ack: (id: string) => Promise<void>,
): Promise<void> {
  try { await ack(event.id); } catch { /* ignore */ }

  const buttonData = event.data?.resolved?.button_data;
  if (!buttonData?.startsWith('approve:')) return;

  const parsed = parseApprovalButtonData(buttonData);
  if (!parsed) return;

  // Live config snapshot so allowFrom changes apply without a restart.
  // getConfig returns `any` — keep it untyped here to avoid crossing the
  // project's hand-written ambient SDK types with the real SDK types.
  const cfg = getAdapters(runtime).getConfig?.() ?? {};

  // 身份授权校验：操作者需在 allowFrom 白名单中
  const operatorId = resolveOperatorId(event);
  const authorization = authorizeQQBotApprovalAction({
    cfg,
    accountId: account.accountId,
    senderId: operatorId,
  });
  if (!authorization.authorized) {
    log.warn(`[approval] unauthorized operator=${operatorId ?? 'unknown'} account=${account.accountId}${authorization.reason ? ` reason=${authorization.reason}` : ''}`);
    return;
  }

  try {
    const { resolveApprovalOverGateway } = await import('openclaw/plugin-sdk/approval-gateway-runtime');
    await resolveApprovalOverGateway({
      cfg,
      approvalId: parsed.approvalId,
      decision: parsed.decision,
      senderId: operatorId,
      clientDisplayName: 'QQBot Approval Handler',
    });
  } catch (err) {
    log.error(`interaction approve error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Question 按钮处理（ask_user）──

async function handleQuestion(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
  ack: (id: string) => Promise<void>,
): Promise<void> {
  try { await ack(event.id); } catch { /* ignore */ }

  const buttonData = event.data?.resolved?.button_data;
  if (!buttonData) return;

  const parsed = parseQuestionButtonData(buttonData);
  if (!parsed) {
    const multiParsed = parseMultiQuestionButtonData(buttonData);
    if (multiParsed) {
      await handleMultiQuestionTap(multiParsed, event, account, runtime, log);
    }
    return;
  }

  // 无授权检查：ask_user 问题面向所有参与者（与审批不同，question 不是安全敏感操作）。
  // 框架侧 questionGatewayRuntime.resolveOption 已处理过期/重复提交等边界情况。
  const operatorId = resolveOperatorId(event);
  const cfg = getAdapters(runtime).getConfig?.() ?? {};

  try {
    const questionGatewayRuntime = await getQuestionGatewayRuntime();
    if (!questionGatewayRuntime) {
      throw new Error('OpenClaw host does not export question-gateway-runtime (requires 2026.8.1+)');
    }
    const result = await questionGatewayRuntime.resolveOption({
      cfg,
      questionId: parsed.questionId,
      optionIndex: parsed.optionIndex,
      senderId: operatorId,
      clientDisplayName: 'QQBot question',
    });
    log.debug(`[question] resolved questionId=${parsed.questionId} optionIndex=${parsed.optionIndex} status=${result.status}`);
  } catch (err) {
    log.error(`[question] resolve error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 多问题按钮处理（ask_user questions >= 2）──
// 框架对多问题记录没有按钮解析通道（question.resolve 只接受整单提交，
// resolveOption 仅支持单问题），这里按题缓冲点选，集齐后把
// "1: 3\n2: 1" 这样的合成回复当作普通用户消息走入站通道，
// 由框架的文本应答解析器（claimPendingAgentQuestionAnswer）完成 resolve。

async function handleMultiQuestionTap(
  parsed: ParsedMultiQuestionAction,
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
): Promise<void> {
  const operatorId = resolveOperatorId(event);
  const scope: 'group' | 'c2c' = event.group_openid ? 'group' : 'c2c';
  const peerId = (scope === 'group' ? event.group_openid : event.user_openid) ?? '';
  if (!peerId) return; // 缺少会话定位信息，无法回执或合成派发

  const tap = recordMultiQuestionTap(parsed.questionId, parsed.questionIndex, parsed.optionIndex);

  if (tap.status === 'unknown' || tap.status === 'terminal') {
    log.debug(`[question] multi tap ignored id=${parsed.questionId} status=${tap.status}`);
    await sendMultiQuestionFeedback(event, account, '该问题已提交或已过期');
    return;
  }
  if (tap.status === 'resolving') {
    log.debug(`[question] multi tap dropped while resolving id=${parsed.questionId}`);
    return;
  }
  if (tap.status === 'buffered') {
    const pendingTitles = tap.pendingQuestions.map((q) => q.header);
    log.debug(`[question] multi buffered id=${parsed.questionId} answered=${tap.answeredCount}/${tap.total}`);
    await sendMultiQuestionFeedback(
      event,
      account,
      `✅ 已记录 ${tap.answeredCount}/${tap.total}\n还剩：${pendingTitles.join('、')}`,
    );
    return;
  }
  // 按钮点选路径不会产生 nomatch（选项序号来自键盘本身）
  if (tap.status !== 'complete') return;

  // complete：合成一条用户文本回复走入站通道
  await dispatchMultiQuestionAnswer(
    tap.replyText,
    parsed.questionId,
    scope,
    peerId,
    operatorId,
    account,
    runtime,
    log,
  );
}

/**
 * 把集齐的多问题答案合成为一条"用户文本回复"并入站派发。
 * messageId 优先取该会话最近的真实 msg_id（msgid-cache），让后续回复
 * 能挂被动引用；取不到时留空，回复走主动发送。
 */
async function dispatchMultiQuestionAnswer(
  replyText: string,
  questionId: string,
  scope: 'c2c' | 'group',
  peerId: string,
  senderId: string | undefined,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
): Promise<void> {
  const syntheticMsg: QQBotInboundMessage = {
    rawEventType: scope === 'group' ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE',
    kind: scope,
    senderId: senderId ?? peerId,
    senderName: undefined,
    content: replyText,
    messageId: getCachedMsgId(scope, peerId) || '',
    timestamp: new Date().toISOString(),
    replyTarget: { scope, targetId: peerId },
    raw: {},
  } as unknown as QQBotInboundMessage;
  const syntheticCtx = {
    message: syntheticMsg,
    replyTarget: syntheticMsg.replyTarget,
    state: {},
    signal: undefined,
  } as unknown as MiddlewareContext;

  const qualifiedTarget = scope === 'group' ? `qqbot:group:${peerId}` : `qqbot:c2c:${peerId}`;
  try {
    await runWithRequestContext(
      {
        target: qualifiedTarget,
        accountId: account.accountId,
        messageId: syntheticMsg.messageId || undefined,
        openId: senderId,
      },
      () => dispatchToOpenClaw(syntheticCtx, syntheticMsg, account, runtime, log.child('questionDispatch')),
    );
    markMultiQuestionResolved(questionId);
    log.debug(`[question] multi answer dispatched id=${questionId}`);
  } catch (err) {
    markMultiQuestionResolveFailed(questionId);
    log.error(`[question] multi dispatch error: ${err instanceof Error ? err.message : String(err)}`);
    await sendMultiQuestionFeedbackText(scope, peerId, account, '⚠️ 提交失败，请重新点选或直接文字回复');
  }
}

/** 尽力而为的状态回执（主动消息），失败仅记日志不影响主流程 */
async function sendMultiQuestionFeedback(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  text: string,
): Promise<void> {
  const scope = event.group_openid ? 'group' as const : 'c2c' as const;
  const targetId = event.group_openid ?? event.user_openid;
  if (!targetId) return;
  await sendMultiQuestionFeedbackText(scope, targetId, account, text);
}

async function sendMultiQuestionFeedbackText(
  scope: 'c2c' | 'group',
  targetId: string,
  account: ResolvedQQBotAccount,
  text: string,
): Promise<void> {
  const bot = tryGetBotForAccount(account.accountId);
  if (!bot) return;
  try {
    await bot.sendText({ scope, targetId }, text);
  } catch {
    // 主动消息可能触发平台限频；回执是锦上添花，吞掉即可
  }
}

const CHANNEL_VER = getPackageVersion();

// ── 审批授权校验 ──

/**
 * 从交互事件中提取操作者身份标识。
 * QQ Bot 按钮回调事件中，操作者 openid 通常在 `user_openid` 或 `data.resolved.user_id` 字段。
 */
function resolveOperatorId(event: InteractionEvent): string | undefined {
  const evt = event as any;
  return evt.user_openid
    ?? evt.data?.resolved?.user_id
    ?? evt.data?.resolved?.user_openid
    ?? evt.openid;
}

function buildClawCfg(
  requireMention: boolean,
  mentionPatterns: string[],
  groupPolicy: string,
): Record<string, unknown> {
  return {
    channel_type: 'qqbot',
    channel_ver: CHANNEL_VER,
    claw_type: 'openclaw',
    claw_ver: getOpenClawVersion(),
    require_mention: requireMention ? 'mention' : 'always',
    group_policy: groupPolicy,
    mention_patterns: mentionPatterns.join(','),
    online_state: 'online',
  };
}

// ── Config 写入 ──

function setGroupRequireMention(
  runtime: PluginRuntime,
  accountId: string,
  groupOpenid: string,
  requireMention: boolean,
): Promise<void> {
  const adapters = getAdapters(runtime);
  return adapters.persistConfig?.((cfg: any) => {
    const qqbot = (cfg.channels ?? {})?.qqbot ?? {};
    const groups = accountId !== 'default' && qqbot.accounts?.[accountId]
      ? (qqbot.accounts[accountId].groups = { ...qqbot.accounts[accountId].groups })
      : (qqbot.groups = { ...qqbot.groups });
    groups[groupOpenid] = { ...groups[groupOpenid], requireMention };
  }) ?? Promise.resolve();
}
