/**
 * QQBot Threading 适配器
 *
 * QQBot 不支持 thread/topic，提供基础实现
 */

/**
 * QQBot Threading Adapter
 */
export const qqbotThreadingAdapter = {
  resolveReplyToMode: ({ cfg, accountId }: { cfg: any; accountId?: string | null }) => {
    return 'off' as const;
  },

  buildToolContext: (params: any) => {
    return undefined;
  },

  resolveAutoThreadId: ({ to, toolContext }: { to: string; toolContext?: any }) => {
    return undefined;
  },
};
