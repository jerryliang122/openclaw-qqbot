/**
 * 指令面板自动同步（QQ Bot 指令面板 API，/v2/panels，2026-08-12 上线）
 *
 * gateway ready 后（initFeatures 触发）把 openclaw tier=essential 的原生指令
 * 注册到 QQ Bot 指令面板，c2c / group 各一个（target_type=all）。
 * 用户点击面板项 → 指令文本填入输入框 → 用户发送 → 以普通文本进入框架 →
 * 框架文本斜杠指令路由执行（本插件不声明 capabilities.nativeCommands，
 * 避免与 commands.text=false 配置冲突）。
 *
 * 平台约束（官方文档）：
 *  - 面板项 name ≤14 字符、desc ≤30 字符、每面板 ≤20 项、每 bot ≤20 个面板
 *  - POST /v2/panels 限 10 QPM — 每次全量同步 ≤4 个请求，余量充足
 *
 * 幂等识别：自家面板用 panel.remark = "openclaw-qqbot:auto:<scope>" 打标；
 * remark 不匹配的面板（用户在开放平台手动创建的）绝不修改或删除。
 *
 * 同步时机：每进程每账号仅一次（防 WebSocket resumed 重连时 onReady 重复触发）；
 * 同步失败会释放 once-guard，下次重连可重试。全程错误只记日志，绝不阻断启动。
 */
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import {
  findCommandByNativeName,
  listNativeCommandSpecsForConfig,
} from 'openclaw/plugin-sdk/native-command-registry';
import type { NativeCommandSpec } from 'openclaw/plugin-sdk/native-command-registry';
import { tryGetBotForAccount } from '../bot-instance.js';
import type { ResolvedQQBotAccount } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';

/** 自家面板的 remark 前缀（后接 scope：c2c / group） */
const PANEL_REMARK_PREFIX = 'openclaw-qqbot:auto:';
/** 同步的面板 scope（channel/dm 属于频道产品，本插件不涉及） */
const PANEL_SCOPES = ['c2c', 'group'] as const;
/** 平台限制：面板项 name 最大长度（约 7 个汉字） */
const PANEL_ITEM_NAME_MAX = 14;
/** 平台限制：面板项 desc 最大长度（约 15 个汉字） */
const PANEL_ITEM_DESC_MAX = 30;
/** 平台限制：每面板最大项数 */
const PANEL_ITEM_LIMIT = 20;
/** openclaw 命令注册表的 provider 标识 */
const QQBOT_PROVIDER = 'qqbot';

/** 面板项（type=command：点击后 name 文本填入聊天输入框） */
export interface CommandPanelItem {
  type: 'command';
  name: string;
  desc: string;
}

/** SDK ApiGateway 的结构子集（便于测试注入 fake） */
export interface CommandPanelApi {
  get<T = unknown>(path: string, query?: Record<string, string | number | boolean>): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  delete<T = unknown>(path: string): Promise<T>;
}

/** GET /v2/panels 返回的面板记录（字段位置防御式兼容两种嵌套） */
interface PanelRecord {
  panel_id?: string;
  id?: string;
  remark?: string;
  panel?: { remark?: string; version?: number } | null;
}

/** 单个 scope 的同步结果 */
export interface CommandPanelSyncResult {
  scope: string;
  action: 'created' | 'updated';
  itemCount: number;
  duplicatesRemoved: number;
}

// ── 纯函数：指令选取 ──

/**
 * 从原生指令 spec 列表选取 essential 指令并映射为面板项。
 * tierOf 为指令名 → tier 的回查函数（NativeCommandSpec 不携带 tier，
 * 需经 findCommandByNativeName 回查 ChatCommandDefinition；undefined 视为 standard）。
 */
export function selectEssentialCommands(
  specs: readonly NativeCommandSpec[],
  tierOf: (nativeName: string) => string | undefined,
  log?: PluginLogger,
): CommandPanelItem[] {
  const items: CommandPanelItem[] = [];
  for (const spec of specs) {
    if (spec.isAlias) continue;
    if (tierOf(spec.name) !== 'essential') continue;
    const name = `/${spec.name}`;
    if (name.length > PANEL_ITEM_NAME_MAX) {
      log?.warn(
        `[command-panel] 指令 ${name} 超过面板 name 上限 ${PANEL_ITEM_NAME_MAX} 字符，未注册（用户仍可手动输入）`,
      );
      continue;
    }
    items.push({ type: 'command', name, desc: truncateDesc(spec.description) });
    if (items.length >= PANEL_ITEM_LIMIT) break;
  }
  return items;
}

/** desc 归一为单行并截断到平台上限 */
function truncateDesc(desc: string): string {
  const cleaned = (desc ?? '').replace(/\s+/g, ' ').trim();
  return cleaned.length > PANEL_ITEM_DESC_MAX ? cleaned.slice(0, PANEL_ITEM_DESC_MAX) : cleaned;
}

// ── 同步核心（可独立测试） ──

/**
 * 把 items 整包同步到 c2c / group 两个面板（幂等）：
 * 无自家面板 → POST 创建；有一个 → PUT 覆盖；有重复 → PUT 第一个并 DELETE 其余。
 * remark 不匹配的面板不触碰。
 */
export async function syncAccountCommandPanels(
  api: CommandPanelApi,
  items: readonly CommandPanelItem[],
  log?: PluginLogger,
): Promise<CommandPanelSyncResult[]> {
  const existing = await listPanels(api, log);
  const results: CommandPanelSyncResult[] = [];
  for (const scope of PANEL_SCOPES) {
    const remark = panelRemark(scope);
    const mine = existing.filter((p) => panelRemarkOf(p) === remark);
    if (mine.length === 0) {
      await api.post('/v2/panels', {
        scope,
        target_type: 'all',
        panel: { items, remark },
      });
      results.push({ scope, action: 'created', itemCount: items.length, duplicatesRemoved: 0 });
      continue;
    }
    const [keep, ...duplicates] = mine;
    await api.put(`/v2/panels/${panelIdOf(keep)}`, {
      panel: { items, remark },
    });
    let removed = 0;
    for (const dup of duplicates) {
      const id = panelIdOf(dup);
      if (!id) continue;
      await api.delete(`/v2/panels/${id}`);
      removed++;
    }
    results.push({ scope, action: 'updated', itemCount: items.length, duplicatesRemoved: removed });
  }
  return results;
}

async function listPanels(api: CommandPanelApi, log?: PluginLogger): Promise<PanelRecord[]> {
  const raw: unknown = await api.get('/v2/panels');
  const panels = extractPanelRecords(raw);
  if (panels.length === 0 && raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
    // 官方文档未给出列表响应的精确结构；未识别形状时记录原始 payload 便于排查
    log?.debug(`[command-panel] GET /v2/panels 响应形状未识别: ${JSON.stringify(raw).slice(0, 500)}`);
  }
  return panels;
}

function extractPanelRecords(raw: unknown): PanelRecord[] {
  if (Array.isArray(raw)) return raw.filter(isPanelRecord);
  if (raw && typeof raw === 'object') {
    for (const key of ['panels', 'data', 'list', 'items'] as const) {
      const value = (raw as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value.filter(isPanelRecord);
    }
  }
  return [];
}

function isPanelRecord(value: unknown): value is PanelRecord {
  return Boolean(value) && typeof value === 'object';
}

function panelRemark(scope: string): string {
  return PANEL_REMARK_PREFIX + scope;
}

/** remark 可能扁平在记录上，也可能嵌在 panel 对象里 */
function panelRemarkOf(record: PanelRecord): string | undefined {
  return record.remark ?? record.panel?.remark ?? undefined;
}

function panelIdOf(record: PanelRecord): string | undefined {
  return record.panel_id ?? record.id ?? undefined;
}

// ── 编排入口（initFeatures 调用） ──

/** 每进程每账号只同步一次（防 resumed 重连重复触发） */
const syncedAccounts = new Set<string>();

/** 测试钩子：清除 once-guard */
export function clearCommandPanelSynced(accountId?: string): void {
  if (accountId === undefined) syncedAccounts.clear();
  else syncedAccounts.delete(accountId);
}

/**
 * 同步账号的指令面板（fire-and-forget，错误只记日志）。
 * 任何异常都不抛出，绝不影响消息收发。
 */
export async function syncCommandPanels(
  account: ResolvedQQBotAccount,
  cfg: unknown,
  log?: PluginLogger,
): Promise<void> {
  if (!account.commandPanelNative) return;
  if (syncedAccounts.has(account.accountId)) return;

  const bot = tryGetBotForAccount(account.accountId);
  if (!bot) {
    log?.debug(`[command-panel] bot 未就绪，跳过本次面板同步: ${account.accountId}`);
    return;
  }

  syncedAccounts.add(account.accountId);
  try {
    const items = buildEssentialItems(cfg, log);
    if (items.length === 0) {
      log?.warn('[command-panel] 未选取到任何 essential 指令，跳过面板同步（避免清空现有面板）');
      return;
    }
    const results = await syncAccountCommandPanels(bot.api, items, log);
    for (const r of results) {
      log?.info(
        `[command-panel] ${r.scope} 面板已${r.action === 'created' ? '创建' : '更新'}：${r.itemCount} 项指令` +
          (r.duplicatesRemoved > 0 ? `，清理重复面板 ${r.duplicatesRemoved} 个` : ''),
      );
    }
  } catch (err) {
    // 失败释放 once-guard：resumed 重连会再次触发 initFeatures，提供一次重试机会
    syncedAccounts.delete(account.accountId);
    log?.warn(`[command-panel] 指令面板同步失败（不影响消息收发）: ${formatError(err)}`);
  }
}

/** 枚举 openclaw 原生指令并选取 essential 子集 */
function buildEssentialItems(cfg: unknown, log?: PluginLogger): CommandPanelItem[] {
  let specs: NativeCommandSpec[];
  try {
    specs = listNativeCommandSpecsForConfig(cfg as OpenClawConfig, {
      provider: QQBOT_PROVIDER,
      includeBundledChannelFallback: false,
    });
  } catch (err) {
    log?.warn(`[command-panel] 枚举 openclaw 原生指令失败: ${formatError(err)}`);
    return [];
  }
  return selectEssentialCommands(
    specs,
    (name) =>
      findCommandByNativeName(name, QQBOT_PROVIDER, { includeBundledChannelFallback: false })?.tier,
    log,
  );
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
