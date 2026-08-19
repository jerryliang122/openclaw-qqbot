/**
 * QQBot 插件基础配置
 *
 * 参考 Telegram 插件的 createTelegramPluginBase
 */

import { qqbotSetupWizard } from './setup/surface.js';

export interface QQBotPluginBaseParams {
  setupWizard?: typeof qqbotSetupWizard;
}

export function createQQBotPluginBase(params: QQBotPluginBaseParams = {}) {
  const { setupWizard = qqbotSetupWizard } = params;

  return {
    id: 'qqbot' as const,
    meta: {
      id: 'qqbot',
      label: 'QQ Bot',
      selectionLabel: 'QQ Bot',
      docsPath: '/docs/channels/qqbot',
      blurb: 'Connect to QQ via official QQ Bot API',
      order: 50,
    },
    capabilities: {
      chatTypes: ['direct', 'group'] as const,
      media: true,
      reactions: false,
      threads: false,
    },
    setupWizard,
    reload: {
      configPrefixes: ['channels.qqbot'],
    },
    defaults: {
      queue: {
        debounceMs: 1000,
      },
    },
  };
}
