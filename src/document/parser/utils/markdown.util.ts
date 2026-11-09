/** 规范化 Markdown：统一换行，压缩连续空行，去首尾空白 */
export function cleanMarkdown(text: string): string {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/** 转义表格单元格中的 `|`，并把换行压成空格，避免破坏表结构 */
export function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * 二维数组 → Markdown 表格（首行作表头，第二行输出 `| --- |` 分隔）。
 * 列数按所有行的最大列对齐，缺省单元格视为空串。
 */
export function toMarkdownTable(rows: string[][]): string {
  if (!rows.length) return '';

  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (maxCols === 0) return '';

  const lines: string[] = [];
  for (let r = 0; r < rows.length; r++) {
    const cells: string[] = [];
    for (let c = 0; c < maxCols; c++) {
      cells.push(escapeTableCell(rows[r][c] ?? ''));
    }
    lines.push(`| ${cells.join(' | ')} |`);
    if (r === 0) {
      lines.push(`| ${Array(maxCols).fill('---').join(' | ')} |`);
    }
  }
  return `${lines.join('\n')}\n\n`;
}

/** 取文件扩展名（小写，不含点）；无扩展名时返回空串 */
export function getExtension(filename?: string | null): string {
  if (!filename || !filename.includes('.')) return '';
  return filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
}

/** 还原按 Latin-1 接收的 UTF-8 或 Windows GBK 上传文件名。 */
export function decodeUploadFilename(filename?: string | null): string {
  if (!filename) return '';
  if (/[\u0100-\u{10ffff}]/u.test(filename)) return filename;

  const bytes = Buffer.from(filename, 'latin1');
  // shortcut: 未声明编码时优先 UTF-8，回退 GB18030；需消除歧义时由客户端声明编码。
  for (const encoding of ['utf-8', 'gb18030']) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      // 当前编码不能完整解码时尝试下一种。
    }
  }
  return filename;
}

/** 去掉扩展名作为文档标题；空文件名时返回「未命名文档」 */
export function titleFromFilename(filename?: string | null): string {
  if (!filename) return '未命名文档';
  const idx = filename.lastIndexOf('.');
  return idx > 0 ? filename.slice(0, idx) : filename;
}
