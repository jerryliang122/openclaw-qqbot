/**
 * approval-resolve.test.ts 的 loader 钩子。
 *
 * 拦截 `openclaw/plugin-sdk/approval-gateway-runtime` 的动态导入，替换为
 * 委托到 globalThis.__mockResolveApprovalOverGateway 的 stub —— 这样测试能
 * 直接断言 handleInteraction 实际发出的调用参数，而不会真的连网关。
 *
 * 注意：load 钩子返回的源码键名是 `source`（不是 `code`），返回 `code` 会得到
 * source=undefined 的 ERR_INVALID_RETURN_PROPERTY_VALUE。
 */
export async function resolve(specifier, context, next) {
  if (specifier === 'openclaw/plugin-sdk/approval-gateway-runtime') {
    return { shortCircuit: true, url: 'mock:approval-gateway-runtime' };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === 'mock:approval-gateway-runtime') {
    return {
      shortCircuit: true,
      format: 'module',
      source:
        'export const resolveApprovalOverGateway = (...args) => globalThis.__mockResolveApprovalOverGateway(...args);',
    };
  }
  return next(url, context);
}
