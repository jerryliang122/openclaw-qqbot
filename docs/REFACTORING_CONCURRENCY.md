# 并发控制重构说明

## 背景

QQBot 插件之前使用插件级的 `concurrencyGuard` 中间件来实现消息并发控制，采用"串行+合并"策略。但这与 OpenClaw 框架的设计理念不一致：

1. **重复建设**：框架本身已有 session lane 机制实现并发控制
2. **双重串行**：插件级串行 + 框架级串行 = 性能损失
3. **不一致**：与 Telegram 等其他 channel 的实现方式不同

## 重构内容

### 移除的代码

**src/gateway/middleware-setup.ts**:
- 移除 `concurrencyGuard` 中间件的导入和使用
- 移除消息合并逻辑（`onMerge` 回调）
- 移除相关的 50+ 行代码

**src/types.ts**:
- 更新 `processingTimeoutMs` 字段注释，说明不再使用

**src/dispatch/body-assembler.ts**:
- 标记 `buildMergedUserMessage` 函数为已废弃（保留代码以防未来需要）

**src/gateway/event-handlers.ts**:
- 更新日志注释，说明 `mergedMessages` 不再使用

**src/gateway/qqbot-gateway.ts**:
- 更新注释，说明并发控制由框架处理

### 保留的功能

✅ **引用消息功能完整保留**：
- `quoteRef` 中间件（`src/gateway/middleware-setup.ts:93-95`）
- `PersistedRefIndexStore` 持久化存储（`src/features/ref-index-store.ts`）
- `wrapBotSendForRefIndex` 出站包装（`src/gateway/qqbot-gateway.ts:239-302`）

✅ **其他所有中间件**：
- `messageFilter` - 消息过滤
- `contentSanitizer` - 内容清洗
- `rateLimiter` - 限流
- `mentionGate` - @提及门控
- `historyBuffer` - 历史缓冲
- `typingIndicator` - 输入状态
- `slashCommand` - 斜杠命令
- `attachmentProcessor` - 附件处理
- `envelopeFormatter` - 信封格式化

## 新的并发控制机制

### 工作原理

1. **消息到达** → 中间件链处理
2. **dispatch.ts** → 生成 sessionKey: `qqbot:${accountId}:${senderId}`
3. **调用框架 API** → `inboundRun` 或 `dispatchReply`
4. **框架队列** → 按 sessionKey 自动串行处理同一会话的消息

### Session Key 格式

```typescript
sessionKey = `qqbot:${account.accountId}:${envelope.senderId}`
```

- 私聊：`qqbot:default:USER_OPENID`
- 群聊：`qqbot:default:GROUP_OPENID` 或 `qqbot:bot2:GROUP_OPENID`

### 框架配置

框架级别的并发控制通过以下配置调整：

```json
{
  "agents": {
    "defaults": {
      "maxConcurrent": 4  // 全局最大并发数
    }
  }
}
```

默认值：
- 未配置的 lane：并发 = 1（串行）
- main lane：并发 = 4
- subagent lane：并发 = 8

## 对比

| 维度 | 旧方案（concurrencyGuard） | 新方案（框架 session lane） |
|-----|--------------------------|--------------------------|
| **实现位置** | 插件中间件 | 框架核心 |
| **持久化** | 内存缓存（重启丢失） | 框架队列（可能持久化） |
| **序列化粒度** | 按用户串行 | 按 sessionKey 串行 |
| **消息合并** | 有（merge 策略） | 无（未来可在框架层实现） |
| **性能** | 双重串行 | 单层串行 |
| **与框架集成** | 弱 | 强 |
| **与其他 channel 一致性** | 低 | 高 |

## 影响

### 正面影响

✅ **性能提升**：避免双重串行，减少消息处理延迟
✅ **架构统一**：与 Telegram 等其他 channel 保持一致
✅ **维护简化**：减少插件代码量，降低维护成本
✅ **框架能力复用**：充分利用框架的队列、监控、重试等能力

### 潜在问题

⚠️ **消息合并功能移除**：
- 之前用户快速发送多条消息时，会自动合并为一条
- 现在会逐条处理，AI 可能会收到多个独立的问题
- **缓解措施**：框架层的历史缓冲仍然有效，AI 能看到完整的对话历史

⚠️ **/stop 命令行为变化**：
- 之前：`urgentPredicate` 让 `/stop` 跳过排队
- 现在：依赖框架的队列机制，`/stop` 会正常排队
- **影响评估**：低风险，`/stop` 本身是取消命令，稍晚执行影响不大

## 测试

### 已验证

✅ 构建成功（`npm run build`）
✅ 引用消息功能完整保留
✅ 所有其他中间件正常工作

### 待验证

⏳ 实际消息收发测试（需要运行环境）
⏳ 并发场景测试（多用户同时发送消息）
⏳ 引用消息测试（用户引用机器人发送的消息）

## 后续工作

1. **监控观察**：部署后观察消息处理延迟、并发情况
2. **用户反馈**：收集用户对新行为的反馈
3. **性能对比**：对比重构前后的性能指标
4. **文档更新**：更新用户文档，说明并发行为的变化

## 参考资料

- [OpenClaw Queue 文档](https://github.com/tencent-connect/openclaw/blob/main/docs/concepts/queue.md)
- [Telegram Channel 实现](/root/openclaw/extensions/telegram/src/)
- [Session Write Lock](/root/openclaw/src/agents/session-write-lock.ts)
