# QQBot Approval v2 Protocol Migration

**Status:** draft
**Date:** 2026-08-07
**Branch:** `fix/approval-v2-protocol-migration`
**Author:** opencode + human partner

## Problem

When a user clicks an "allow once" / "allow always" / "deny" button on the QQ Bot
approval card, nothing happens and the framework side eventually times out the
pending approval. We confirmed the root cause:

- The plugin emits legacy button data of the shape
  `approve:<exec|plugin>:<uuid>:<allow-once|allow-always|deny>`
  (`src/features/approval-handler.ts:163-165`).
- The current openclaw framework (`/root/openclaw/extensions/qqbot/src/engine/approval/index.ts:287`)
  parses clicks with the regex `^approve:v2:(exec|plugin):([^:]+):(allow-once|allow-always|deny)$`.
- Old-format clicks do not match the regex, so the framework silently ignores the
  interaction. The framework then waits for `exec.approval.resolve` /
  `plugin.approval.resolve` RPCs that never come, and the request eventually
  times out.
- The plugin does not implement `ChannelPlugin.approvalCapability`
  (`plugin-sdk/types.plugin-ByOu7kLN.d.ts:46`), so the framework treats QQBot
  as a non-native channel and runs its own fallback click resolver with the v2
  parser. The plugin's own `handleApproval` in `event-handlers.ts:150` is
  unreachable for the framework-resolved decisions.

## Goal

Migrate QQBot approvals to the v2 protocol and the framework's
`ChannelApprovalCapability` contract, so:

1. Buttons encode IDs with `approve:v2:<kind>:<encodeURIComponent(approvalId)>:<decision>`.
2. The framework's click resolver handles `INTERACTION_CREATE` and translates
   clicks into RPCs.
3. The plugin only needs to author:
   - `ChannelApprovalCapability` (auth + availability + delivery + nativeRuntime)
   - A `ChannelApprovalNativeRuntimeSpec` (text / keyboard / send).

We remove the plugin's hand-rolled `QQBotApprovalHandler`, `handleApproval`,
`approvalStubs`, and the dynamic `approval-gateway-runtime` import.

## Non-Goals

- We do not change the QQ Bot SDK (`@tencent-connect/qqbot-nodejs`) itself.
- We do not add an `/approve` slash command. Clicks are the primary path.
- We do not change `/bot-approve`, which manages `tools.exec.security` /
  `tools.exec.ask`. That command stays as-is and continues to use the SDK's
  `getConfig` / `applyConfig` adapters.
- We do not change the `bot-pairing` pairing-code flow.
- We do not implement fallback forwarding paths. The QQ Bot native delivery is
  the only path; if the capability reports `disabled`, the framework falls back
  to its own delivery and the plugin is not involved.

## Architecture (after migration)

```
┌─────────────────────────────────────────────┐
│           openclaw framework                │
│                                             │
│  approval-delivery-runtime                  │
│      → invoke channel.approvalCapability    │
│                                             │
│  approval-handler-adapter-runtime           │
│      → lazily load nativeRuntime adapter    │
│                                             │
└──────────────────┬──────────────────────────┘
                   │ invokes
                   ▼
┌─────────────────────────────────────────────┐
│  ChannelPlugin.approvalCapability           │
│  (= createChannelApprovalCapability({...})) │
│                                             │
│  ├── authorizeActorAction                   │
│  │     delegates to exec-approvals.ts       │
│  ├── getActionAvailabilityState             │
│  │     checks enabled + secret resolved     │
│  ├── delivery.shouldSuppressForwardingFallback│
│  │     suppress framework fallback           │
│  └── nativeRuntime:                         │
│        createLazyChannelApprovalNativeRuntime│
│        Adapter({ spec })                    │
│        └── lazily loads handler-runtime.ts  │
│             ├── availability                │
│             │     isConfigured / shouldHandle│
│             ├── presentation                │
│             │     buildPendingPayload       │
│             │     buildResolvedResult       │
│             │     buildExpiredResult        │
│             └── transport                   │
│                  prepareTarget / deliver    │
│                                             │
└──────────────────┬──────────────────────────┘
                   │ sends via
                   ▼
┌─────────────────────────────────────────────┐
│  @tencent-connect/qqbot-nodejs (WebSocket)  │
│      sendMessage (with inlineKeyboard)      │
│      on('interaction', …)                   │
│      → framework owns click resolution      │
│        → RPC gateway.request(...)            │
└─────────────────────────────────────────────┘
```

## Components

### A. `src/engine/approval/index.ts` (pure functions, zero deps)

Pure functions, no framework imports beyond types. Lives under `engine/` to
match the layout used by `/root/openclaw/extensions/qqbot/src/engine/approval/`.

The unified `PendingApprovalView` from
`openclaw/plugin-sdk/approval-handler-runtime` carries an `approvalKind`
field plus typed exec/plugin payloads. We dispatch on `approvalKind`
inside the same function rather than splitting into separate `buildExec…`
and `buildPlugin…` variants.

Exports:

- `buildExecApprovalText(view: PendingApprovalView, nowMs)` — dispatches on
  `view.approvalKind === 'exec'`. The `view` is the framework's unified
  `PendingApprovalView` (not the legacy `ExecApprovalRequest`).
- `buildPluginApprovalText(view: PendingApprovalView, nowMs)` — same shape
  for plugin approvals.
- `buildApprovalKeyboard(approvalId, approvalKind, allowedDecisions)` —
  builds `InlineKeyboard` with three buttons:
  - data shape `approve:v2:${approvalKind}:${encodeURIComponent(approvalId)}:${decision}`
  - `action.type = 1`, `group_id: "approval"`, `click_limit: 1`,
    `permission.type: 2`
- `resolveApprovalTarget(sessionKey, turnSourceTo)` — unchanged regex,
  returns `{ type: ChatScope, id: string } | null`.
- `parseApprovalButtonData(buttonData)` — uses the regex
  `^approve:v2:(exec|plugin):([^:]+):(allow-once|allow-always|deny)$`,
  returns `null` on mismatch. (Used by the framework, not by us directly;
  we keep an exported copy for unit tests.)

### B. `src/bridge/approval/capability.ts`

Wraps `createChannelApprovalCapability` from
`openclaw/plugin-sdk/approval-delivery-runtime`. Exports
`getQQBotApprovalCapability()` matching the reference shape in
`/root/openclaw/extensions/qqbot/src/bridge/approval/capability.ts`.

Hooks:

- `authorizeActorAction` → delegate to `authorizeQQBotApprovalAction`
  in `exec-approvals.ts`.
- `getActionAvailabilityState` → returns
  `{ kind: "enabled" }` if `isNativeDeliveryEnabled`, else `{ kind: "disabled" }`.
- `getExecInitiatingSurfaceState` → same as availability.
- `delivery.shouldSuppressForwardingFallback` → returns `true` when native
  delivery is enabled for the channel/account, mirroring the reference.
- `nativeRuntime` → lazy `createLazyChannelApprovalNativeRuntimeAdapter`
  from `openclaw/plugin-sdk/approval-handler-adapter-runtime`, pointing at the
  adapter in `handler-runtime.ts`.

### C. `src/bridge/approval/handler-runtime.ts`

Implements `ChannelApprovalNativeRuntimeSpec`. Lazy-loaded by `capability.ts`
so heavy imports (messaging sender) stay off the critical startup path.

Sections (matches the runtime adapter interface in
`approval-handler-runtime-types-D67cLD0j.d.ts`):

- `availability` — `isConfigured` / `shouldHandle`, same predicates as
  `capability.ts`, factored out for the spec interface.
- `presentation`:
  - `buildPendingPayload({ view, nowMs })` — dispatches on
    `view.approvalKind` (`exec` → `buildExecApprovalText`,
    `plugin` → `buildPluginApprovalText`), then `buildApprovalKeyboard`
    with `allowedDecisions` from `view.actions.map(action => action.decision)`.
  - `buildResolvedResult` → `{ kind: "leave" }`. Framework handles the
    visited-label state on the original card automatically; no message
    update needed.
  - `buildExpiredResult` → `{ kind: "leave" }`.
- `transport`:
  - `prepareTarget({ plannedTarget, view, ... })` → `resolveApprovalTarget`,
    returns `{ target, dedupeKey: \`${type}:${id}\` }`.
  - `deliverPending({ preparedTarget, pendingPayload, ... })` → resolves
    account + creds, calls `messageApi.sendMessage(type, id, text, creds, { inlineKeyboard })`.
- `observe.onDelivered` — no-op stub (we may later add a debug log here).
- `interactions` — not implemented. The reference implementation in
  `/root/openclaw/extensions/qqbot/src/bridge/approval/handler-runtime.ts`
  also does not implement this section; framework handles binding
  automatically based on button data.

### D. `src/channel.ts`

Adds `approvalCapability: getQQBotApprovalCapability()` to the `qqbotPlugin`
object. No other change to this file unless the legacy channel exports
require removal.

### E. Removal list

- Delete `src/features/approval-handler.ts` entirely, including the
  `loadApprovalGatewayRuntime` dynamic-import path in
  `src/adapter/gateway.ts`.
- Delete `src/gateway/lifecycle.ts` import + register/unregister lines for
  `QQBotApprovalHandler` and `approvalLog`.
- Delete `handleApproval` and its `getApprovalHandler` import in
  `src/gateway/event-handlers.ts`. `INTERACTION_QUERY` and
  `INTERACTION_UPDATE` handlers stay.
- Delete `approvalStubs` from `src/features/approval-utils.ts` (the legacy
  channel-plugin surface that pretended to handle approvals). Keep
  `isApprovalPayload` if any test still depends on it; otherwise delete the
  whole file.
- Remove the `_approvalFeatureAvailable` and `registerApprovalHandler` /
  `unregisterApprovalHandler` / `getApprovalHandler` /
  `findApprovalHandlerForShortId` exports.

## Data Flow

### Send approval card

1. Framework gateway pushes `exec.approval.requested` (or plugin) to the
   approval handler.
2. Framework calls `nativeRuntime.spec.presentation.buildPendingPayload({ view })`.
3. Plugin returns `{ text, keyboard }` (v2 button data).
4. Framework calls `nativeRuntime.spec.transport.deliverPending(...)`.
5. Plugin calls `getMessageApi(appId).sendMessage(type, id, text, creds, { inlineKeyboard })`.
6. Framework caches `{ messageId, target }` in its pending table.

### Click resolution

1. QQ Bot platform pushes INTERACTION_CREATE to the framework gateway.
2. Framework runs `parseApprovalButtonData` (the v2 regex).
3. Framework calls `gateway.request('exec.approval.resolve', { id, decision })`
   (and marks the entry as resolved).
4. Framework invokes `presentation.buildResolvedResult` on us. We return
   `{ kind: "leave" }`; framework keeps the original message with QQ Bot's
   automatic `visited_label` rendering.
5. **No plugin-side click hook is invoked.** The plugin never sees the
   individual click decision in this contract.

### Expire

1. Framework internal timer fires.
2. Framework builds `ExpiredView` and calls
   `presentation.buildExpiredResult`. We return `{ kind: 'leave' }`.
3. Framework may forward an "expired" reply via its own delivery path; the
   plugin is not involved.

## Error Handling

- **`sendMessage` throws** — re-throw to the framework; framework logs and
  notifies forwarder. No retry (matches reference).
- **`accountToCreds` returns no usable secret** — `isConfigured` returns
  false; framework never enters our nativeRuntime and uses its fallback
  delivery instead.
- **Click RPC fails on the framework side** — framework logs and times out
  per its own policy. The user already saw our short ack, so the experience
  degrades to "click registered locally but framework did not act". We accept
  this; the alternative (rollback the ack on RPC failure) requires listening
  to framework events we do not currently have visibility into.
- **Account mismatch** — `matchesQQBotApprovalAccount` (already in
  `exec-approvals.ts`) filters out requests that belong to other accounts
  before `prepareTarget` runs.

## Testing

Unit tests (Vitest is already configured in the repo; confirm by reading
`package.json`):

- `src/engine/approval/index.test.ts` (new):
  - `buildApprovalKeyboard` produces v2 button data with URL-encoded approval IDs.
  - `parseApprovalButtonData` accepts `approve:v2:exec:...:allow-once`, rejects
    legacy `approve:exec:UUID:allow-once`.
  - `buildExecApprovalText` and `buildPluginApprovalText` produce the expected
    Chinese copy given known views.
  - `resolveApprovalTarget` regression cases (c2c / group / direct / null).
- `src/bridge/approval/handler-runtime.test.ts` (new):
  - Mock `getMessageApi` and `accountToCreds`; assert that `buildPendingPayload`
    + `deliverPending` send the expected `text` + `inlineKeyboard` option.
  - Assert `resolve` sends a short ack (no inlineKeyboard option).
  - Assert `buildResolvedResult` and `buildExpiredResult` return
    `{ kind: "leave" }`.
- `src/bridge/approval/capability.test.ts` (new):
  - Mock `exec-approvals.ts`. Assert `isConfigured` returns true when the
    account is enabled and has secrets, false otherwise.
  - Assert `shouldSuppressForwardingFallback` follows `isNativeDeliveryEnabled`.
  - Assert `nativeRuntime.load()` lazily imports `handler-runtime.ts`.

Integration tests:

- One end-to-end test that wires the framework's
  `createChannelApprovalCapability` against a fake gateway, fake QQ Bot
  messaging, and asserts that a click resolves back through the framework
  RPC. (Skip if too heavyweight for this PR; document as follow-up.)

Removed test files:

- `src/features/approval-handler.test.ts` (if any) — delete.
- `src/gateway/lifecycle.test.ts` — remove approval-related cases; keep the
  rest of the lifecycle suite.

## Migration Steps

1. Create new files:
   - `src/engine/approval/index.ts` and `index.test.ts`
   - `src/bridge/approval/capability.ts` and `capability.test.ts`
   - `src/bridge/approval/handler-runtime.ts` and `handler-runtime.test.ts`
2. Edit `src/channel.ts` to add `approvalCapability: getQQBotApprovalCapability()`.
3. Delete `src/features/approval-handler.ts` and `src/features/approval-utils.ts`.
4. Edit `src/gateway/lifecycle.ts` to remove approval registration lines.
5. Edit `src/gateway/event-handlers.ts` to remove `handleApproval` and the
   `getApprovalHandler` import.
6. Run `npm test` (or the equivalent per `package.json`) and `npm run lint`
   (or equivalent).
7. Update `CHANGELOG.zh.md` with a fix entry describing the migration.
   Note: minimum supported openclaw version is bumped; the dynamic-import
   fallback for older builds is removed.
8. Update `README.zh.md` to drop the "审批功能降级" footnote that no longer
   applies.

## Decisions (resolved during review)

1. **No click-side short ack.** The user picked option A: click → card
   automatically switches to `visited_label` (✅ 已处理 / ❌ 已拒绝). Matches
   the reference implementation in
   `/root/openclaw/extensions/qqbot/src/bridge/approval/handler-runtime.ts`.
   No additional reply is sent from the plugin. UX trade-off is documented
   in `CHANGELOG.zh.md` under the fix entry.

2. **No legacy fallback.** The plugin will drop the
   `loadApprovalGatewayRuntime()` dynamic-import path entirely. Plugins
   running on openclaw builds without `approval-delivery-runtime` will
   report a startup error and the approval feature will be unavailable
   (matches the documented behavior of the new SDK). `CHANGELOG.zh.md`
   bumps the minimum supported openclaw version.

## Open Questions

None.