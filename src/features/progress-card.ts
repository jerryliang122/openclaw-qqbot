/**
 * 进度卡片推送（openclaw progress_card → QQ）
 *
 * 框架侧：progress_card 工具的更新经 legacy plan 事件桥以
 * replyOptions.onPlanUpdate 回调下发（payload 只含 steps，不含 markdown note）。
 * 通道必须同时设置 suppressDefaultToolProgressMessages: true，否则用户未开
 * verbose 工具摘要时回调不转发（框架门控 requiresToolSummaryVisibility）。
 *
 * QQ 侧：无消息编辑 API（撤回仅 2 分钟且是删除；流式内已发送前缀也不可改），
 * 进度更新只能以**新消息**形态推送。策略：
 * - 里程碑推送：首次建卡立即推，后续仅在渲染内容变化且满足节流时推
 * - 只走被动回复（占触发消息 msg_id 的被动配额）；**绝不降级主动发送**
 *   ——主动预算（1000 条/天）留给 remind/cron 等真正需要主动触达的场景
 * - 配额保留：剩余被动额度 < 2 时跳过（为 typing 与最终回复保底）
 * - room_event 群不推（结构性沉默红线，由 dispatch 侧激活条件保证）
 *
 * 日志：每次推送/跳过打 [progress-card] INFO 并注明原因，事后取证靠它。
 */
import type { PluginLogger } from '../utils/plugin-logger.js';
import {
  checkAndConsumePassiveReplyQuota,
  getRemainingPassiveQuota,
} from './quota-manager.js';
import { estimateLabelWidth } from './question-helpers.js';

// ── 类型（对齐 SDK GetReplyOptions.onPlanUpdate payload，本地声明避免耦合）──

export type ProgressStepStatus = 'pending' | 'in_progress' | 'completed';

export interface ProgressPlanStep {
  step: string;
  status: ProgressStepStatus;
}

export interface ProgressPlanUpdatePayload {
  phase?: string;
  title?: string;
  explanation?: string;
  steps?: ProgressPlanStep[];
  source?: string;
}

// ── 常量 ──

/** 两次推送最小间隔 ms（默认 0 = 不节流，每次内容变化即推；首次建卡本就不受限） */
export const DEFAULT_PROGRESS_MIN_INTERVAL_MS = 0;
/**
 * 每轮最多推送条数（默认 Infinity = 不设上限）。实际天花板由被动配额红线
 * 决定：推送前剩余额度 ≥2 才消费，即私聊最多把 4 条额度耗到剩 1。
 */
export const DEFAULT_PROGRESS_MAX_PER_TURN = Number.POSITIVE_INFINITY;
/** 单条步骤文本最大显示宽度（全角=2，约 20 个汉字） */
const MAX_STEP_DISPLAY_WIDTH = 40;
/** explanation 单行最大显示宽度（约 30 个汉字） */
const MAX_EXPLANATION_DISPLAY_WIDTH = 60;
/** 完成项超过 3 个时折叠为"前面 N 项已完成"，展开最近 2 项 */
const MAX_EXPANDED_COMPLETED = 3;
const COLLAPSED_COMPLETED_KEEP = 2;
/** 待办项最多展开 3 条，其余折叠 */
const MAX_EXPANDED_PENDING = 3;
/** 推送前剩余被动额度下限（为 typing/最终回复保底） */
const MIN_REMAINING_PASSIVE_FOR_PROGRESS = 2;

// ── 渲染 ──

/** 按显示宽度截断，超宽追加省略号（口径同 buildButtonLabel） */
function truncateToDisplayWidth(text: string, maxWidth: number): string {
  if (estimateLabelWidth(text) <= maxWidth) return text;
  let truncated = '';
  let width = 0;
  for (const ch of text) {
    const w = estimateLabelWidth(ch);
    if (width + w > maxWidth - 2) break;
    truncated += ch;
    width += w;
  }
  return `${truncated.trimEnd()}…`;
}

/**
 * 渲染进度卡片为 QQ 文本消息。
 * 返回 null 表示无可见内容（卡片被清空 / 空 steps 且无 explanation）——调用方应跳过。
 *
 * 状态行序：折叠计数（如有）→ 最近完成项 → 进行中 → 待办（前 3 + 折叠）。
 * 步骤理论上按序推进，此排序在乱序状态下也能得到稳定可读的输出。
 */
export function renderProgressCardText(payload: ProgressPlanUpdatePayload): string | null {
  const src = payload ?? ({} as ProgressPlanUpdatePayload);
  const steps = (src.steps ?? [])
    .map((s) => ({
      step: String(s?.step ?? '').replace(/\s+/g, ' ').trim(),
      status: s?.status,
    }))
    .filter((s) => s.step);

  const explanation = String(src.explanation ?? '').replace(/\s+/g, ' ').trim();

  if (steps.length === 0) {
    if (!explanation) return null;
    return `📋 ${truncateToDisplayWidth(explanation, MAX_EXPLANATION_DISPLAY_WIDTH)}`;
  }

  const completed = steps.filter((s) => s.status === 'completed');
  const lines: string[] = [`📋 进度 ${completed.length}/${steps.length}`];

  if (completed.length > MAX_EXPANDED_COMPLETED) {
    lines.push(`✅ 前面 ${completed.length - COLLAPSED_COMPLETED_KEEP} 项已完成`);
  }
  const expandedCompleted = completed.length > MAX_EXPANDED_COMPLETED
    ? completed.slice(-COLLAPSED_COMPLETED_KEEP)
    : completed;
  for (const s of expandedCompleted) {
    lines.push(`✅ ${truncateToDisplayWidth(s.step, MAX_STEP_DISPLAY_WIDTH)}`);
  }

  for (const s of steps) {
    if (s.status === 'in_progress') {
      lines.push(`🔄 ${truncateToDisplayWidth(s.step, MAX_STEP_DISPLAY_WIDTH)}`);
    }
  }

  const pending = steps.filter((s) => s.status === 'pending');
  const expandedPending = pending.slice(0, MAX_EXPANDED_PENDING);
  for (const s of expandedPending) {
    lines.push(`⬜ ${truncateToDisplayWidth(s.step, MAX_STEP_DISPLAY_WIDTH)}`);
  }
  if (pending.length > MAX_EXPANDED_PENDING) {
    lines.push(`⬜ …另有 ${pending.length - MAX_EXPANDED_PENDING} 项待办`);
  }

  return lines.join('\n');
}

// ── 推送器（每轮会话一个实例，随 dispatch 闭包创建）──

export interface ProgressCardPusherDeps {
  accountId: string;
  /** 完整目标 qqbot:c2c:<openid> / qqbot:group:<gid>（send 闭包已绑定，此处仅供日志） */
  to: string;
  scope: 'c2c' | 'group';
  /** 被动锚点：触发本轮的消息 msg_id */
  replyToId: string;
  /**
   * 发送闭包：调用方必须以 quotaReserved: true 调 outbound sendText
   * （配额由本推送器原子预占，防止双记账）。
   */
  send: (text: string) => Promise<{ error?: string }>;
  log?: PluginLogger;
  minIntervalMs?: number;
  maxPerTurn?: number;
  /** 可注入时钟（测试用），默认 Date.now */
  now?: () => number;
}

export interface ProgressCardPusher {
  handlePlanUpdate(payload: ProgressPlanUpdatePayload): Promise<void>;
}

export function createProgressCardPusher(deps: ProgressCardPusherDeps): ProgressCardPusher {
  const minIntervalMs = Math.max(0, deps.minIntervalMs ?? DEFAULT_PROGRESS_MIN_INTERVAL_MS);
  const requestedMax = deps.maxPerTurn ?? DEFAULT_PROGRESS_MAX_PER_TURN;
  const maxPerTurn = requestedMax > 0 ? requestedMax : Number.POSITIVE_INFINITY;
  const capLabel = maxPerTurn === Number.POSITIVE_INFINITY ? '∞' : String(maxPerTurn);
  const now = deps.now ?? (() => Date.now());
  const info = (msg: string) => deps.log?.info(`[progress-card] ${msg}`);

  let pushedCount = 0;
  let lastPushAt = 0;
  /**
   * 上次**成功推送**的渲染文本。仅在推送成功时更新——被节流/配额跳过的
   * 内容不算"已见"，后续相同回调可重试（否则间隔窗口内的更新会永久丢失）。
   */
  let lastPushedText: string | null = null;

  return {
    async handlePlanUpdate(payload: ProgressPlanUpdatePayload): Promise<void> {
      const text = renderProgressCardText(payload);
      if (!text) {
        // 卡片被清空或空内容：不推"已清空"通知（噪音），静默跳过
        info('skip: no renderable content (card cleared or empty)');
        return;
      }
      if (text === lastPushedText) {
        return; // 与用户已见内容无变化，无需日志（高频静默路径）
      }

      // lastPushAt===0 表示本轮尚未尝试过（含首推失败后的间隔保护）
      const isInitialPush = lastPushAt === 0;
      if (!isInitialPush) {
        if (pushedCount >= maxPerTurn) {
          info(`skip: per-turn cap reached (${pushedCount}/${capLabel})`);
          return;
        }
        const sinceLast = now() - lastPushAt;
        if (sinceLast < minIntervalMs) {
          info(`skip: interval ${(minIntervalMs - sinceLast) / 1000 | 0}s to next push`);
          return;
        }
      }

      // 配额预检：剩余额度不足时跳过，绝不挤占最终回复的被动槽，
      // 也绝不降级主动发送（getRemaining 对过期 msg_id 返回 0，群 5min 窗自然生效）
      const remaining = getRemainingPassiveQuota({
        accountId: deps.accountId,
        msgId: deps.replyToId,
        scope: deps.scope,
      });
      if (remaining < MIN_REMAINING_PASSIVE_FOR_PROGRESS) {
        info(`skip: passive quota low (remaining=${remaining}, need>=${MIN_REMAINING_PASSIVE_FOR_PROGRESS})`);
        return;
      }
      const reservation = checkAndConsumePassiveReplyQuota({
        accountId: deps.accountId,
        msgId: deps.replyToId,
        scope: deps.scope,
      });
      if (!reservation.canReply) {
        info('skip: passive quota unavailable (expired or exhausted)');
        return;
      }

      let result: { error?: string };
      try {
        result = await deps.send(text);
      } catch (err) {
        reservation.rollback();
        lastPushAt = now(); // 失败也推进时间锚，避免下个更新立即重试连击
        info(`send threw: ${err instanceof Error ? err.message : String(err)} (quota rolled back)`);
        return;
      }
      if (result.error) {
        reservation.rollback();
        lastPushAt = now();
        info(`send failed: ${result.error} (quota rolled back)`);
        return;
      }

      pushedCount++;
      lastPushAt = now();
      lastPushedText = text;
      info(`pushed ${pushedCount}/${capLabel} to ${deps.to}`);
    },
  };
}
