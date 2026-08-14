# AGENTS.md — openclaw-qqbot

`@tencent-connect/openclaw-qqbot` — OpenClaw 通道插件，把 QQ Bot 官方 API 接入 OpenClaw framework。当前 v2.0.1。

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
