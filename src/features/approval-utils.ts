/**
 * 审批 payload 判断逻辑。
 *
 * 仅保留 isApprovalPayload —— 用于在出站链路中识别审批类 payload，
 * 从而抑制框架侧重复的审批 prompt（native 审批由 approval-capability 处理）。
 */

/** 检查 payload 是否为审批消息（execApproval / plugin approval） */
export function isApprovalPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  const cd = p.channelData;
  if (cd && typeof cd === 'object' && !Array.isArray(cd)) {
    const execApproval = (cd as Record<string, unknown>).execApproval;
    if (execApproval && typeof execApproval === 'object' && !Array.isArray(execApproval)) {
      return true;
    }
  }
  const text = typeof p.text === 'string' ? p.text : '';
  return /(?:Plugin|Exec) approval (?:required|allowed|denied|expired)/i.test(text);
}
