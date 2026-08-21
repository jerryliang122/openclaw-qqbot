/**
 * QQBot Message 适配器
 *
 * 定义消息生命周期能力
 */

import { qqbotChannelOutbound } from './outbound-adapter.js';

/**
 * QQBot Message Adapter
 *
 * 能力声明：
 * - draftPreview: false (QQBot 不支持)
 * - previewFinalization: false
 * - progressUpdates: true (流式支持)
 * - finalEdit: false (QQBot 流式限制)
 */
export const qqbotMessageAdapter = {
  id: 'qqbot',
  live: {
    capabilities: {
      draftPreview: false,
      previewFinalization: false,
      progressUpdates: true,
    },
    finalizer: {
      capabilities: {
        finalEdit: false,
        normalFallback: true,
        previewReceipt: false,
        retainOnAmbiguousFailure: true,
      },
    },
  },
  receive: {
    defaultAckPolicy: 'after_agent_dispatch' as const,
    supportedAckPolicies: ['after_receive_record', 'after_agent_dispatch'] as const,
  },
  outbound: qqbotChannelOutbound,
};
