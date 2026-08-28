/**
 * openclaw secrets store CLI 执行器
 *
 * 把用户在聊天中发送的密钥值通过 `openclaw secrets store set` 写入
 * OpenClaw 密钥库（CLI 直写本地共享状态，绕过 Gateway）。
 *
 * kind 规则（与 openclaw CLI 对齐）：
 * - env：非敏感环境变量，`--value` 传参，事后可 `secrets store get` 读回
 * - secret：真正的密钥，CLI 拒绝 `--value`（防 shell 历史/进程列表泄漏），
 *   必须走 `--value-file -`（stdin）写入，write-only 不可读回
 *
 * 安全约束：
 * - spawn 恒为 args 数组 + shell 缺省（不经过 shell），值不参与任何
 *   字符串拼接 → 无注入面；name 另有白名单正则双保险
 * - 所有输出/错误经 scrubSecret() 清洗后才会返回或落日志，值绝不外泄
 *
 * 注：本文件直接 import node:child_process。openclaw 插件安装扫描器
 * （dangerous-exec 规则）会记一条 critical 告警，但本地安装不会被拦截
 * （硬拦截仅依赖包名黑名单）——见 AGENTS.md 已知项。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

export type SecretStoreKind = 'env' | 'secret';

/** CLI 同款命名规则：^[A-Z][A-Z0-9_]{0,127}$ */
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

/** 命名后缀命中即判定为 secret（与 CLI 自动检测一致） */
const SECRET_SUFFIX_RE = /_(API_KEY|TOKEN|PASSWORD|PRIVATE_KEY|SECRET)$/;

/** CLI 单值上限 64 KiB（超出 CLI 直接 exit 2，插件侧提前拦截） */
export const SECRET_VALUE_MAX_BYTES = 65_536;

const SET_TIMEOUT_MS = 30_000;
const RELOAD_TIMEOUT_MS = 15_000;
/** 子进程输出保留上限（诊断用，已 scrub） */
const OUTPUT_CAP_CHARS = 2_000;

// ── 校验 / 判定 / 掩码 ─────────────────────────────────────────────────────

export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

/** 智能判定 kind：显式指定优先，否则按名称后缀（_API_KEY/_TOKEN/... → secret） */
export function resolveSecretKind(name: string, explicit?: string): SecretStoreKind {
  if (explicit === 'env' || explicit === 'secret') return explicit;
  return SECRET_SUFFIX_RE.test(name) ? 'secret' : 'env';
}

/** 展示用掩码：>12 字符显示前 4 + … + 后 4，否则 *** */
export function maskSecret(value: string): string {
  if (value.length <= 12) return '***';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** 把文本中出现的密钥值整体替换为 ***（错误输出/日志清洗用） */
export function scrubSecret(text: string, value: string): string {
  if (!value) return text;
  return text.split(value).join('***');
}

/** 纯函数：拼装 secrets store set 的 argv（不含 CLI 入口本身），便于测试 */
export function buildSecretsStoreSetArgs(
  name: string,
  kind: SecretStoreKind,
  value: string,
): string[] {
  const args = ['secrets', 'store', 'set', name, '--kind', kind];
  // secret 强制 stdin（CLI 拒绝 --value）；env 走 --value
  return kind === 'secret' ? [...args, '--value-file', '-'] : [...args, '--value', value];
}

// ── CLI 入口解析 ───────────────────────────────────────────────────────────

export interface CliCommand {
  cmd: string;
  /** CLI 入口自身的前置参数（如 [cli.js]） */
  args: string[];
}

let cachedCli: CliCommand | undefined;

/**
 * 解析 openclaw CLI 命令形态。
 * 优先 require.resolve('openclaw')（exports 不含 ./package.json，主入口
 * 可解析）→ 向上定位包根 → bin 字段 → `[node, cli.mjs]`（跨平台、不依赖
 * PATH）；兜底 PATH 上的 `openclaw`。
 */
export function resolveOpenClawCli(): CliCommand {
  if (cachedCli) return cachedCli;
  try {
    const entryPath = require_.resolve('openclaw');
    const pkgRoot = findPackageRoot(path.dirname(entryPath));
    if (pkgRoot) {
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')) as {
        bin?: Record<string, string> | string;
      };
      const binField = pkg.bin;
      const binEntry =
        typeof binField === 'string'
          ? binField
          : binField?.openclaw ?? Object.values(binField ?? {})[0];
      if (binEntry) {
        cachedCli = { cmd: process.execPath, args: [path.resolve(pkgRoot, binEntry)] };
        return cachedCli;
      }
    }
  } catch {
    // openclaw 不可解析（理论上不会——preload 保证 peer 可用）→ 走 PATH
  }
  cachedCli = { cmd: 'openclaw', args: [] };
  return cachedCli;
}

/** 从起始目录向上查找含 package.json 的包根（最多 6 层） */
function findPackageRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** 测试辅助：清除缓存的 CLI 解析结果 */
export function __resetCachedCliForTest(): void {
  cachedCli = undefined;
}

// ── 子进程执行 ─────────────────────────────────────────────────────────────

/** 子进程流的最小结构约定（不依赖 @types/node 全局命名空间） */
interface MinimalReadable {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  on(event: string, listener: (...args: any[]) => void): unknown;
}

interface MinimalWritable {
  write(chunk: string | Uint8Array): unknown;
  end(cb?: () => void): unknown;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  on?(event: string, listener: (...args: any[]) => void): unknown;
}

/** spawn 返回对象的最小结构约定（真实 ChildProcess 结构兼容） */
export interface SpawnLikeChild {
  stdin: MinimalWritable | null;
  stdout: MinimalReadable | null;
  stderr: MinimalReadable | null;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  on(event: string, listener: (...args: any[]) => void): SpawnLikeChild;
  kill(signal?: string | number): void;
}

export type SpawnFn = (
  cmd: string,
  args: readonly string[],
  options: { stdio: ['pipe', 'pipe', 'pipe'] },
) => SpawnLikeChild;

export interface SecretsStoreSetResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** spawn 本身失败（ENOENT 等），已 scrub */
  error?: string;
  /** stdout + stderr 合并摘要，已 scrub */
  output: string;
}

interface ExecCliParams {
  cliArgs: readonly string[];
  /** secret kind 时经 stdin 写入的值 */
  stdinValue?: string;
  timeoutMs: number;
  /** 参与输出清洗的密钥值 */
  secret: string;
  /** 测试注入：覆盖 CLI 入口解析 */
  cliOverride?: CliCommand;
}

function execCli(
  params: ExecCliParams,
  deps: { spawnFn?: SpawnFn } = {},
): Promise<SecretsStoreSetResult> {
  const { spawnFn = spawn as unknown as SpawnFn } = deps;
  const cli = params.cliOverride ?? resolveOpenClawCli();
  return new Promise((resolve) => {
    let child: SpawnLikeChild;
    try {
      child = spawnFn(cli.cmd, [...cli.args, ...params.cliArgs], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        ok: false,
        exitCode: null,
        timedOut: false,
        error: scrubSecret(
          `无法启动 openclaw CLI: ${err instanceof Error ? err.message : String(err)}`,
          params.secret,
        ),
        output: '',
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, params.timeoutMs);
    timer.unref?.();

    const finish = (ok: boolean, exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = scrubSecret(
        `${stdout}${stderr ? (stdout ? '\n' : '') + stderr : ''}`.trim().slice(0, OUTPUT_CAP_CHARS),
        params.secret,
      );
      resolve({ ok, exitCode, timedOut, error: error ? scrubSecret(error, params.secret) : undefined, output });
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < OUTPUT_CAP_CHARS) stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < OUTPUT_CAP_CHARS) stderr += String(chunk);
    });
    child.on('error', (err: unknown) => {
      finish(false, null, `openclaw CLI 执行失败: ${err instanceof Error ? err.message : String(err)}`);
    });
    child.on('close', (code: unknown) => {
      finish(!timedOut && code === 0, typeof code === 'number' ? code : null);
    });

    if (params.stdinValue !== undefined) {
      child.stdin?.on?.('error', () => {/* EPIPE：CLI 提前退出，交给 close 收尾 */});
      child.stdin?.write(params.stdinValue);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
  });
}

/** 执行 openclaw secrets store set（值的合法性校验由调用方先行完成） */
export async function runSecretsStoreSet(
  params: { name: string; kind: SecretStoreKind; value: string },
  deps: { spawnFn?: SpawnFn; cli?: CliCommand } = {},
): Promise<SecretsStoreSetResult> {
  return execCli(
    {
      cliArgs: buildSecretsStoreSetArgs(params.name, params.kind, params.value),
      stdinValue: params.kind === 'secret' ? params.value : undefined,
      timeoutMs: SET_TIMEOUT_MS,
      secret: params.value,
      cliOverride: deps.cli,
    },
    deps,
  );
}

/** best-effort 执行 openclaw secrets reload（写入后被 SecretRef 引用的名字才会即时生效） */
export async function runSecretsReload(
  deps: { spawnFn?: SpawnFn; cli?: CliCommand } = {},
): Promise<boolean> {
  const result = await execCli(
    { cliArgs: ['secrets', 'reload'], timeoutMs: RELOAD_TIMEOUT_MS, secret: '', cliOverride: deps.cli },
    deps,
  );
  return result.ok;
}
