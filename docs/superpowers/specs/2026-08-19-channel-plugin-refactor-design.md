# QQBot Channel Plugin 重构设计文档

**日期**: 2026-08-19  
**分支**: `refactor/channel-plugin-standard`  
**目标**: 完全重构 QQBot 插件以符合 OpenClaw 最新 ChannelPlugin 规范

---

## 1. 背景

### 1.1 当前问题

当前 QQBot 插件 (`src/channel.ts`) 采用手动构建 `ChannelPlugin` 对象的方式，与 OpenClaw 最新规范存在显著差距：

1. **未使用标准构建器** - 未使用 `createChatChannelPlugin` 辅助函数
2. **缺少标准适配器** - 缺少 `message`, `agentPrompt`, `threading`, `heartbeat` 等标准适配器
3. **配额管理不完善** - 未正确处理被动回复配额与主动发送的降级逻辑
4. **Typing 机制缺失** - 未实现续期机制，浪费配额

### 1.2 参考实现

以 OpenClaw 官方 Telegram 插件 (`/root/openclaw/extensions/telegram/src/channel.ts`) 为标杆，采用其标准实现模式。

---

## 2. 重构方案

### 2.1 整体架构

**核心改动**：使用 `createChatChannelPlugin` 重构 `src/channel.ts`

**依赖关系**：
```
src/channel.ts (入口)
├── src/outbound-adapter.ts → 调用 src/outbound/
├── src/message-adapter.ts → 调用 src/outbound-adapter.ts
├── src/messaging-adapter.ts → 调用 src/config.ts
├── src/status-adapter.ts → 调用 src/gateway/ + src/features/
├── src/gateway-adapter.ts → 调用 src/gateway/lifecycle.ts
├── src/typing-lifecycle.ts → 管理 Typing 续期
├── src/features/quota-manager.ts → 配额管理
└── 现有模块保持不变
```

**新增模块**：
- `src/outbound-adapter.ts` - 出站消息适配器
- `src/message-adapter.ts` - 消息生命周期适配器
- `src/messaging-adapter.ts` - 会话路由适配器
- `src/status-adapter.ts` - 状态探测适配器
- `src/gateway-adapter.ts` - 网关启动适配器
- `src/typing-lifecycle.ts` - Typing 续期管理
- `src/features/quota-manager.ts` - 配额管理
- `src/types-plugin.ts` - 新增类型定义

**保留模块**：
- `src/gateway/` - 完全保留
- `src/outbound/` - 完全保留
- `src/features/` - 完全保留
- `src/utils/` - 完全保留
- `src/config.ts` - 保留账户解析逻辑

---

## 3. 关键接口设计

### 3.1 主入口重构

**重构前**：
```typescript
export const qqbotPlugin: ChannelPlugin<ResolvedQQBotAccount> = {
  id: 'qqbot',
  // ... 手动实现
};
```

**重构后**：
```typescript
export const qqbotPlugin = createChatChannelPlugin({
  base: {
    ...createQQBotPluginBase({
      setupWizard: qqbotSetupWizard,
      setupContract: qqbotSetupContract,
    }),
    
    message: qqbotMessageAdapter,
    messaging: qqbotMessagingAdapter,
    status: qqbotStatusAdapter,
    gateway: qqbotGatewayAdapter,
    outbound: qqbotChannelOutbound,
    
    agentPrompt: qqbotAgentPromptAdapter,
    heartbeat: qqbotHeartbeatAdapter,
    threading: qqbotThreadingAdapter,
    groups: qqbotGroupsAdapter,
    allowlist: qqbotAllowlistAdapter,
    
    approvalCapability: getQQBotApprovalCapability(),
    security: qqbotSecurityAdapter,
  },
  
  pairing: qqbotPairingAdapter,
});
```

---

### 3.2 配额管理机制

**被动回复配额**：
- C2C: 4 次/msg_id, 60 分钟有效期
- Group: 5 次/msg_id, 5 分钟有效期

**主动发送配额**：
- C2C: 10/qps (Bot 维度), 未认证 5/qps + 30/qpm
- Group: 60/qpm

**降级策略**：
1. 优先使用被动回复（更快、更可靠）
2. 配额耗尽后自动降级到主动发送
3. Typing 仅在配额充足时发送

**实现** (`src/features/quota-manager.ts`)：
```typescript
export async function checkPassiveReplyQuota(params: {
  accountId: string;
  msgId?: string;
  scope: 'c2c' | 'group';
}): Promise<boolean>

export async function consumePassiveReplyQuota(params: {
  accountId: string;
  msgId: string;
  scope: 'c2c' | 'group';
  log?: PluginLogger;
}): Promise<void>

export function inferQQBotScope(to: string): 'c2c' | 'group'
```

**配额缓存**：
- LRU 缓存，最多 10,000 条
- 自动过期清理（C2C: 60min, Group: 5min）

---

### 3.3 Typing 续期机制

**原理**：
- Typing 显示时长：60 秒
- 续期时机：50 秒后
- 最大续期次数：10 次（约 10 分钟）

**实现** (`src/typing-lifecycle.ts`)：
```typescript
export async function startTypingWithRenewal(params: {
  accountId: string;
  to: string;
  replyToId: string;
  log?: PluginLogger;
}): Promise<void>

export function stopTyping(params: {
  accountId: string;
  to: string;
  replyToId: string;
  log?: PluginLogger;
}): void
```

**配额感知**：
- 每次续期前检查配额
- 配额不足时停止续期
- Agent 完成时清理定时器

---

### 3.4 Outbound 适配器

**实现** (`src/outbound-adapter.ts`)：
```typescript
export const qqbotChannelOutbound = createQQBotOutboundAdapter({
  resolveSend: async () => sendText,
  
  beforeDeliverPayload: async ({ cfg, target, hint, payload }) => {
    // 配额感知发送
    const canPassiveReply = await checkPassiveReplyQuota({...});
    return canPassiveReply ? { mode: 'passive', msgId } : { mode: 'proactive' };
  },
  
  sendTypingWithQuota: async ({ to, accountId, replyToId }) => {
    // Typing 配额管理
  },
  
  shouldSuppressLocalPayloadPrompt: ({ payload }) => isApprovalPayload(payload),
  shouldTreatDeliveredTextAsVisible: ({ kind }) => kind !== 'final',
  preferFinalAssistantVisibleText: true,
});
```

---

### 3.5 Message 适配器

**实现** (`src/message-adapter.ts`)：
```typescript
export const qqbotMessageAdapter = createChannelMessageAdapterFromOutbound<OpenClawConfig>({
  id: 'qqbot',
  live: {
    capabilities: {
      draftPreview: false,
      previewFinalization: false,
      progressUpdates: true, // 流式支持
    },
    finalizer: {
      capabilities: {
        finalEdit: false, // QQBot 流式限制
        normalFallback: true,
        previewReceipt: false,
        retainOnAmbiguousFailure: true,
      },
    },
  },
  receive: {
    defaultAckPolicy: 'after_agent_dispatch',
    supportedAckPolicies: ['after_receive_record', 'after_agent_dispatch'],
  },
  outbound: qqbotChannelOutbound,
});
```

---

### 3.6 Messaging 适配器

**实现** (`src/messaging-adapter.ts`)：
```typescript
export const qqbotMessagingAdapter: ChannelMessagingAdapter = {
  targetPrefixes: ['qqbot'],
  normalizeTarget: (target: string) => normalizeTarget(target),
  resolveInboundConversation: ({ to, conversationId, threadId }) => {...},
  resolveDeliveryTarget: ({ conversationId, parentConversationId }) => {...},
  resolveSessionConversation: resolveQQBotSessionConversation,
  resolveSessionTarget: ({ kind, id }) => resolveQQBotSessionTarget({ kind, id }),
  inferTargetChatType: ({ to }) => resolveQQBotRouteTarget(to).chatType,
  targetResolver: {
    looksLikeId: isQQBotTarget,
    hint: 'QQ Bot 目标格式: qqbot:c2c:openid 或 qqbot:group:groupid',
  },
};
```

---

### 3.7 其他适配器

**agentPrompt 适配器**：
```typescript
agentPrompt: {
  messageToolCapabilities: ({ cfg, accountId }) => ['inlineButtons'],
  inboundFormattingHints: ({ cfg, accountId }) => ({
    text_markup: 'markdown',
    rules: ['QQ Bot 原生支持 Markdown 渲染'],
  }),
}
```

**heartbeat 适配器**：
```typescript
heartbeat: {
  sendTyping: async ({ to, accountId, replyToId }) => {
    // 调用 typing-lifecycle 模块
    await startTypingWithRenewal({ accountId, to, replyToId });
  },
}
```

**threading 适配器**：
```typescript
threading: {
  resolveReplyToMode: ({ cfg, accountId }) => 'off',
  buildToolContext: (params) => buildQQBotThreadingToolContext(params),
}
```

---

## 4. QQBot 特有限制处理

### 4.1 流式限制
- 仅支持 C2C 私聊
- 已发送的 prefix 不可修改
- 在 message adapter 中正确声明能力

### 4.2 被动回复配额
- C2C: 4 次/msg, 60 分钟
- Group: 5 次/msg, 5 分钟
- 在 outbound adapter 中处理配额逻辑

### 4.3 OpenID 命名空间
- 跨账号不通用
- 在 allowlist adapter 中正确处理

---

## 5. 测试策略

### 5.1 单元测试

**新增测试文件**：
- `tests/outbound-adapter.test.ts` - 出站适配器测试
- `tests/message-adapter.test.ts` - 消息适配器测试
- `tests/messaging-adapter.test.ts` - 会话路由测试
- `tests/status-adapter.test.ts` - 状态探测测试
- `tests/quota-manager.test.ts` - 配额管理测试
- `tests/typing-lifecycle.test.ts` - Typing 续期测试
- `tests/channel-plugin.test.ts` - 完整插件集成测试

### 5.2 测试重点

**配额管理测试**：
- C2C 被动回复配额：4 次后耗尽
- Group 被动回复配额：5 次后耗尽
- 配额过期后自动恢复
- 降级到主动发送

**Typing 续期测试**：
- 50 秒后续期
- 配额耗尽时停止续期
- Agent 完成时停止续期
- 最大续期次数限制

**适配器接口测试**：
- `createChatChannelPlugin` 构建正确
- 所有必需适配器存在
- 接口签名正确

### 5.3 集成测试

**端到端消息流**：
- 接收 → 处理 → 发送
- Typing 启动 → 续期 → 停止
- 配额降级场景

### 5.4 手动验证清单

| 功能 | 验证点 | 预期行为 |
|------|--------|----------|
| 消息接收 | C2C 私聊消息 | 正常接收并处理 |
| | 群聊消息 @机器人 | 正常接收并处理 |
| | 群聊消息未 @ | 根据 requireMention 配置 |
| 消息发送 | 被动回复 | 消耗配额 |
| | 主动发送 | 不消耗配额 |
| | 配额耗尽降级 | 自动切换 |
| Typing | C2C 私聊 | 显示 60 秒，50 秒后续期 |
| | 配额不足 | 不发送 |
| | Agent 完成 | 停止续期 |
| 流式回复 | C2C 私聊 | 正常流式 |
| | 群聊 | 不支持，降级 |
| 媒体消息 | 图片/视频/文件 | 正常发送 |
| 多账户 | 隔离 | OpenID 不互通，配额独立 |
| 状态监控 | 配额使用情况 | 在 status 中可见 |

### 5.5 性能与稳定性测试

**关键指标**：
- 配额缓存性能：< 1ms 查询延迟
- Typing 续期稳定性：无定时器泄漏
- 高并发场景：100 并发无竞态

---

## 6. 实施计划

### 阶段 1：基础设施 (1-2 天)
- 创建 `quota-manager.ts`
- 创建 `typing-lifecycle.ts`
- 创建 `types-plugin.ts`

### 阶段 2：适配器实现 (3-5 天)
- 创建 `outbound-adapter.ts`
- 创建 `message-adapter.ts`
- 创建 `messaging-adapter.ts`
- 创建 `status-adapter.ts`
- 创建 `gateway-adapter.ts`

### 阶段 3：主入口重构 (1-2 天)
- 重构 `channel.ts`
- 更新 `index.ts`

### 阶段 4：测试与验证 (2-3 天)
- 编写单元测试
- 运行集成测试
- 手动验证功能

### 阶段 5：文档更新 (1 天)
- 更新 AGENTS.md
- 更新 README

**预计总工期**: 8-13 天

---

## 7. 风险与缓解

### 7.1 破坏性变更风险
**风险**: 重构可能破坏现有功能  
**缓解**: 
- 保留现有测试
- 新增对比测试
- 分阶段实施

### 7.2 依赖版本风险
**风险**: OpenClaw SDK 版本不兼容  
**缓解**: 
- 检查 peerDependencies 版本
- 更新 package.json 依赖

### 7.3 配额管理风险
**风险**: 配额计算不准确  
**缓解**: 
- 充分的单元测试
- 监控配额使用情况
- 提供手动重置接口

---

## 8. 成功标准

1. ✅ 使用 `createChatChannelPlugin` 构建插件
2. ✅ 实现所有标准适配器
3. ✅ 配额管理正确工作
4. ✅ Typing 续期机制完善
5. ✅ 所有测试通过
6. ✅ 无破坏性变更
7. ✅ 性能符合预期

---

## 9. 参考资源

- OpenClaw Telegram 插件: `/root/openclaw/extensions/telegram/src/channel.ts`
- OpenClaw Plugin SDK: `/root/openclaw/src/plugin-sdk/core.ts`
- ChannelPlugin 类型定义: `/root/openclaw/src/channels/plugins/types.plugin.ts`
- QQ Bot 官方文档: `https://bot.q.qq.com/wiki/develop/api-v2/`
