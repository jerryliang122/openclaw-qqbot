/**
 * 消息转发 — 入站消息 → OpenClaw AI
 *
 * 核心职责：
 * 1. 从 SDK MiddlewareContext 构建 OpenClaw 标准信封
 * 2. 通过 runtime-adapter 将消息交给 AI 处理
 *
 * 架构说明：
 * - 所有 runtime.channel.* 访问均通过 runtime-adapter 隔离
 * - log: 前缀由 PluginLogger + 框架自动注入，消息体不重复 accountId
 */
import type { MiddlewareContext, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { ResolvedQQBotAccount } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import { buildEnvelope } from './envelope-builder.js';
import { assembleBody, type AssembledBody } from './body-assembler.js';
import { sendText, getGateway } from '../outbound/outbound-service.js';
import { sendMedia } from '../outbound/media-send.js';
import { deliverReply, type DeliverPayload, type DeliverInfo, type DeliverContext } from '../outbound/deliver-pipeline.js';
import { buildCtxPayload } from './ctx-builder.js';

import { DeliverDebouncer } from '../outbound/debounce.js';
import { StreamingController, shouldUseStreaming } from '../outbound/streaming-controller.js';
import { getAdapters } from '../adapter/resolve.js';
import { clearGroupHistory } from '../features/history-store.js';
import { isAskUserPayload, buildQuestionKeyboard } from '../features/question-helpers.js';
import { tryGetBotForAccount } from '../bot-instance.js';

/** 失败兜底文案（对齐 telegram：Something went wrong while processing your request.） */
const FAILURE_FALLBACK_TEXT = 'Something went wrong while processing your request. Please try again.';

/**
 * 合并 AbortSignal（Node >= 20.3 使用 AbortSignal.any，低版本退回首个 signal）。
 * turnAdoptionLifecycle 的 pre-adoption abort 需要与请求级 signal 共同生效。
 */
function combineAbortSignals(
  requestSignal: AbortSignal | undefined,
  turnSignal: AbortSignal,
): AbortSignal {
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') {
    return any.call(AbortSignal, requestSignal ? [requestSignal, turnSignal] : [turnSignal]);
  }
  return requestSignal ?? turnSignal;
}


/**
 * 将经过中间件处理的入站消息转发给 OpenClaw AI
 */
export async function dispatchToOpenClaw(
  ctx: MiddlewareContext,
  msg: QQBotInboundMessage,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log?: PluginLogger,
): Promise<void> {
  const dlog = log?.child('dispatch');
  const adapters = getAdapters(runtime, dlog);
  const envelope = buildEnvelope(ctx, msg, account);

  dlog?.debug(`received sender=${envelope.senderId} scope=${envelope.chatScope} msgId=${envelope.messageId}`);

  if (!adapters.dispatchReply) {
    dlog?.error(`runtime adapter dispatchReply not available (openclaw=${adapters.version})`);
    return;
  }

  const assembled: AssembledBody =
    ((ctx.state as Record<string, unknown>).assembledBody as AssembledBody | undefined) ??
    assembleBody(ctx, msg, account);

  const cfg = adapters.getConfig?.() ?? {};

  const isGroup = envelope.chatScope === 'group';

  // 群聊/私聊差异化 sessionKey：
  // - 群聊：使用 group:{groupId}:coalescing 后缀，表明消息已经过合并处理
  // - 私聊：保持原有格式，允许用户"插嘴"（新消息取消旧消息）
  const peerId = envelope.chatScope === 'group' 
    ? (envelope.groupId ?? envelope.senderId) 
    : envelope.senderId;

  const route = adapters.resolveAgentRoute?.({
    cfg,
    channel: 'qqbot',
    accountId: account.accountId,
    peer: {
      kind: envelope.chatScope === 'group' ? 'group' : 'direct',
      id: peerId,
    },
  }) ?? { 
    sessionKey: isGroup 
      ? `qqbot:${account.accountId}:group:${peerId}:coalescing`
      : `qqbot:${account.accountId}:${peerId}`, 
    accountId: account.accountId 
  };

  const qualifiedTarget = envelope.targetId;
  const agentId = route.agentId ?? 'default';
  const storePath = adapters.resolveStorePath?.((cfg as any)?.session?.store, { agentId }) ?? '';

  const ctxPayload = buildCtxPayload({ assembled, envelope, route, msg, ctx, adapters });

  const ttsRuntime = (runtime as any)?.tts ?? (runtime as any)?.channel?.runtimeContexts?.get?.('tts');

  const debounceConfig = account.config?.deliverDebounce;
  const debouncer = debounceConfig?.enabled !== false
    ? new DeliverDebouncer(debounceConfig, async (targetId, mergedText) => {
        const result = await sendText({ to: targetId, text: mergedText, accountId: account.accountId, replyToId: envelope.messageId, account });
        trackOutbound(result, 'debounce');
      })
    : undefined;

  const deliverCtx: DeliverContext = {
    qualifiedTarget,
    accountId: account.accountId,
    replyToId: envelope.messageId,
    chatScope: envelope.chatScope === 'group' ? 'group' : 'direct',
    cfg,
    debouncer: debouncer?.enabled ? debouncer : undefined,
    sendText: (to, text) => sendText({ to, text, accountId: account.accountId, replyToId: envelope.messageId, account })
      .then((result) => trackOutbound(result, 'deliverCtx.sendText')),
    sendMedia: (to, source, opts) => sendMedia({
      to,
      source,
      text: opts?.text ?? '',
      replyToId: envelope.messageId,
      accountId: account.accountId,
      agentId: route.agentId,
      log: deliverCtx.log,
    }).then((result) => trackOutbound(result, 'deliverCtx.sendMedia')),
    textToSpeech: ttsRuntime?.textToSpeech
      ? (params) => ttsRuntime.textToSpeech(params)
      : undefined,
    audioFileToSilkBase64: ttsRuntime?.audioFileToSilkBase64
      ? (audioPath: string) => ttsRuntime.audioFileToSilkBase64(audioPath)
      : undefined,
    log: log?.child('deliver'),
    agentId: route.agentId ?? 'default',
  };

  const streamingEnabled = shouldUseStreaming(
    account,
    envelope.chatScope === 'group' ? 'group' : 'c2c',
  );

  const streamingController = streamingEnabled
    ? createStreamingController(envelope, account, log?.child('streaming'))
    : null;

  if (streamingController) {
    dlog?.debug(`streaming enabled for ${envelope.senderId}`);
  }

  const deliveredMediaUrls = new Set<string>();
  const deliveredTexts = new Set<string>();
  let deliverErrorCount = 0;
  // 出站发送成功/失败计数：deliver-pipeline 对 sendText {error} 只记日志不抛错，
  // 这里在 dispatch 拥有的发送闭包边界上统计，作为"用户是否收到可见回复"的判据。
  let outboundSendOk = 0;
  let outboundSendFail = 0;
  const trackOutbound = <T extends { error?: string }>(result: T, via: string): T => {
    if (result.error) {
      outboundSendFail++;
      dlog?.error(`outbound send failed via ${via}: ${String(result.error)}`);
    } else {
      outboundSendOk++;
    }
    return result;
  };

  /**
   * deliver 回调（两个分支共用）。
   *
   * 失败语义（对齐 telegram）：捕获后计数并记录日志，不中断后续 payload；
   * dispatch 结束后若 (deliver 失败 || dispatch 抛错) 且用户未收到任何可见回复，
   * 发送兜底消息，避免静默失败。
   */
  const deliverHandler = async (payload: DeliverPayload, info?: DeliverInfo): Promise<void> => {
    try {
      const kind = (info as any)?.kind as string | undefined;
      const text = payload.text?.trim() ?? '';
      const hasMedia = !!(payload.mediaUrl || payload.mediaUrls?.length);
      dlog?.debug(`deliver kind=${kind ?? 'none'} textLen=${text.length} voice=${!!payload.audioAsVoice} media=${hasMedia}`);

      // ── 0. ask_user 按钮投递（优先于所有其他处理）──
      // 单问题单选场景：用 inline keyboard 替代纯文本
      const payloadWithChannelData = payload as DeliverPayload & { channelData?: unknown };
      if (isAskUserPayload(payloadWithChannelData as any) && text) {
        const { questionId, optionValues } = (payloadWithChannelData as any).channelData.askUser;
        const keyboard = buildQuestionKeyboard(questionId, optionValues);
        const bot = tryGetBotForAccount(account.accountId);
        if (bot) {
          const replyTarget = {
            scope: envelope.chatScope === 'group' ? 'group' as const : 'c2c' as const,
            targetId: peerId,
          };
          try {
            await bot.sendTextWithKeyboard(replyTarget, text, keyboard as never);
            outboundSendOk++;
            dlog?.debug(`[question] sent ask_user with keyboard questionId=${questionId} options=${optionValues.length}`);
            return;
          } catch (err) {
            outboundSendFail++;
            dlog?.error(`[question] sendTextWithKeyboard failed: ${err instanceof Error ? err.message : String(err)}`);
            // fallback 到纯文本发送
          }
        }
      }

      // ── 1. block: 媒体/语音立即发送，文本留给流式 ──
      // 注：static 模式已显式 disableBlockStreaming:true，kind:'block' 不会再触发；
      // 此分支保留以兼容 stream 模式与未来变化。
      if (kind === 'block') {
        if (payload.audioAsVoice) {
          await deliverReply(payload, info, deliverCtx);
        } else {
          await forwardMediaUrls(payload, deliverCtx, deliveredMediaUrls, dlog);
        }
      }

      // ── 2. 流式路径：流式已启动且未降级 -> 跳过静态发送 ──
      if (streamingController?.hasStarted && !streamingController?.shouldFallbackToStatic) {
        if (streamingController.isStaticSendMode) {
          // static 模式：flush 主路径由 onToolStart 驱动（工具开始前，绕开 SDK
          // block streaming 的 coalescer，避免 minChars=800/idleMs=1000 buffer 延迟）。
          // 这里仅兜底：deliver(kind:'tool') 时再 flush 一次（controller 内部去重，
          // buffer 已空时 flushSegment 无副作用）。
          if (kind === 'tool') {
            await streamingController.flushSegment();
          }
          // static 模式不 finalize（finalize 会进入终态并造成后续丢失）
        } else if (kind !== 'block') {
          // stream 模式：tool/final 时收尾当前打字机流（原行为）
          await streamingController.finalize();
        }
        if (!streamingController.shouldFallbackToStatic) return;
        dlog?.warn(`streaming fallback to static`);
      }

      // ── 3. 文本去重：同文本已发过 -> 跳过 ──
      if (kind === 'final' && !hasMedia && text && deliveredTexts.has(text)) {
        return;
      }

      // ── 4. tool 媒体：立即转发（static 流式路径已在上方 flush 文本）──
      if (kind === 'tool') {
        await forwardMediaUrls(payload, deliverCtx, deliveredMediaUrls, dlog);
        return;
      }

      // ── 5. 默认路径：过滤已发媒体 + 发送 ──
      const filteredPayload = filterDeliveredMedia(payload, deliveredMediaUrls);
      await deliverReply(filteredPayload, info, deliverCtx);
      if (text) deliveredTexts.add(text);
    } catch (err) {
      deliverErrorCount++;
      dlog?.error(`deliver error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Turn adoption lifecycle（群聊/私聊差异化）：
  // - 私聊：exclusive 模式，新消息取消旧消息（用户可"插嘴"）
  // - 群聊：cancel-only 模式，不取消正在处理的任务（消息已由中间件合并）
  // - abortSignal：仅私聊时传递，用于取消正在处理的任务
  const turnAbort = new AbortController();
  const admission = isGroup ? 'cancel-only' as const : 'exclusive' as const;
  
  const turnAdoptionLifecycle = {
    admission,
    abortSignal: admission === 'exclusive' ? turnAbort.signal : undefined,
    onAdopted: () => {
      dlog?.debug(`turn adopted (${admission}) sessionKey=${route.sessionKey}`);
    },
    onDeferred: () => {
      if (admission === 'exclusive') {
        dlog?.debug(`turn deferred behind active turn sessionKey=${route.sessionKey}`);
      }
    },
    onAbandoned: () => {
      if (admission === 'exclusive') {
        dlog?.info(`turn abandoned (superseded) — aborting sessionKey=${route.sessionKey}`);
        turnAbort.abort();
      } else {
        dlog?.debug(`turn cancelled but continuing sessionKey=${route.sessionKey}`);
      }
    },
  };
  const combinedAbortSignal = admission === 'exclusive' 
    ? combineAbortSignals(ctx.signal, turnAbort.signal)
    : ctx.signal;

  let dispatchError: unknown;
  const hadDispatchError = () => dispatchError !== undefined;

  try {
    if (!adapters.inboundRun) {
      // 低版本：手动 session + dispatchReply 直调
      if (adapters.recordInboundSession) {
        try {
          await adapters.recordInboundSession({
            storePath,
            sessionKey: route.sessionKey,
            ctx: ctxPayload,
          });
        } catch { /* best-effort */ }
      }
      await adapters.dispatchReply!({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          deliver: deliverHandler,
        },
        replyOptions: {
          abortSignal: ctx.signal,
          runId: envelope.messageId,
          ...(streamingController?.isStaticSendMode
            ? {
                // 对齐 telegram 模式一：显式关掉 SDK block streaming，绕开 coalescer
                // （minChars=800/idleMs=1000 的 buffer 会造成文本延迟）。
                // 文本由 onPartialReply 累积，边界由 onToolStart 自己监听 flush。
                disableBlockStreaming: true,
                // 让 onToolStart 在 verbose 关闭时也能触发
                // （默认受 requiresToolSummaryVisibility 门控，verbose off 时不触发）
                allowToolLifecycleWhenProgressHidden: true,
                // 工具【开始执行前】触发：把已累积的上一段文本立即发出
                // （不等工具执行完，对齐 telegram prepareAnswerLaneForToolProgress）
                onToolStart: async () => { await streamingController.flushSegment(); },
              }
            : {}),
          ...(streamingController
            ? {
                onPartialReply: async (p: { text?: string }) => {
                  if (p.text) await streamingController.onPartialReply(p.text);
                },
                // 兜底：onToolStart 未覆盖的边界（如纯文本段切换、部分 provider 事件差异）
                // 仍由 onAssistantMessageStart 触发分段。stream 模式不传，保持原行为。
                onAssistantMessageStart: streamingController.isStaticSendMode
                  ? async () => { await streamingController.flushSegment(); }
                  : undefined,
              }
            : {}),
        },
      });
      if (streamingController && !streamingController.isTerminal) {
        await streamingController.finalize();
      }
      if (debouncer) await debouncer.flushAll();
    } else {
      await adapters.inboundRun!({
        channel: 'qqbot',
        accountId: route.accountId,
        raw: envelope,
        adapter: {
          ingest: (raw: any) => ({
            id: envelope.messageId,
            rawText: assembled.rawBody,
            textForAgent: assembled.agentBody,
            textForCommands: assembled.rawBody,
            raw,
          }),
          resolveTurn: (_input: unknown, _eventClass: unknown, _preflight: unknown) => ({
            channel: 'qqbot',
            accountId: route.accountId,
            routeSessionKey: route.sessionKey,
            storePath,
            ctxPayload,
            recordInboundSession: adapters.recordInboundSession,
            record: {
              onRecordError: (err: unknown) => {
                dlog?.error(`Session record error: ${err}`);
              },
            },
            runDispatchLifecycle: {
              // 同一 lifecycle 对象必须同时出现在 runDispatchLifecycle 与
              // replyOptions.turnAdoptionLifecycle（框架校验所有权一致性）。
              turnAdoptionLifecycle,
              onDispatchSkipped: (reason: string) => {
                dlog?.info(`dispatch skipped reason=${reason} sessionKey=${route.sessionKey}`);
              },
            },
            runDispatch: () => {
              return adapters.dispatchReply!({
                ctx: ctxPayload,
                cfg,
                dispatcherOptions: {
                  deliver: deliverHandler,
                },
                replyOptions: {
                  abortSignal: combinedAbortSignal,
                  runId: envelope.messageId,
                  turnAdoptionLifecycle,
                  ...(streamingController?.isStaticSendMode
                    ? {
                        // 对齐 telegram 模式一：显式关掉 SDK block streaming，绕开 coalescer
                        // （minChars=800/idleMs=1000 的 buffer 会造成文本延迟）。
                        // 文本由 onPartialReply 累积，边界由 onToolStart 自己监听 flush。
                        disableBlockStreaming: true,
                        // 让 onToolStart 在 verbose 关闭时也能触发
                        // （默认受 requiresToolSummaryVisibility 门控，verbose off 时不触发）
                        allowToolLifecycleWhenProgressHidden: true,
                        // 工具【开始执行前】触发：把已累积的上一段文本立即发出
                        // （不等工具执行完，对齐 telegram prepareAnswerLaneForToolProgress）
                        onToolStart: async () => { await streamingController.flushSegment(); },
                      }
                    : {}),
                  ...(streamingController
                    ? {
                        onPartialReply: async (p: { text?: string }) => {
                          if (p.text) await streamingController.onPartialReply(p.text);
                        },
                        // 兜底：block 信号未覆盖的边界（如部分 provider 不发 text_end）
                        // 仍由 onAssistantMessageStart 触发分段。stream 模式不传，保持原行为。
                        onAssistantMessageStart: streamingController.isStaticSendMode
                          ? async () => { await streamingController.flushSegment(); }
                          : undefined,
                      }
                    : {}),
                },
              });
            },
          }),
        },
      });
    }
  } catch (err) {
    dispatchError = err;
    dlog?.error(`dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  dlog?.debug(`dispatch completed sessionKey=${route.sessionKey}`);

  // 群消息回复后清空历史缓存（避免下次 @ 时重复组包）
  if (envelope.chatScope === 'group') {
    clearGroupHistory(account.accountId, envelope.groupId ?? envelope.senderId);
  }

  if (streamingController && !streamingController.isTerminal) {
    await streamingController.finalize();
  }

  if (debouncer) {
    await debouncer.flushAll();
  }

  // 失败兜底（对齐 telegram）：dispatch 抛错、deliver 抛错或底层发送失败，
  // 且用户未收到任何可见回复时，发送兜底消息而非静默失败。
  if ((hadDispatchError() || deliverErrorCount > 0 || outboundSendFail > 0) && !turnAbort.signal.aborted) {
    const streamedVisible = !!streamingController
      && streamingController.currentPhase !== 'failed'
      && (streamingController.currentPhase === 'done' || streamingController.hasSentChunks);
    const deliveredVisible =
      streamedVisible || outboundSendOk > 0 || deliveredMediaUrls.size > 0;
    if (!deliveredVisible) {
      dlog?.warn(
        `sending failure fallback (deliverErrors=${deliverErrorCount} sendFails=${outboundSendFail} dispatchError=${hadDispatchError()}) to ${qualifiedTarget}`,
      );
      try {
        const result = await sendText({
          to: qualifiedTarget,
          text: FAILURE_FALLBACK_TEXT,
          accountId: account.accountId,
          replyToId: envelope.messageId,
          account,
        });
        if (result.error) {
          dlog?.error(`failure fallback sendText failed: ${result.error}`);
        }
      } catch (err) {
        dlog?.error(`failure fallback failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 保持原有错误传播语义：错误上报给 event-handlers 记录日志
  if (hadDispatchError()) {
    throw dispatchError;
  }
}

function createStreamingController(
  envelope: ReturnType<typeof buildEnvelope>,
  account: ResolvedQQBotAccount,
  log?: PluginLogger,
): StreamingController | null {
  const gw = getGateway(account.accountId);
  if (!gw) {
    log?.error(`cannot enable streaming — gateway not running`);
    return null;
  }

  // sendMode: 默认 'stream'（QQ 流式打印机），可选 'static'（普通 sendText 收尾）
  const streamingCfg = account.config?.streaming as
    | { sendMode?: 'stream' | 'static' }
    | undefined;
  const sendMode = streamingCfg?.sendMode === 'static' ? 'static' : 'stream';

  // static 模式：finalize 收尾时用一条普通 sendText 发完整文本
  const sendStatic = sendMode === 'static'
    ? async (fullText: string) => {
        const result = await sendText({
          to: envelope.senderId,
          text: fullText,
          accountId: account.accountId,
          replyToId: envelope.messageId,
          account,
        });
        if (result.error) {
          log?.error(`static sendText failed: ${result.error}`);
        }
      }
    : undefined;

  return new StreamingController({
    gateway: gw,
    target: {
      scope: 'c2c',
      targetId: envelope.senderId,
      msgId: envelope.messageId,
    },
    accountId: account.accountId,
    replyToId: envelope.messageId,
    log,
    sendMode,
    sendStatic,
  });
}

// ── 辅助函数 ──

/** 提取 payload 中的媒体 URL 并逐个发送（去重） */
async function forwardMediaUrls(
  payload: DeliverPayload,
  ctx: DeliverContext,
  delivered: Set<string>,
  log?: PluginLogger,
): Promise<void> {
  const urls: string[] = [];
  if (payload.mediaUrls?.length) urls.push(...payload.mediaUrls);
  if (payload.mediaUrl && !urls.includes(payload.mediaUrl)) urls.push(payload.mediaUrl);
  const newUrls = urls.filter((u) => !delivered.has(u));
  for (const url of newUrls) {
    try {
      await sendMedia({
        to: ctx.qualifiedTarget,
        source: url,
        text: '',
        replyToId: ctx.replyToId,
        accountId: ctx.accountId,
        log: ctx.log,
        agentId: ctx.agentId,
      });
      delivered.add(url);
    } catch (err) {
      log?.error(`media forward failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** 过滤已发送的媒体 URL */
function filterDeliveredMedia(
  payload: DeliverPayload,
  delivered: Set<string>,
): DeliverPayload {
  if (delivered.size === 0) return payload;
  return {
    ...payload,
    mediaUrl: payload.mediaUrl && !delivered.has(payload.mediaUrl) ? payload.mediaUrl : undefined,
    mediaUrls: payload.mediaUrls?.filter((u) => !delivered.has(u)),
  };
}
