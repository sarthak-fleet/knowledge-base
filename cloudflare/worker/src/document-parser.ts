import { decompressSync, unzipSync } from 'fflate';
import { recordsFromUnknown } from './schema-inference';
import type { JsonRecord } from './types';

export interface ParsedDocument {
  external_id: string;
  content: string;
  metadata: JsonRecord;
}

export interface ParsedUpload {
  parser: string;
  parser_version: string;
  documents: ParsedDocument[];
  text: string;
  page_count: number;
  record_count: number;
  warnings?: string[];
}

const TEXT_EXTENSIONS = ['.csv', '.json', '.jsonl', '.md', '.ndjson', '.txt'];
const MARKDOWN_ONLY_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.svg',
  '.xls',
  '.xlsm',
  '.xlsb',
  '.ods',
  '.odt',
  '.numbers',
];
type PdfFragment = { x: number; y: number; text: string };
type VisionImage = { bytes: Uint8Array; mime: string; width?: number; height?: number; source_index?: number };
type ByteArray = Uint8Array<ArrayBufferLike>;
type VisionOcrInputVariant = { mode: 'prompt-image' | 'image-url-message'; input: JsonRecord };
const PDF_VISION_IMAGE_LIMIT = 5;
const MIN_DOCUMENT_IMAGE_AREA = 256 * 256;
const MIN_DOCUMENT_IMAGE_SIDE = 128;
const MIN_UNKNOWN_SIZE_IMAGE_BYTES = 8192;

function lowerName(filename: string): string {
  return filename.toLowerCase();
}

function mimeOrExtension(filename: string, mime: string | null | undefined, extensions: string[]): boolean {
  const lower = lowerName(filename);
  return extensions.some((ext) => lower.endsWith(ext)) || extensions.some((ext) => mime?.includes(ext.slice(1)));
}

function decodeUtf8(bytes: ArrayBuffer): string {
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
}

function decodeLatin1(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  return decodeLatin1Bytes(view);
}

function decodeLatin1Bytes(view: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < view.length; i += 8192) {
    chunks.push(String.fromCharCode(...view.slice(i, i + 8192)));
  }
  return chunks.join('');
}

function latin1Bytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) bytes[i] = value.charCodeAt(i) & 0xff;
  return bytes;
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)));
}

function normalizeText(text: string): string {
  return text
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function stripHtml(html: string): string {
  const withoutNoise = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  return normalizeText(decodeXml(withoutNoise.replace(/<[^>]+>/g, ' ')));
}

function pdfLiteral(value: string): string {
  return value.replace(/\\([nrtbf()\\])/g, (_, escaped: string) => {
    if (escaped === 'n') return '\n';
    if (escaped === 'r') return '\r';
    if (escaped === 't') return '\t';
    if (escaped === 'b') return '\b';
    if (escaped === 'f') return '\f';
    return escaped;
  });
}

function decodeAscii85(value: string): Uint8Array {
  const chars = value
    .replace(/^<~/, '')
    .replace(/~>[\s\S]*$/, '')
    .replace(/\s+/g, '');
  const out: number[] = [];
  let group = '';
  for (const char of chars) {
    if (char === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 33 || code > 117) continue;
    group += char;
    if (group.length === 5) {
      let value32 = 0;
      for (const item of group) value32 = value32 * 85 + (item.charCodeAt(0) - 33);
      out.push((value32 >>> 24) & 0xff, (value32 >>> 16) & 0xff, (value32 >>> 8) & 0xff, value32 & 0xff);
      group = '';
    }
  }
  if (group.length > 0) {
    const originalLength = group.length;
    group = group.padEnd(5, 'u');
    let value32 = 0;
    for (const item of group) value32 = value32 * 85 + (item.charCodeAt(0) - 33);
    const bytes = [(value32 >>> 24) & 0xff, (value32 >>> 16) & 0xff, (value32 >>> 8) & 0xff, value32 & 0xff];
    out.push(...bytes.slice(0, originalLength - 1));
  }
  return new Uint8Array(out);
}

function pdfStreamFilters(header: string): string[] {
  const match = header.match(/\/Filter\s*(\[[^\]]+\]|\/[A-Za-z0-9]+)/);
  if (!match?.[1]) return [];
  return [...match[1].matchAll(/\/([A-Za-z0-9]+)/g)].map((item) => item[1] ?? '');
}

function decodePdfStreamBytes(data: string, filters: string[]): Uint8Array | null {
  try {
    let bytes = latin1Bytes(data.replace(/^\r?\n/, '').replace(/\r?\n$/, ''));
    for (const filter of filters) {
      if (filter === 'ASCII85Decode' || filter === 'A85') bytes = decodeAscii85(decodeLatin1Bytes(bytes));
      else if (filter === 'FlateDecode' || filter === 'Fl') bytes = decompressSync(bytes);
      else return null;
    }
    return bytes;
  } catch {
    return null;
  }
}

function decodePdfStream(data: string, filters: string[]): string | null {
  const bytes = decodePdfStreamBytes(data, filters);
  return bytes ? decodeLatin1Bytes(bytes) : null;
}

function pdfNumberAttr(header: string, name: string): number | null {
  const match = header.match(new RegExp(`/${name}\\s+(\\d+)`));
  const value = match?.[1] ? Number(match[1]) : null;
  return value && Number.isFinite(value) ? value : null;
}

function pdfNameAttr(header: string, name: string): string | null {
  return header.match(new RegExp(`/${name}\\s+/([A-Za-z0-9]+)`))?.[1] ?? null;
}

function crc32(bytes: ByteArray): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: ByteArray): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function concatBytes(parts: ByteArray[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function zlibStore(bytes: ByteArray): Uint8Array {
  const parts: ByteArray[] = [new Uint8Array([0x78, 0x01])];
  for (let offset = 0; offset < bytes.length; offset += 65535) {
    const block = bytes.slice(offset, offset + 65535);
    const final = offset + block.length >= bytes.length ? 1 : 0;
    const len = block.length;
    parts.push(new Uint8Array([final, len & 0xff, (len >>> 8) & 0xff, (~len) & 0xff, ((~len) >>> 8) & 0xff]), block);
  }
  parts.push(u32be(adler32(bytes)));
  return concatBytes(parts);
}

function pngChunk(type: string, data: ByteArray = new Uint8Array()): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  return concatBytes([
    u32be(data.length),
    typeBytes,
    data,
    u32be(crc32(concatBytes([typeBytes, data]))),
  ]);
}

function unfilterPngRows(bytes: ByteArray, width: number, height: number, bytesPerPixel: number): Uint8Array | null {
  const rowLength = width * bytesPerPixel;
  if (bytes.length < height * (rowLength + 1)) return null;
  const out = new Uint8Array(height * rowLength);
  for (let y = 0; y < height; y += 1) {
    const filter = bytes[y * (rowLength + 1)];
    const srcOffset = y * (rowLength + 1) + 1;
    const outOffset = y * rowLength;
    for (let x = 0; x < rowLength; x += 1) {
      const raw = bytes[srcOffset + x] ?? 0;
      const left = x >= bytesPerPixel ? out[outOffset + x - bytesPerPixel] ?? 0 : 0;
      const up = y > 0 ? out[outOffset + x - rowLength] ?? 0 : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? out[outOffset + x - rowLength - bytesPerPixel] ?? 0 : 0;
      const paeth = (() => {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        if (pa <= pb && pa <= pc) return left;
        return pb <= pc ? up : upLeft;
      })();
      const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth : null;
      if (predicted === null) return null;
      out[outOffset + x] = (raw + predicted) & 0xff;
    }
  }
  return out;
}

function rawImageToPng(raw: ByteArray, width: number, height: number, colorSpace: string, bitsPerComponent: number): Uint8Array | null {
  if (bitsPerComponent !== 8 || width <= 0 || height <= 0) return null;
  const colorType = colorSpace === 'DeviceGray' ? 0 : colorSpace === 'DeviceRGB' ? 2 : null;
  if (colorType === null) return null;
  const bytesPerPixel = colorType === 0 ? 1 : 3;
  const rowLength = width * bytesPerPixel;
  const pixels = raw.length >= height * (rowLength + 1)
    ? unfilterPngRows(raw, width, height, bytesPerPixel)
    : raw.slice(0, height * rowLength);
  if (!pixels || pixels.length < height * rowLength) return null;
  const scanlines = new Uint8Array(height * (rowLength + 1));
  for (let y = 0; y < height; y += 1) {
    scanlines[y * (rowLength + 1)] = 0;
    scanlines.set(pixels.slice(y * rowLength, (y + 1) * rowLength), y * (rowLength + 1) + 1);
  }
  const ihdr = concatBytes([
    u32be(width),
    u32be(height),
    new Uint8Array([8, colorType, 0, 0, 0]),
  ]);
  return concatBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlibStore(scanlines)),
    pngChunk('IEND'),
  ]);
}

function pdfImages(bytes: ArrayBuffer): VisionImage[] {
  const raw = decodeLatin1(bytes);
  const images: VisionImage[] = [];
  for (const match of raw.matchAll(/stream\r?\n?([\s\S]*?)\r?\n?endstream/g)) {
    const sourceIndex = images.length + 1;
    const streamStart = match.index ?? 0;
    const headerStart = raw.lastIndexOf('<<', streamStart);
    const header = headerStart >= 0 ? raw.slice(headerStart, streamStart) : '';
    const filters = pdfStreamFilters(header);
    if (!/\/Subtype\s*\/Image\b/.test(header)) continue;
    const data = (match[1] ?? '').replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    const width = pdfNumberAttr(header, 'Width') ?? undefined;
    const height = pdfNumberAttr(header, 'Height') ?? undefined;
    if (filters.includes('DCTDecode')) {
      images.push({
        bytes: latin1Bytes(data),
        mime: 'image/jpeg',
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        source_index: sourceIndex,
      });
      continue;
    }
    if (filters.includes('JPXDecode')) {
      images.push({
        bytes: latin1Bytes(data),
        mime: 'image/jp2',
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        source_index: sourceIndex,
      });
      continue;
    }
    if (filters.includes('FlateDecode') || filters.includes('Fl')) {
      const decoded = decodePdfStreamBytes(data, filters);
      const bitsPerComponent = pdfNumberAttr(header, 'BitsPerComponent') ?? 8;
      const colorSpace = pdfNameAttr(header, 'ColorSpace') ?? 'DeviceRGB';
      if (decoded && width && height) {
        const png = rawImageToPng(decoded, width, height, colorSpace, bitsPerComponent);
        if (png) images.push({ bytes: png, mime: 'image/png', width, height, source_index: sourceIndex });
      }
    }
  }
  return images;
}

function visionImageArea(image: VisionImage): number {
  return image.width && image.height ? image.width * image.height : 0;
}

function isLikelyDocumentImage(image: VisionImage): boolean {
  const area = visionImageArea(image);
  if (area > 0) {
    return (image.width ?? 0) >= MIN_DOCUMENT_IMAGE_SIDE
      && (image.height ?? 0) >= MIN_DOCUMENT_IMAGE_SIDE
      && area >= MIN_DOCUMENT_IMAGE_AREA;
  }
  return image.bytes.length >= MIN_UNKNOWN_SIZE_IMAGE_BYTES;
}

function selectPdfVisionImages(images: VisionImage[]): VisionImage[] {
  const candidates = images.map((image, index) => ({ image, index, score: visionImageArea(image) || image.bytes.length }));
  const pageLike = candidates.filter((candidate) => isLikelyDocumentImage(candidate.image));
  const pool = pageLike.length > 0 ? pageLike : candidates;
  return pool
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, PDF_VISION_IMAGE_LIMIT)
    .sort((a, b) => a.index - b.index)
    .map((candidate) => candidate.image);
}

function pdfSourceText(bytes: ArrayBuffer): string {
  const raw = decodeLatin1(bytes);
  const decodedStreams: string[] = [];
  for (const match of raw.matchAll(/stream\r?\n?([\s\S]*?)\r?\n?endstream/g)) {
    const streamStart = match.index ?? 0;
    const headerStart = raw.lastIndexOf('<<', streamStart);
    const header = headerStart >= 0 ? raw.slice(headerStart, streamStart) : '';
    const decoded = decodePdfStream(match[1] ?? '', pdfStreamFilters(header));
    if (decoded) decodedStreams.push(decoded);
  }
  return [raw, ...decodedStreams].join('\n');
}

function parsePdfText(bytes: ArrayBuffer): string {
  const raw = pdfSourceText(bytes);
  const parts: string[] = [];
  for (const match of raw.matchAll(/\((?:\\.|[^\\)]){2,}\)\s*Tj/g)) {
    parts.push(pdfLiteral(match[0].replace(/\)\s*Tj$/, '').slice(1)));
  }
  for (const match of raw.matchAll(/\[((?:\s*\((?:\\.|[^\\)])*\)\s*)+)\]\s*TJ/g)) {
    const inner = match[1] ?? '';
    for (const literal of inner.matchAll(/\((?:\\.|[^\\)])*\)/g)) {
      parts.push(pdfLiteral(literal[0].slice(1, -1)));
    }
  }
  for (const match of raw.matchAll(/<([0-9a-f\s]{6,})>\s*Tj/gi)) {
    const hex = (match[1] ?? '').replace(/\s+/g, '');
    const chars: string[] = [];
    for (let i = 0; i + 1 < hex.length; i += 2) {
      const code = Number.parseInt(hex.slice(i, i + 2), 16);
      if (Number.isFinite(code) && code >= 32) chars.push(String.fromCharCode(code));
    }
    if (chars.length > 0) parts.push(chars.join(''));
  }
  if (parts.length > 0) return normalizeText(parts.join('\n'));
  return '';
}

function parsePdfArrayText(value: string): string {
  const parts: string[] = [];
  for (const literal of value.matchAll(/\((?:\\.|[^\\)])*\)/g)) {
    parts.push(pdfLiteral(literal[0].slice(1, -1)));
  }
  return parts.join('');
}

function parsePdfHexText(value: string): string {
  const hex = value.replace(/\s+/g, '');
  const chars: string[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isFinite(code) && code >= 32) chars.push(String.fromCharCode(code));
  }
  return chars.join('');
}

function parsePdfFragments(bytes: ArrayBuffer): PdfFragment[] {
  const raw = pdfSourceText(bytes);
  const fragments: PdfFragment[] = [];
  let x = 0;
  let y = 0;
  const tokenRe = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Tm|(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Td|\((?:\\.|[^\\)])*\)\s*Tj|\[((?:\s*\((?:\\.|[^\\)])*\)\s*-?\d*(?:\.\d+)?\s*)+)\]\s*TJ|<([0-9a-f\s]{6,})>\s*Tj/gi;
  for (const match of raw.matchAll(tokenRe)) {
    const token = match[0];
    if (match[5] !== undefined && match[6] !== undefined) {
      x = Number(match[5]);
      y = Number(match[6]);
      continue;
    }
    if (match[7] !== undefined && match[8] !== undefined) {
      x += Number(match[7]);
      y += Number(match[8]);
      continue;
    }
    let text = '';
    if (token.endsWith('TJ')) text = parsePdfArrayText(match[9] ?? '');
    else if (match[10] !== undefined) text = parsePdfHexText(match[10]);
    else text = pdfLiteral(token.replace(/\)\s*Tj$/i, '').slice(1));
    const normalized = normalizeText(text);
    if (normalized) fragments.push({ x, y, text: normalized });
  }
  return fragments;
}

function groupPdfRows(fragments: PdfFragment[]): PdfFragment[][] {
  const rowTolerance = 3;
  const rows: PdfFragment[][] = [];
  for (const fragment of [...fragments].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((candidate) => Math.abs((candidate[0]?.y ?? fragment.y) - fragment.y) <= rowTolerance);
    if (row) row.push(fragment);
    else rows.push([fragment]);
  }
  return rows.map((row) => row.sort((a, b) => a.x - b.x));
}

function markdownTableFromRows(rows: PdfFragment[][]): string | null {
  const candidateRows = rows
    .filter((row) => row.length >= 2)
    .map((row) => row.map((cell) => cell.text.replace(/\|/g, '\\|')));
  if (candidateRows.length < 2) return null;
  const width = Math.max(...candidateRows.map((row) => row.length));
  if (width < 2) return null;
  const normalized = candidateRows.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''));
  const header = normalized[0] ?? [];
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...normalized.slice(1).map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function parsePdf(filename: string, bytes: ArrayBuffer): ParsedUpload {
  const text = parsePdfText(bytes);
  const fragments = parsePdfFragments(bytes);
  const rows = groupPdfRows(fragments);
  const rowText = normalizeText(rows.map((row) => row.map((cell) => cell.text).join(' | ')).join('\n'));
  const table = markdownTableFromRows(rows);
  const content = normalizeText([rowText || text, table ? `Detected table:\n${table}` : ''].filter(Boolean).join('\n\n'));
  const documents: ParsedDocument[] = [];
  if (content) {
    documents.push({
      external_id: filename,
      content,
      metadata: {
        filename,
        parser_source: 'pdf',
        parser_layout: fragments.length > 0,
        parser_table_rows: table ? rows.filter((row) => row.length >= 2).length : 0,
      },
    });
  }
  if (table) {
    documents.push({
      external_id: `${filename}:table:1`,
      content: table,
      metadata: {
        filename,
        table_index: 1,
        parser_source: 'pdf',
        parser_layout: true,
        parser_table: true,
      },
    });
  }
  return {
    parser: fragments.length > 0 ? 'worker-pdf-layout-v2' : 'worker-pdf-text-v1',
    parser_version: fragments.length > 0 ? '2' : '1',
    documents,
    text: content || text,
    page_count: Math.max(1, (decodeLatin1(bytes).match(/\/Type\s*\/Page\b/g) ?? []).length),
    record_count: table ? 1 : 0,
  };
}

function xmlText(node: string): string {
  const normalized = node
    .replace(/<(?:\w+:)?tab\b[^>]*\/>/g, '\t')
    .replace(/<(?:\w+:)?br\b[^>]*\/>/g, '\n');
  return decodeXml(
    [...normalized.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)]
      .map((match) => match[1] ?? '')
      .join(''),
  );
}

function readZipText(files: Record<string, Uint8Array>, path: string): string | null {
  const bytes = files[path];
  return bytes ? new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes) : null;
}

function parseWorkbookSheets(files: Record<string, Uint8Array>): Array<{ name: string; path: string }> {
  const workbook = readZipText(files, 'xl/workbook.xml');
  const rels = readZipText(files, 'xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) {
    return Object.keys(files)
      .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
      .sort()
      .map((path, i) => ({ name: `Sheet${i + 1}`, path }));
  }
  const relTargets = new Map<string, string>();
  for (const rel of rels.matchAll(/<Relationship\b([^>]+)>/g)) {
    const attrs = rel[1] ?? '';
    const id = attrs.match(/\bId="([^"]+)"/)?.[1];
    const target = attrs.match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) relTargets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\.\//, '')}`);
  }
  return [...workbook.matchAll(/<sheet\b([^>]+)>/g)].map((sheet, i) => {
    const attrs = sheet[1] ?? '';
    const name = decodeXml(attrs.match(/\bname="([^"]+)"/)?.[1] ?? `Sheet${i + 1}`);
    const relId = attrs.match(/\br:id="([^"]+)"/)?.[1];
    return { name, path: (relId && relTargets.get(relId)) || `xl/worksheets/sheet${i + 1}.xml` };
  });
}

function parseXlsxRows(bytes: ArrayBuffer): Array<{ sheet: string; row: number; values: string[] }> {
  const files = unzipSync(new Uint8Array(bytes));
  const sharedXml = readZipText(files, 'xl/sharedStrings.xml') ?? '';
  const sharedStrings = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => xmlText(match[1] ?? ''));
  const rows: Array<{ sheet: string; row: number; values: string[] }> = [];
  for (const sheet of parseWorkbookSheets(files)) {
    const xml = readZipText(files, sheet.path);
    if (!xml) continue;
    for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const rowNumber = Number(rowMatch[1]?.match(/\br="(\d+)"/)?.[1] ?? rows.length + 1);
      const values: string[] = [];
      for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cellMatch[1] ?? '';
        const cell = cellMatch[2] ?? '';
        const type = attrs.match(/\bt="([^"]+)"/)?.[1];
        const inline = xmlText(cell);
        const raw = decodeXml(cell.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '');
        if (type === 's') values.push(sharedStrings[Number(raw)] ?? raw);
        else if (type === 'inlineStr') values.push(inline);
        else values.push(inline || raw);
      }
      if (values.some((value) => value.trim())) rows.push({ sheet: sheet.name, row: rowNumber, values });
    }
  }
  return rows;
}

function documentsFromRecords(filename: string, records: JsonRecord[], source: string): ParsedDocument[] {
  return records.slice(0, 500).map((record, i) => ({
    external_id: `${filename}:record:${i}`,
    content: JSON.stringify(record, null, 2),
    metadata: { filename, record_index: i, record, parser_source: source },
  }));
}

function documentsFromText(filename: string, text: string, parser: string): ParsedDocument[] {
  const records = recordsFromUnknown(text);
  if (records.length > 0) return documentsFromRecords(filename, records, parser);
  return [{ external_id: filename, content: text, metadata: { filename, parser_source: parser } }];
}

function isMarkdownOnlyCandidate(filename: string, mime: string | null | undefined): boolean {
  const lower = lowerName(filename);
  if (MARKDOWN_ONLY_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  if (mime?.startsWith('image/')) return true;
  if (mime?.includes('opendocument')) return true;
  if (mime?.includes('vnd.apple.numbers')) return true;
  if (mime === 'application/vnd.ms-excel') return true;
  if (mime?.includes('sheet.macroenabled') || mime?.includes('sheet.binary')) return true;
  return false;
}

function normalizedVisionImageMime(filename: string, mime: string | null | undefined): string | null {
  const normalizedMime = (mime ?? '').split(';')[0]?.trim().toLowerCase();
  if (normalizedMime === 'image/jpeg' || normalizedMime === 'image/png' || normalizedMime === 'image/webp') return normalizedMime;
  const lower = lowerName(filename);
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return null;
}

function uploadVisionImage(filename: string, mime: string | null | undefined, bytes: ArrayBuffer): VisionImage | null {
  const imageMime = normalizedVisionImageMime(filename, mime);
  if (!imageMime) return null;
  return { bytes: new Uint8Array(bytes), mime: imageMime };
}

function isMarkdownConversionCandidate(filename: string, mime: string | null | undefined): boolean {
  const lower = lowerName(filename);
  return isMarkdownOnlyCandidate(filename, mime)
    || lower.endsWith('.pdf')
    || mime === 'application/pdf'
    || lower.endsWith('.docx')
    || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || lower.endsWith('.html')
    || lower.endsWith('.htm')
    || Boolean(mime?.includes('html'));
}

function textWordCount(text: string): number {
  return (text.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu) ?? []).length;
}

function shouldUseMarkdownConversion(
  filename: string,
  mime: string | null | undefined,
  local: ParsedUpload,
  mode: string,
): boolean {
  const normalizedMode = mode.trim().toLowerCase();
  if (normalizedMode === 'false' || normalizedMode === 'off' || normalizedMode === 'never') return false;
  if (!isMarkdownConversionCandidate(filename, mime)) return false;
  if (normalizedMode === 'always') return true;
  if (isMarkdownOnlyCandidate(filename, mime)) return true;
  return local.documents.length === 0 || textWordCount(local.text) < 8;
}

function tableDocumentsFromMarkdown(filename: string, markdown: string): ParsedDocument[] {
  const documents: ParsedDocument[] = [];
  const tableBlocks = markdown.match(/(?:^\|.*\|\s*$\n?){2,}/gm) ?? [];
  tableBlocks.slice(0, 100).forEach((table, i) => {
    const content = normalizeText(table);
    if (!content) return;
    documents.push({
      external_id: `${filename}:markdown-table:${i + 1}`,
      content,
      metadata: {
        filename,
        table_index: i + 1,
        parser_source: 'workers-ai-markdown',
        parser_table: true,
      },
    });
  });
  return documents;
}

function parsedFromMarkdownConversion(filename: string, mime: string | null | undefined, markdown: string, tokens: number | null): ParsedUpload {
  const text = normalizeText(markdown);
  const tableDocs = tableDocumentsFromMarkdown(filename, text);
  const documents = [
    {
      external_id: filename,
      content: text,
      metadata: {
        filename,
        mime: mime ?? null,
        parser_source: 'workers-ai-markdown',
        markdown_tokens: tokens,
      },
    },
    ...tableDocs,
  ];
  return {
    parser: 'workers-ai-markdown-v1',
    parser_version: '1',
    documents,
    text,
    page_count: Math.max(1, tableDocs.length),
    record_count: tableDocs.length,
  };
}

function mergeParsedUploads(primary: ParsedUpload, secondary: ParsedUpload): ParsedUpload {
  const blocks: string[] = [];
  for (const block of [primary.text, secondary.text]) {
    const normalized = normalizeText(block);
    if (normalized && !blocks.includes(normalized)) blocks.push(normalized);
  }
  return {
    parser: 'workers-ai-vision-markdown-ocr-v1',
    parser_version: '1',
    documents: [...primary.documents, ...secondary.documents],
    text: normalizeText(blocks.join('\n\n')),
    page_count: Math.max(primary.page_count, secondary.page_count),
    record_count: primary.record_count + secondary.record_count,
    warnings: [...(primary.warnings ?? []), ...(secondary.warnings ?? [])],
  };
}

function textFromAiResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  const record = result as Record<string, unknown>;
  for (const key of ['response', 'result', 'text', 'description']) {
    if (typeof record[key] === 'string') return record[key];
  }
  return '';
}

function base64Bytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.slice(i, i + 8192));
  }
  return btoa(binary);
}

function parseVisionOcrModels(modelSpec: string): string[] {
  return modelSpec
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
}

function supportsImageUrlMessage(model: string): boolean {
  return model.includes('llama-3.2-11b-vision-instruct') || model.includes('llama-4-scout-17b-16e-instruct');
}

function prefersDirectImageInput(model: string): boolean {
  return model.includes('llama-3.2-11b-vision-instruct');
}

function visionOcrPrompt(): string {
  return [
    'You are a strict OCR transcription engine.',
    'Transcribe every visible word, number, table cell, header, footer, and paragraph exactly as it appears.',
    'Do not describe the page, summarize, infer missing text, or add commentary.',
    'Preserve reading order and line breaks where practical.',
    'Return only the transcription text.',
  ].join(' ');
}

function visionOcrUserPrompt(page: number, totalPages: number): string {
  return `Transcribe scanned document image ${page} of ${totalPages}. Return exact OCR text only.`;
}

function directImageOcrInput(image: VisionImage, page: number, totalPages: number): JsonRecord {
  return {
    prompt: `${visionOcrPrompt()}\n\n${visionOcrUserPrompt(page, totalPages)}`,
    image: Array.from(image.bytes),
    max_tokens: 1800,
    temperature: 0,
  };
}

function imageUrlOcrInput(image: VisionImage, page: number, totalPages: number): JsonRecord {
  const userPrompt = `Transcribe scanned document image ${page} of ${totalPages}. Return exact OCR text only.`;
  const imageUrl = `data:${image.mime};base64,${base64Bytes(image.bytes)}`;
  return {
    messages: [
      { role: 'system', content: visionOcrPrompt() },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
    max_tokens: 1800,
    temperature: 0,
  };
}

function visionOcrInputVariants(model: string, image: VisionImage, page: number, totalPages: number): VisionOcrInputVariant[] {
  const variants: VisionOcrInputVariant[] = [];
  if (prefersDirectImageInput(model)) variants.push({ mode: 'prompt-image', input: directImageOcrInput(image, page, totalPages) });
  if (supportsImageUrlMessage(model)) variants.push({ mode: 'image-url-message', input: imageUrlOcrInput(image, page, totalPages) });
  if (variants.length === 0) variants.push({ mode: 'prompt-image', input: directImageOcrInput(image, page, totalPages) });
  return variants;
}

async function convertImagesWithVision(
  filename: string,
  mime: string | null | undefined,
  images: VisionImage[],
  ai: Ai,
  model: string,
  source: 'page' | 'image',
): Promise<ParsedUpload | null> {
  const models = parseVisionOcrModels(model);
  if (models.length === 0) return null;
  const runner = ai as unknown as { run?: (model: string, input: unknown) => Promise<unknown> };
  if (typeof runner.run !== 'function') return null;
  if (images.length === 0) return null;
  const documents: ParsedDocument[] = [];
  const warnings: string[] = [];
  for (const [i, image] of images.entries()) {
    let pageConverted = false;
    for (const trimmedModel of models) {
      for (const variant of visionOcrInputVariants(trimmedModel, image, i + 1, images.length)) {
        try {
          const result = await runner.run(trimmedModel, variant.input);
          const content = normalizeText(textFromAiResult(result));
          if (!content) {
            warnings.push(`vision_model_empty:${trimmedModel}:${variant.mode}`.slice(0, 220));
            continue;
          }
          documents.push({
            external_id: `${filename}:vision-${source}:${i + 1}`,
            content,
            metadata: {
              filename,
              mime: mime ?? null,
              ...(source === 'page' ? { page: i + 1 } : { image_index: i + 1 }),
              ...(image.source_index ? { vision_source_index: image.source_index } : {}),
              ...(image.width ? { image_width: image.width } : {}),
              ...(image.height ? { image_height: image.height } : {}),
              parser_source: 'workers-ai-vision-ocr',
              vision_model: trimmedModel,
              vision_input: variant.mode,
            },
          });
          pageConverted = true;
          break;
        } catch (error) {
          warnings.push(`vision_model_failed:${trimmedModel}:${variant.mode}:${error instanceof Error ? error.message : String(error)}`.slice(0, 220));
        }
      }
      if (pageConverted) break;
    }
  }
  const text = normalizeText(documents.map((doc) => doc.content).join('\n\n'));
  if (!text) {
    if (warnings.length > 0) throw new Error(warnings.join('; '));
    return null;
  }
  return {
    parser: 'workers-ai-vision-ocr-v1',
    parser_version: '1',
    documents,
    text,
    page_count: documents.length,
    record_count: 0,
    warnings,
  };
}

async function convertPdfImagesWithVision(
  filename: string,
  mime: string | null | undefined,
  bytes: ArrayBuffer,
  ai: Ai,
  model: string,
): Promise<ParsedUpload | null> {
  return convertImagesWithVision(filename, mime, selectPdfVisionImages(pdfImages(bytes)), ai, model, 'page');
}

async function convertUploadImageWithVision(
  filename: string,
  mime: string | null | undefined,
  bytes: ArrayBuffer,
  ai: Ai,
  model: string,
): Promise<ParsedUpload | null> {
  const image = uploadVisionImage(filename, mime, bytes);
  if (!image) return null;
  return convertImagesWithVision(filename, mime, [image], ai, model, 'image');
}

async function convertWithMarkdown(
  filename: string,
  mime: string | null | undefined,
  bytes: ArrayBuffer,
  ai: Ai,
): Promise<ParsedUpload | null> {
  if (typeof ai.toMarkdown !== 'function') return null;
  const result = await ai.toMarkdown({
    name: filename,
    blob: new Blob([bytes], { type: mime || 'application/octet-stream' }),
  }, {
    conversionOptions: {
      html: { images: { convert: true, maxConvertedImages: 4 } },
      docx: { images: { convert: true, maxConvertedImages: 4 } },
      pdf: { metadata: true, images: { convert: true, maxConvertedImages: 4 } },
      image: { descriptionLanguage: 'en' },
    },
  });
  if (Array.isArray(result)) return null;
  if (result.format === 'error') return null;
  if (!result.data.trim()) return null;
  return parsedFromMarkdownConversion(filename, mime, result.data, result.tokens);
}

function parseXlsx(filename: string, bytes: ArrayBuffer): ParsedUpload {
  const rows = parseXlsxRows(bytes);
  const documents: ParsedDocument[] = [];
  const headersBySheet = new Map<string, string[]>();
  for (const row of rows) {
    const existingHeader = headersBySheet.get(row.sheet);
    if (!existingHeader) {
      headersBySheet.set(row.sheet, row.values.map((value, i) => value.trim() || `column_${i + 1}`));
      documents.push({
        external_id: `${filename}:${row.sheet}:header`,
        content: `Sheet '${row.sheet}' header: ${row.values.join(' | ')}\n[${row.sheet}] header: ${row.values.join(' | ')}`,
        metadata: { filename, sheet: row.sheet, row: row.row, is_header: true, parser_source: 'xlsx' },
      });
      continue;
    }
    const record: JsonRecord = {};
    existingHeader.forEach((header, i) => {
      const raw = row.values[i]?.trim() ?? '';
      const numeric = Number(raw);
      record[header] = raw && Number.isFinite(numeric) ? numeric : raw;
    });
    const content = `[${row.sheet}] ` + existingHeader.map((header, i) => `${header}: ${row.values[i] ?? ''}`).join(' | ');
    documents.push({
      external_id: `${filename}:${row.sheet}:row:${row.row}`,
      content,
      metadata: { filename, sheet: row.sheet, row: row.row, is_header: false, record, parser_source: 'xlsx' },
    });
  }
  const text = normalizeText(documents.map((doc) => doc.content).join('\n'));
  return {
    parser: 'worker-xlsx-xml-v1',
    parser_version: '1',
    documents,
    text,
    page_count: 0,
    record_count: documents.filter((doc) => doc.metadata.record).length,
  };
}

function parseDocx(filename: string, bytes: ArrayBuffer): ParsedUpload {
  const files = unzipSync(new Uint8Array(bytes));
  const xml = readZipText(files, 'word/document.xml');
  if (!xml) {
    return { parser: 'worker-docx-xml-v1', parser_version: '1', documents: [], text: '', page_count: 0, record_count: 0 };
  }
  const paragraphs = [...xml.matchAll(/<(?:\w+:)?p\b[^>]*>([\s\S]*?)<\/(?:\w+:)?p>/g)]
    .map((match) => normalizeText(xmlText(match[1] ?? '')))
    .filter(Boolean);
  const text = normalizeText(paragraphs.join('\n\n'));
  const documents = paragraphs.map((paragraph, i) => ({
    external_id: `${filename}:paragraph:${i + 1}`,
    content: paragraph,
    metadata: { filename, paragraph: i + 1, parser_source: 'docx' },
  }));
  return {
    parser: 'worker-docx-xml-v1',
    parser_version: '1',
    documents: documents.length > 0 ? documents : documentsFromText(filename, text, 'docx'),
    text,
    page_count: 0,
    record_count: 0,
  };
}

function parsePptx(filename: string, bytes: ArrayBuffer): ParsedUpload {
  const files = unzipSync(new Uint8Array(bytes));
  const slidePaths = Object.keys(files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0));
  const documents: ParsedDocument[] = [];
  for (const path of slidePaths) {
    const xml = readZipText(files, path);
    if (!xml) continue;
    const slide = Number(path.match(/slide(\d+)\.xml$/)?.[1] ?? documents.length + 1);
    const paragraphs = [...xml.matchAll(/<(?:\w+:)?p\b[^>]*>([\s\S]*?)<\/(?:\w+:)?p>/g)]
      .map((match) => normalizeText(xmlText(match[1] ?? '')))
      .filter(Boolean);
    const text = normalizeText((paragraphs.length > 0 ? paragraphs : [xmlText(xml)]).join(' '));
    if (!text) continue;
    documents.push({
      external_id: `${filename}:slide:${slide}`,
      content: `[Slide ${slide}] ${text}`,
      metadata: { filename, slide, parser_source: 'pptx' },
    });
  }
  const text = normalizeText(documents.map((doc) => doc.content).join('\n\n'));
  return {
    parser: 'worker-pptx-xml-v1',
    parser_version: '1',
    documents,
    text,
    page_count: documents.length,
    record_count: 0,
  };
}

export function parseUploadBytes(filename: string, mime: string | null | undefined, bytes: ArrayBuffer): ParsedUpload {
  const lower = lowerName(filename);
  if (lower.endsWith('.xlsx') || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return parseXlsx(filename, bytes);
  }
  if (lower.endsWith('.docx') || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return parseDocx(filename, bytes);
  }
  if (lower.endsWith('.pptx') || mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
    return parsePptx(filename, bytes);
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm') || mime?.includes('html')) {
    const text = stripHtml(decodeUtf8(bytes));
    return {
      parser: 'worker-html-text-v1',
      parser_version: '1',
      documents: documentsFromText(filename, text, 'html'),
      text,
      page_count: 1,
      record_count: recordsFromUnknown(text).length,
    };
  }
  if (lower.endsWith('.pdf') || mime === 'application/pdf') {
    return parsePdf(filename, bytes);
  }
  const text = normalizeText(decodeUtf8(bytes));
  const parser = mimeOrExtension(filename, mime, TEXT_EXTENSIONS) ? 'worker-text-structured-v1' : 'worker-text-fallback-v1';
  return {
    parser,
    parser_version: '1',
    documents: documentsFromText(filename, text, parser),
    text,
    page_count: 1,
    record_count: recordsFromUnknown(text).length,
  };
}

export async function parseUploadBytesWithCloudflare(
  filename: string,
  mime: string | null | undefined,
  bytes: ArrayBuffer,
  ai: Ai | null | undefined,
  markdownConversionMode = 'auto',
  visionOcrModel = '',
): Promise<ParsedUpload> {
  const local = parseUploadBytes(filename, mime, bytes);
  if (!ai) return local;
  const useMarkdownConversion = shouldUseMarkdownConversion(filename, mime, local, markdownConversionMode);
  const warnings: string[] = [];
  let visionConverted: ParsedUpload | null = null;
  const hasVisionModel = parseVisionOcrModels(visionOcrModel).length > 0;
  const pdfNeedsVisionOcr = (lowerName(filename).endsWith('.pdf') || mime === 'application/pdf')
    && (local.documents.length === 0 || textWordCount(local.text) < 8);
  const imageNeedsVisionOcr = uploadVisionImage(filename, mime, bytes) !== null;
  if (hasVisionModel && (pdfNeedsVisionOcr || imageNeedsVisionOcr)) {
    try {
      visionConverted = pdfNeedsVisionOcr
        ? await convertPdfImagesWithVision(filename, mime, bytes, ai, visionOcrModel)
        : await convertUploadImageWithVision(filename, mime, bytes, ai, visionOcrModel);
    } catch (error) {
      warnings.push(`vision_ocr_failed:${error instanceof Error ? error.message : String(error)}`.slice(0, 220));
    }
  }
  if (!useMarkdownConversion) {
    if (visionConverted) return warnings.length > 0 ? { ...visionConverted, warnings: [...(visionConverted.warnings ?? []), ...warnings] } : visionConverted;
    return warnings.length > 0 ? { ...local, warnings } : local;
  }
  try {
    const converted = await convertWithMarkdown(filename, mime, bytes, ai);
    if (converted && visionConverted) {
      const merged = mergeParsedUploads(visionConverted, converted);
      return warnings.length > 0 ? { ...merged, warnings: [...(merged.warnings ?? []), ...warnings] } : merged;
    }
    if (converted && warnings.length > 0) return { ...converted, warnings: [...(converted.warnings ?? []), ...warnings] };
    if (visionConverted) return warnings.length > 0 ? { ...visionConverted, warnings } : visionConverted;
    return converted ?? (warnings.length > 0 ? { ...local, warnings } : local);
  } catch (error) {
    warnings.push(`markdown_conversion_failed:${error instanceof Error ? error.message : String(error)}`.slice(0, 220));
    if (visionConverted) return { ...visionConverted, warnings: [...(visionConverted.warnings ?? []), ...warnings] };
    return warnings.length > 0 ? { ...local, warnings } : local;
  }
}
