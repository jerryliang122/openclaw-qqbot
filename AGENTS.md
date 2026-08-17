# AGENTS.md — openclaw-qqbot

`@tencent-connect/openclaw-qqbot` — OpenClaw 通道插件，把 QQ Bot 官方 API 接入 OpenClaw framework。当前 v2.1.0。

## Commands

```bash
npm run build        # tsup → dist/index.cjs + dist/index.d.ts (CJS only, target node18)
npm run dev          # tsup --watch
npm run typecheck    # tsc --noEmit (currently passes)
npm run lint:runtime # BROKEN — references missing src/runtime-adapter/lint-runtime-access.ts
```

**No `npm test` script.** Tests are standalone scripts run with `tsx`:

```bash
npx tsx tests/<name>.test.ts          # run one file
npx tsx tests/*.test.ts 2>&1 | tail   # rough "all" run (no shared runner)
```

Most tests use `node:assert` + a hand-rolled `test()` helper. One outlier — `tests/account-key.test.ts` — imports `vitest`, but `vitest` is **not** installed in `node_modules`. Treat as broken until added.

## Architecture

Entry: `index.ts` → re-exports `qqbotPlugin` from `src/channel.ts`. That file is the orchestrator; substantive logic lives in:

```
src/
  channel.ts            # ChannelPlugin definition, GFM table fallback chunker
  bot-instance.ts       # getBotForAccount(accountId) → QQBot SDK instance
  runtime.ts            # setQQBotRuntime() / getQQBotRuntime() + exit hooks
  config.ts             # account resolution, group config, tool policy
  gateway/              # WebSocket/Webhook lifecycle, event handlers, middleware wiring
  dispatch/             # inbound → OpenClaw: body-assembler, ctx-builder, envelope
  outbound/             # send pipeline: text, media, TTS, streaming, cron, debounce
  middleware/           # access-control, attachment, policy-injector
  commands/             # /bot-* slash commands (registered via SDK middleware)
  features/             # onboarding, pairing, approval, ref-index, history, update-check
  adapter/              # contract probe, media, resolve, webhook, workspace
  setup/                # QR login (start/wait), account-key, finalize, surface wizard
  tools/                # platform.ts (qqbot_platform_api), remind.ts
  utils/                # logger, mention stripping, pkg-version, SSRF guard, STT
  openclaw-plugin-sdk.d.ts  # local type stubs for openclaw/plugin-sdk
```

Plugin exports include `qqbotPlugin`, `getBotForAccount`, `QQBotGateway`, `sendText`, `sendMedia`, `parseTarget`, `dispatchToOpenClaw`, `StreamingController`, `PersistedRefIndexStore`.

## Key gotchas

- **`tsup` post-build hook** (`tsup.config.ts:54`): rewrites `dist/index.cjs` to alias `new Function` → `new _F` (protobufjs pattern that triggers security scanners). Don't strip this — it's load-bearing.
- **`preload.cjs` symlink**: `openclaw` is a `peerDependency`. When installed via `openclaw plugins install`, the plugin ends up under `~/.openclaw/extensions/openclaw-qqbot/`, and `openclaw/plugin-sdk` must be resolvable from the plugin's `node_modules`. `preload.cjs` synchronously calls `ensurePluginSdkSymlink()` (see `scripts/link-sdk-core.cjs`) which creates a junction `node_modules/openclaw` → the global openclaw install. If you remove or rename `preload.cjs`, the plugin will fail to load when installed via the framework.
- **`package.json` `external`**: `openclaw` and `openclaw/plugin-sdk/**` are external — they are NOT bundled. `dist/index.cjs` does `require('openclaw/plugin-sdk/core')` at runtime. Local dev needs `node_modules/openclaw` as a real install (or symlink to it).
- **Runtime contract probe** (`src/adapter/contract.ts`): `REQUIRED` list is currently **empty**; all capabilities are `OPTIONAL`. The probe still runs on register but only logs degraded features; it will never throw unless someone adds a required entry. Don't rely on it to fail fast on missing APIs.
- **Multi-account**: top-level `channels.qqbot.appId/secret` is the `"default"` account; additional accounts go under `channels.qqbot.accounts.<id>`. Each account gets its own gateway and token cache. OpenIDs are **per-account** — a user OpenID from bot A cannot be used by bot B.
- **Group message priority chain**: `groups.{groupOpenid}.requireMention` → `groups.*.requireMention` → account-level `defaultRequireMention` → `true` (default). Same precedence applies to other group config fields.
- **No secrets in repo code**: appid/secret is configured via `openclaw channels add --token "appid:secret"` or env vars `QQBOT_APPID` / `QQBOT_SECRET`. Never hardcode or log credentials.
- **`package-lock.json` is gitignored** — use `npm install` (regenerates it) rather than `npm ci` against a fresh clone.

## Skills (under `/skills/`)

- `qqbot-channel` — Guild/Channel API operations (notes/posts/schedules). Trigger: 用户提到「频道」「子频道」等.
- `qqbot-remind` — `qqbot_remind` tool for cron-based proactive messages.
- `qqbot-upgrade` — `/bot-upgrade` hot-update flow.

These are loaded by the host AI; they guide behavior, not build steps.

## Verification

Before claiming a change works:

```bash
npm run typecheck                   # tsc --noEmit
npm run build                       # ensure tsup post-build succeeds
npx tsx tests/<affected>.test.ts    # run the relevant test file(s)
```

For behavior changes in `src/gateway/`, `src/dispatch/`, or `src/outbound/`, at minimum run the matching `tests/*.test.ts` (e.g. `session-key.test.ts`, `body-assembler.test.ts`, `middleware-chain.test.ts`).

## Misc

- Plugin IDs: `openclaw-qqbot` (plugin), `qqbot` (channel). Don't confuse them.
- Slash commands live in `src/commands/` — each is a separate file, registered via `buildCommandList()` in `src/commands/index.ts`.
- Default text chunk limit: 5000 chars (`TEXT_CHUNK_LIMIT` in `src/channel.ts`).
- Logging: use `createPluginLogger()` from `src/utils/plugin-logger.ts`. Don't use `console.*` directly except in early `register()` paths where the runtime logger isn't wired up yet.

## QQ Bot 平台能力 vs 其他 OpenClaw 通道

QQ Bot 跟 Telegram / Discord / Slack 等其他通道在平台 API 形态上差异较大,这些差异是不可消解的,设计时必须以此为前提。

### 底层依赖

- 完全依赖官方 Node.js SDK `@tencent-connect/qqbot-nodejs` (v1.0.4)。
- SDK 自身是 `https://bot.q.qq.com/wiki/develop/api-v2/` 上公开的 HTTP REST + WebSocket Gateway 协议的薄封装 — 本插件不直接 hit `https://bots.qq.com` / `https://api.sgroup.qq.com` 任何 endpoint,所有进出都走 SDK。
- `bot-instance.ts` 用 `new QQBot({...})` 构造;所有 `sendText`/`sendMedia`/`sendTyping`/`openStream` 调用最终落到 SDK 的 `QQBot.ts` 内部方法。
- **不要在本仓库中绕过 SDK 直接 fetch QQ API** — 一旦绕过就脱离了 SDK 的 token 缓存、重连、事件路由、消息缓存等机制。

### 平台一级概念:没有的话题 / 频道 / Forum

- QQBot 平台**没有 Telegram 那种 DM topic / forum supergroup / Slack channel** — 全部会话只有两种 scope:
  - `c2c` (私聊,一对一)
  - `group` (群聊,@ 全员或 @ 单人)
- 另有一个独立的「频道/Guild」产品(笔记、子频道、时刻表),**插件基本不处理** — 频道有自己的 OpenAPI 域(`sgroup.qq.com`),与主通道不共享 session / dispatch / streaming 路径。如果以后要做频道,也是单独一个 skill / 独立模块,不要混进 c2c/group 的 dispatcher。
- 所以**别拿 Telegram 的 thread_id / topic / supergroup 之类概念来对齐 QQBot** — 写代码前先确认这个能力在 QQ 上压根不存在。

### 平台一级概念:同一个 API,通过参数切换"被动 / 主动 / 互动召回"

QQ 跟 Telegram 的最大差异在**回复机制**:

- **私聊和群聊都只有一个 HTTP 入口**:
  - 私聊:`POST /v2/users/{user_openid}/messages`(文档:`bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html`)
  - 群聊:`POST /v2/groups/{group_openid}/messages`(文档:`bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html`)
- **同一个 API,通过是否带 `msg_id` / `event_id` 区分"被动回复" vs "主动推送"** — 三者**互斥**:

| 模式 | 触发 | 配额 | 有效期 |
|------|------|------|--------|
| **被动回复** (passive) | `msg_id` 或 `event_id` 二选一 | 私聊 4 次/msg,群 5 次/msg | 私聊 60 min,群 5 min |
| **主动推送** (proactive) | 都不传 | 私聊 Bot 维度 10/qps(未认证 5/qps + 30/qpm),群 60/qpm;接收方 20/qpm,1 天最多 1000 条 | 无 |
| **互动召回** (wakeup) | `is_wakeup=true`,与 msg_id/event_id 互斥 | 30 天内 4 周期,每周期 1 条 | 30 天 |

- 接口级统一 QPS 上限 100。
- 错误码 `40034128` = 被动回复时间/次数超限;`40034100` = 主动消息超限;`40034122` = 互动召回达上限。

### "流式"是另一种发送通道,不是回复模式

- **不要把流式跟被动/主动混在一起** — 流式是**另一套** API:
  - `openStream` 创建流(仅 c2c,群不支持流式参数)
  - `session.update` 多次替换(已发送的 prefix 不可修改)
  - `session.complete` 收尾
- 流式**没有"流式配额"**,但流式通道里的回复消息(`session.update` 推送)仍走 C2C 被动回复配额(同上表,4 次/msg/60 min)。
- 见 `src/middleware/typing.ts`:`typing` 通知复用 `ReplyLimiter`(4/msg 配额),与真回复共享额度 — 防止 thinking 流把配额烧光。
- 见 `src/outbound/reply-limiter.ts`(`ReplyLimiter`,默认 4/msg_id,10k LRU,C2C TTL 60 min)。
- 见 `src/features/msgid-cache.ts`:C2C `msg_id` 缓存 30 分钟,群 5 分钟(主动消息场景 cron/proactive 用)。

### 平台一级概念:Markdown 渲染

- QQ Bot 客户端**原生支持 Markdown 渲染**,服务端通过 `msg_type` 字段区分。
- 在 `new QQBot({ markdownSupport: true })` 启用后,SDK 自动选 `markdown` msg_type,客户端按 Markdown 渲染。
- 没有 Telegram 那种 `parse_mode: 'HTML'` + 服务端 markdown→HTML 转换。**也没有 HTML parse 失败回退** — 写得越界的 Markdown 会被 QQ 客户端渲染异常,代码层没有像 `withTelegramHtmlParseFallback` 那样的兜底。
- `src/outbound/sanitize.ts` 仅做一层内部 scaffolding 标签剥离(`<system-reminder>` / `<thinking>` / `` `think`…`/think` ``),保留 Markdown 给 SDK。

### 平台一级概念:OpenID 命名空间

- 用户在 QQBot 平台唯一标识是 `openid`(32 字节 hex 或 UUID 字符串),不是数字 ID。
- **OpenID 跨账号不通用** — bot A 拿到的 user openid 在 bot B 上完全无意义。
- 这影响:
  - `Multi-account` 隔绝:`src/config.ts` 解析时 OpenID 在每个 `accountId` 命名空间下独立。
  - 跨账号会话假设不成立:不能共享 `allowFrom` / `pairing store` 等。
  - URL 路由:私聊 targetId 是字符串,不是数字 — `parseTarget` (`src/outbound/target.ts:51-63`) 接受 `qqbot:c2c:<openid>` 格式。

### 平台一级概念:WebSocket / Webhook 双传输

- SDK 默认 WebSocket 长连接,跟 Telegram polling 体验类似。
- 也支持 Webhook 模式(`transport: 'webhook'`)用于 HTTP 回调,见 `src/adapter/webhook.ts`。
- 两种模式对中间件、事件监听、消息发送 API 是一致的;**插件层无差异处理**。

### 与 Telegram 的能力映射(快速对照)

| 能力 | Telegram | QQBot |
|------|----------|-------|
| 私聊 | DM (`chat.type === 'private'`) | C2C (`scope === 'c2c'`) |
| 群 | group / supergroup / forum | group (`scope === 'group'`) |
| DM topic / forum / thread | `message_thread_id` | **不存在** |
| 频道/Guild | channel | 独立 QQ 频道产品(走 `qqbot-channel` skill) |
| Markdown 渲染 | 服务端 `parse_mode: HTML` | 客户端原生 `msg_type: markdown` |
| 引用回复 | `reply_to_message_id` / `reply_parameters` | `msg_id` 被动回复 |
| 编辑消息 | `editMessageText` 自由改 | `openStream` 多次 `session.update` 替换,prefix 不可修改 |
| Typing | `sendChatAction(action=typing)` | `sendTyping` (仅 c2c) |
| 流式 | editMessageText 多次 | `openStream` + `session.update/complete` (仅 c2c) |
| 配额 | 无 | 被动回复 4/hour/msg_id;主动发送每日配额 |
| 长连接 | long polling / webhook | WebSocket (默认) / Webhook |

### 平台对齐的"对齐"指什么

- 源码中大量出现 `// 对齐 telegram` 注释(`src/dispatch/dispatch.ts:29, 165, 227, 274, 282, 358, 401` 等;`src/middleware/typing.ts:60, 64`)— 指的是**用户体验层面**:typing、失败兜底、debounce、abort、per-user session 等行为,不是 API 调用一一对应。
- **不要试图把 QQ 的 `sendText`/`openStream`/msg_id 机制强行映射到 Telegram 的 `sendMessage`/`editMessageText`/`reply_to_message_id`** — 形态不同,语义相通。

### 文档 / 进一步阅读

- QQ Bot 官方: `https://bot.q.qq.com/wiki/develop/api-v2/`
- SDK 源码: `node_modules/@tencent-connect/qqbot-nodejs/src/QQBot.ts`(所有 methods 都在这)
- SDK README: `node_modules/@tencent-connect/qqbot-nodejs/README.md`
- 平台差异分析历史:见 `docs/` 下相关笔记。
