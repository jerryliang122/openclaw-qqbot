/**
 * ask_user 按钮辅助函数
 *
 * 与 approval-helpers.ts 模式一致：
 * - buildQuestionKeyboard: 构建 inline keyboard
 * - parseQuestionButtonData: 解析 INTERACTION_CREATE 的 button_data
 * - isAskUserPayload: 判断 payload 是否为 ask_user
 */

import type { InlineKeyboard, KeyboardButton } from '../types.js';

// ============ Constants ============

const QUESTION_CALLBACK_PREFIX = 'qqbot:q:';

/** questionId 格式: ask_<32位hex> */
const QUESTION_ID_PATTERN = /^ask_[a-f0-9]{32}$/;

// ============ Types ============

export interface ParsedQuestionAction {
  questionId: string;
  optionIndex: number;
}

export interface QuestionGatewayRuntime {
  resolveOption: (params: {
    cfg: unknown;
    questionId: string;
    optionIndex: number;
    senderId?: string;
    gatewayUrl?: string;
    clientDisplayName?: string;
  }) => Promise<{ status: string }>;
}

let questionRuntimePromise: Promise<QuestionGatewayRuntime | null> | undefined;

/**
 * question gateway 是 OpenClaw 2026.8.1+ 的可选能力。
 * 旧版 host 不导出该 subpath，必须在发送按钮前完成能力探测，避免投递死按钮。
 */
export function getQuestionGatewayRuntime(): Promise<QuestionGatewayRuntime | null> {
  questionRuntimePromise ??= import('openclaw/plugin-sdk/question-gateway-runtime')
    .then((mod) => {
      const runtime = mod.questionGatewayRuntime as QuestionGatewayRuntime | undefined;
      return runtime && typeof runtime.resolveOption === 'function' ? runtime : null;
    })
    .catch(() => null);
  return questionRuntimePromise;
}

// ============ Payload Detection ============

/**
 * 判断 DeliverPayload 是否为 ask_user 单问题单选场景。
 * 要求：有 channelData.askUser.questionId，且 optionValues 长度 2-4。
 */
export function isAskUserPayload(payload: {
  channelData?: { askUser?: { questionId?: unknown; optionValues?: unknown } };
}): payload is { channelData: { askUser: { questionId: string; optionValues: string[] } } } {
  const askUser = payload.channelData?.askUser;
  if (!askUser || typeof askUser !== 'object') return false;
  const { questionId, optionValues } = askUser as { questionId?: unknown; optionValues?: unknown };
  return (
    typeof questionId === 'string' &&
    QUESTION_ID_PATTERN.test(questionId) &&
    Array.isArray(optionValues) &&
    optionValues.length >= 2 &&
    optionValues.length <= 4 &&
    optionValues.every((v: unknown) => typeof v === 'string')
  );
}

// ============ Keyboard Builder ============

/**
 * 为 ask_user 构建 inline keyboard。
 *
 * 与审批按钮结构完全一致：
 * - action.type=1 (回调型)
 * - permission.type=2 (所有人可点)
 * - click_limit=1 (每人一次)
 * - group_id="question" (互斥)
 *
 * button_data 格式: `qqbot:q:<questionId>:<optionIndex>`
 */
export function buildQuestionKeyboard(
  questionId: string,
  optionLabels: string[],
): InlineKeyboard {
  const buttons: KeyboardButton[] = optionLabels.map((label, index) => ({
    id: `q${index}`,
    render_data: {
      label,
      visited_label: '已回答',
      style: 1 as const,
    },
    action: {
      type: 1 as const,
      data: `${QUESTION_CALLBACK_PREFIX}${questionId}:${index}`,
      permission: { type: 2 as const },
      click_limit: 1,
    },
    group_id: 'question',
  }));

  return {
    content: {
      rows: [{ buttons }],
    },
  };
}

// ============ Button Data Parser ============

/**
 * 解析 INTERACTION_CREATE 事件中的 button_data。
 *
 * 格式: `qqbot:q:<questionId>:<optionIndex>`
 * 返回 null 表示不是 question 按钮。
 */
export function parseQuestionButtonData(buttonData: string): ParsedQuestionAction | null {
  if (!buttonData.startsWith(QUESTION_CALLBACK_PREFIX)) return null;

  const payload = buttonData.slice(QUESTION_CALLBACK_PREFIX.length);
  const sepIndex = payload.lastIndexOf(':');
  if (sepIndex <= 0) return null;

  const questionId = payload.slice(0, sepIndex);
  const indexStr = payload.slice(sepIndex + 1);

  if (!QUESTION_ID_PATTERN.test(questionId)) return null;
  if (!indexStr) return null; // 防止 'qqbot:q:ask_xxx:' 被解析为 index 0

  const optionIndex = Number(indexStr);
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 3) return null;

  return { questionId, optionIndex };
}
