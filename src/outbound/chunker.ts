/**
 * QQBot Markdown 文本分块
 *
 * 优先使用框架 runtime 提供的 chunkMarkdownText（高版本）；
 * 不可用时回退到本地 GFM 表格感知 chunker —— 保证不在表格内部切分。
 */

import { getAdapters } from '../adapter/resolve.js';
import { tryGetQQBotRuntime } from '../runtime.js';

// ── GFM 表格检测 ──

/** GFM 表格数据行: | col1 | col2 | */
const GFM_TABLE_DATA_RE = /^\|.+\|.*\|/;
/** GFM 表格分隔行: |---|:---:|---| (1 个或多于 1 个破折号，支持对齐冒号) */
const GFM_TABLE_SEP_RE = /^\|[\s:-]+\|/;

/**
 * 判断一行是否为 GFM 表格行（数据行或分隔行）。
 * 保障 table-aware chunker 不会在表格内部切分。
 */
function isGfmTableLine(line: string): boolean {
  return GFM_TABLE_DATA_RE.test(line) || GFM_TABLE_SEP_RE.test(line);
}

/**
 * 表格感知 fallback chunker：按换行边界切分，整块缓冲表格行。
 */
export function chunkMarkdownPreservingTables(text: string, limit: number): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let current = '';
  let tableBuffer: string[] = [];

  const flushTable = () => {
    if (tableBuffer.length === 0) return;
    const tableBlock = tableBuffer.join('\n');
    const candidate = current ? `${current}\n${tableBlock}` : tableBlock;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = tableBlock;
    } else {
      current = candidate;
    }
    tableBuffer = [];
  };

  for (const line of lines) {
    if (isGfmTableLine(line)) {
      tableBuffer.push(line);
      continue;
    }

    // 遇到非表格行，先刷新缓冲的表格
    flushTable();

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  // 处理末尾的表格缓冲
  flushTable();
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}

/**
 * chunker 入口（框架 ChannelOutboundAdapter.chunker 契约）：
 * runtime adapter 的 chunkMarkdownText 优先，低版本降级到本地实现。
 */
export function chunkQQBotMarkdown(text: string, limit: number): string[] {
  const rt = tryGetQQBotRuntime();
  const adapterChunker = rt ? getAdapters(rt).chunkMarkdownText : null;
  if (adapterChunker) return adapterChunker(text, limit);
  return chunkMarkdownPreservingTables(text, limit);
}
