/**
 * STT (Speech-to-Text) 语音转文字服务
 *
 * 支持 OpenAI 兼容的 /audio/transcriptions 接口。
 * 配置优先级：
 *   1. channels.qqbot.stt（插件级）
 *   2. 框架级 audio model 配置
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface STTConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * 平台转写（asr_refer_text）兜底开关。
   * - false（默认，telegram 模式）：配置了自有 STT 后，平台转写完全不参与——
   *   不当兜底、不携带 asrReferText（避免 - ASR: 行把平台文本带进 core）。
   * - true：自有 STT 失败/转空时退回平台转写（旧行为）。
   * 从 channels.qqbot.stt.asrFallback 读取，对插件级与框架探测级 STT 均生效。
   */
  asrFallback: boolean;
}

/**
 * 平台转写（asr_refer_text）参与判定。
 * 仅当未配置 STT（平台转写是唯一来源）或显式 asrFallback: true 时保留；
 * 严格模式下（自有 STT 已生效且未开兜底）平台文本在上游就被丢弃。
 */
export function shouldUsePlatformAsr(sttCfg: STTConfig | null): boolean {
  if (!sttCfg) return true;
  return sttCfg.asrFallback === true;
}

/**
 * 从 OpenClaw 配置中解析 STT 设置
 */
export function resolveSTTConfig(cfg: Record<string, unknown>): STTConfig | null {
  const channels = asRecord(cfg.channels);
  const qqbot = asRecord(channels?.qqbot);
  const sttCfg = asRecord(qqbot?.stt);

  // 显式禁用
  if (sttCfg?.enabled === false) {
    return null;
  }

  // 平台转写兜底默认关闭（telegram 模式）；显式 asrFallback: true 才启用
  const asrFallback = sttCfg?.asrFallback === true;

  const models = asRecord(cfg.models);
  const providers = asRecord(models?.providers);

  // 1. 插件级 STT 配置
  if (sttCfg) {
    const providerId = readString(sttCfg, 'provider') ?? 'openai';
    const providerCfg = asRecord(providers?.[providerId]);
    const baseUrl = readString(sttCfg, 'baseUrl') ?? readString(providerCfg, 'baseUrl');
    const apiKey = readString(sttCfg, 'apiKey') ?? readString(providerCfg, 'apiKey');
    const model = readString(sttCfg, 'model') ?? 'whisper-1';
    if (baseUrl && apiKey) {
      return { enabled: true, baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model, asrFallback };
    }
  }

  // 2. 框架级 audio model fallback
  const tools = asRecord(cfg.tools);
  const media = asRecord(tools?.media);
  const audio = asRecord(media?.audio);
  const audioModels = audio?.models;
  const audioModelEntry = Array.isArray(audioModels) ? asRecord(audioModels[0]) : undefined;
  if (audioModelEntry) {
    const providerId = readString(audioModelEntry, 'provider') ?? 'openai';
    const providerCfg = asRecord(providers?.[providerId]);
    const baseUrl = readString(audioModelEntry, 'baseUrl') ?? readString(providerCfg, 'baseUrl');
    const apiKey = readString(audioModelEntry, 'apiKey') ?? readString(providerCfg, 'apiKey');
    const model = readString(audioModelEntry, 'model') ?? 'whisper-1';
    if (baseUrl && apiKey) {
      return { enabled: true, baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model, asrFallback };
    }
  }

  return null;
}

/**
 * 调用 STT 服务转录音频文件
 */
export async function transcribeAudio(
  audioPath: string,
  cfg: Record<string, unknown>,
): Promise<string | null> {
  const sttCfg = resolveSTTConfig(cfg);
  if (!sttCfg) {
    return null;
  }

  const fileBuffer = fs.readFileSync(audioPath);
  const fileName = sanitizeFileName(path.basename(audioPath));
  const mime = guessMimeType(fileName);

  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: mime }), fileName);
  form.append('model', sttCfg.model);

  const resp = await fetch(`${sttCfg.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sttCfg.apiKey}` },
    body: form,
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`STT failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
  }

  const result = (await resp.json()) as { text?: string };
  return result.text?.trim() || null;
}

// ── 内部工具函数 ──

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function readString(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const val = obj?.[key];
  if (typeof val === 'string' && val.trim()) {
    return val.trim();
  }
  return undefined;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.silk': 'audio/silk',
    '.amr': 'audio/amr',
    '.pcm': 'audio/pcm',
  };
  return mimeMap[ext] ?? 'application/octet-stream';
}
