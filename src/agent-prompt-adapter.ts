/**
 * QQBot Agent Prompt 适配器
 *
 * 提供 inboundFormattingHints 等提示信息
 */

/**
 * QQBot Agent Prompt Adapter
 */
export const qqbotAgentPromptAdapter = {
  messageToolCapabilities: ({ cfg, accountId }: { cfg: any; accountId?: string }) => {
    return ['inlineButtons'];
  },

  inboundFormattingHints: ({ cfg, accountId }: { cfg: any; accountId?: string }) => {
    return {
      text_markup: 'markdown',
      rules: [
        'QQ Bot 原生支持 Markdown 渲染',
        '支持标题、列表、代码块、引用等',
        '不支持 HTML 标签',
        '媒体使用 https URL',
      ],
    };
  },
};
