#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const DEFAULT_BASE_URL = 'http://localhost:8787';
const DEFAULT_MAX_CASES_PER_BATCH = 8;
const DEFAULT_MAX_BATCH_BYTES = 6_000_000;

function usage() {
  console.error(`Usage:
  node scripts/legacy-parse-eval.mjs --export legacy-kb-export.json --raw-root /tmp/kb-raw-export --parse-root /tmp/kb-parse-export --base-url https://knowledgebase.<subdomain>.workers.dev --key <service-key>

Options:
  --domain <name>              Limit cases to one domain.
  --direct-domain <name>       Build one case directly from raw/parse roots.
  --direct-content-hash <hash> Content hash for --direct-domain.
  --direct-filename <name>     Filename for --direct-domain.
  --direct-mime <mime>         Optional mime for --direct-domain.
  --filename-contains <text>   Limit cases to filenames containing text, case-insensitive.
  --content-hash <hash>        Limit cases to one legacy content hash.
  --case-id <id>               Limit cases to one eval case id, such as sec:<content_hash>.
  --markdown-conversion <mode> auto | always | off; default auto.
  --vision-ocr-model <model>   Optional Workers AI vision model for scanned PDF OCR evals.
  --expected-per-case <n>      Expected text snippets per case; default 3.
  --min-text-ratio <n>         Minimum parsed text length as legacy text ratio; default 0.2.
  --min-pass-rate <n>          Fail live eval when summary pass_rate is below n.
  --max-cases-per-batch <n>    Max eval cases per request; default 8.
  --max-batch-bytes <n>        Approx max JSON payload bytes per request; default 6000000.
  --include-text-preview       Include bounded parser text previews in live eval rows.
  --require-cases              Fail when filters produce zero cases, including dry runs.
  --dry-run                    Build cases and print the planned eval without network calls.

Root handling:
  --raw-root and --parse-root may point either at a directory containing raw/ or parse/
  object keys, or directly at the raw/parse prefix directory.`);
}

function parseArgs(argv) {
  const out = {
    baseUrl: process.env.RAG_BASE_URL || DEFAULT_BASE_URL,
    key: process.env.RAG_SERVICE_KEY || '',
    exportPath: '',
    rawRoot: '',
    parseRoot: '',
    domain: '',
    directDomain: '',
    directContentHash: '',
    directFilename: '',
    directMime: '',
    filenameContains: '',
    contentHash: '',
    caseId: '',
    markdownConversion: 'auto',
    visionOcrModel: '',
    expectedPerCase: 3,
    minTextRatio: 0.2,
    minPassRate: null,
    maxCasesPerBatch: DEFAULT_MAX_CASES_PER_BATCH,
    maxBatchBytes: DEFAULT_MAX_BATCH_BYTES,
    includeTextPreview: false,
    requireCases: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--include-text-preview') {
      out.includeTextPreview = true;
      continue;
    }
    if (arg === '--require-cases') {
      out.requireCases = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--base-url') out.baseUrl = value;
    else if (arg === '--key') out.key = value;
    else if (arg === '--export') out.exportPath = value;
    else if (arg === '--raw-root') out.rawRoot = value;
    else if (arg === '--parse-root') out.parseRoot = value;
    else if (arg === '--domain') out.domain = value;
    else if (arg === '--direct-domain') out.directDomain = value;
    else if (arg === '--direct-content-hash') out.directContentHash = value;
    else if (arg === '--direct-filename') out.directFilename = value;
    else if (arg === '--direct-mime') out.directMime = value;
    else if (arg === '--filename-contains') out.filenameContains = value;
    else if (arg === '--content-hash') out.contentHash = value;
    else if (arg === '--case-id') out.caseId = value;
    else if (arg === '--markdown-conversion') out.markdownConversion = value;
    else if (arg === '--vision-ocr-model') out.visionOcrModel = value;
    else if (arg === '--expected-per-case') out.expectedPerCase = parsePositiveInteger(value, arg);
    else if (arg === '--min-text-ratio') out.minTextRatio = parseNonNegativeNumber(value, arg);
    else if (arg === '--min-pass-rate') out.minPassRate = parsePassRate(value, arg);
    else if (arg === '--max-cases-per-batch') out.maxCasesPerBatch = parsePositiveInteger(value, arg);
    else if (arg === '--max-batch-bytes') out.maxBatchBytes = parsePositiveInteger(value, arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  const directRequested = Boolean(out.directDomain || out.directContentHash || out.directFilename || out.directMime);
  if (directRequested && (!out.directDomain || !out.directContentHash || !out.directFilename)) {
    throw new Error('--direct-domain, --direct-content-hash, and --direct-filename are required together');
  }
  if (!out.exportPath && !directRequested) throw new Error('--export is required unless --direct-domain is used');
  if (!out.rawRoot) throw new Error('--raw-root is required');
  if (!out.parseRoot) throw new Error('--parse-root is required');
  if (!out.key && !out.dryRun) throw new Error('--key or RAG_SERVICE_KEY is required');
  out.baseUrl = out.baseUrl.replace(/\/+$/, '');
  return out;
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseNonNegativeNumber(value, label) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative number`);
  return parsed;
}

function parsePassRate(value, label) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${label} must be between 0 and 1`);
  return parsed;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveObjectPath(root, objectKey) {
  const direct = resolve(root, objectKey);
  if (await exists(direct)) return direct;
  const [prefix, ...rest] = objectKey.split('/');
  if ((prefix === 'raw' || prefix === 'parse') && basename(resolve(root)) === prefix) {
    const nested = resolve(root, rest.join('/'));
    if (await exists(nested)) return nested;
  }
  throw new Error(`object not found under ${root}: ${objectKey}`);
}

function minioInlineJson(metaBytes) {
  const text = metaBytes.toString('utf8');
  for (const marker of ['[', '{']) {
    let index = text.indexOf(marker);
    while (index >= 0) {
      const candidate = text.slice(index).trim();
      try {
        JSON.parse(candidate);
        return Buffer.from(candidate);
      } catch {
        index = text.indexOf(marker, index + 1);
      }
    }
  }
  return null;
}

function extractMinioInlineObject(metaBytes, objectKey) {
  if (!metaBytes.includes(Buffer.from('x-minio-internal-inline-data'))) return null;
  const lower = objectKey.toLowerCase();
  if (lower.endsWith('.pdf')) {
    const offset = metaBytes.indexOf(Buffer.from('%PDF-'));
    return offset >= 0 ? metaBytes.slice(offset) : null;
  }
  if (lower.endsWith('.json')) return minioInlineJson(metaBytes);
  return null;
}

async function readObjectBytes(root, objectKey) {
  const objectPath = await resolveObjectPath(root, objectKey);
  try {
    return await readFile(objectPath);
  } catch (error) {
    if (error?.code !== 'EISDIR') throw error;
    const metaPath = join(objectPath, 'xl.meta');
    const extracted = extractMinioInlineObject(await readFile(metaPath), objectKey);
    if (!extracted) throw new Error(`MinIO inline object not readable: ${objectKey}`);
    return extracted;
  }
}

function asArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function snippetFromText(value, maxChars = 96) {
  const text = cleanText(value);
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated).trim();
}

function chooseExpectedText(elements, expectedPerCase) {
  const seen = new Set();
  const candidates = [];
  for (const element of elements) {
    const text = snippetFromText(element?.text);
    if (text.length < 12) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      text,
      score: Math.min(text.length, 96) + (element?.type === 'Title' ? 20 : 0),
    });
  }
  const first = candidates[0]?.text ? [candidates[0].text] : [];
  const strongest = candidates
    .slice(1)
    .sort((a, b) => b.score - a.score)
    .map((candidate) => candidate.text);
  return [...first, ...strongest].slice(0, expectedPerCase);
}

function legacyTextLength(elements) {
  return elements.reduce((sum, element) => sum + cleanText(element?.text).length, 0);
}

function matchesCaseFilters(file, options) {
  const caseId = `${file.domain}:${file.content_hash}`;
  if (options.caseId && caseId !== options.caseId) return false;
  if (options.contentHash && file.content_hash !== options.contentHash) return false;
  if (
    options.filenameContains &&
    !String(file.filename ?? '').toLowerCase().includes(String(options.filenameContains).toLowerCase())
  ) {
    return false;
  }
  return true;
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function approxCaseBytes(testCase) {
  return Buffer.byteLength(JSON.stringify(testCase), 'utf8');
}

async function loadLegacyCaseInputs(options) {
  if (options.directDomain || options.directContentHash || options.directFilename) {
    const contentHash = options.directContentHash;
    const filename = options.directFilename;
    return {
      files: [{
        domain: options.directDomain,
        filename,
        mime: options.directMime || undefined,
        content_hash: contentHash,
        object_key: `raw/${options.directDomain}/${contentHash}/${filename}`,
      }],
      artifacts: new Map([[contentHash, {
        content_hash: contentHash,
        object_key: `parse/${contentHash}/elements.json`,
      }]]),
    };
  }
  const raw = JSON.parse(await readFile(resolve(options.exportPath), 'utf8'));
  return {
    files: asArray(raw.files, 'export.files'),
    artifacts: new Map(asArray(raw.parse_artifacts, 'export.parse_artifacts').map((artifact) => [artifact.content_hash, artifact])),
  };
}

export async function buildLegacyParseEvalCases(options) {
  const { files, artifacts } = await loadLegacyCaseInputs(options);
  const cases = [];
  const skipped = [];
  for (const file of files) {
    if (options.domain && file.domain !== options.domain) continue;
    if (!matchesCaseFilters(file, options)) continue;
    const artifact = artifacts.get(file.content_hash);
    if (!artifact) {
      skipped.push({ filename: file.filename, content_hash: file.content_hash, reason: 'missing_parse_artifact' });
      continue;
    }
    const rawBytes = await readObjectBytes(options.rawRoot, file.object_key);
    const parseBytes = await readObjectBytes(options.parseRoot, artifact.object_key);
    const elements = JSON.parse(parseBytes.toString('utf8'));
    if (!Array.isArray(elements) || elements.length === 0) {
      skipped.push({ filename: file.filename, content_hash: file.content_hash, reason: 'empty_parse_artifact' });
      continue;
    }
    const expectedText = chooseExpectedText(elements, options.expectedPerCase || 3);
    if (expectedText.length === 0) {
      skipped.push({ filename: file.filename, content_hash: file.content_hash, reason: 'no_expected_text' });
      continue;
    }
    cases.push({
      id: `${file.domain}:${file.content_hash}`,
      domain: file.domain,
      filename: file.filename,
      mime: file.mime || undefined,
      content_base64: toBase64(rawBytes),
      expected_text: expectedText,
      min_text_length: Math.max(1, Math.floor(legacyTextLength(elements) * (options.minTextRatio ?? 0.2))),
      legacy: {
        content_hash: file.content_hash,
        raw_object_key: file.object_key,
        parse_object_key: artifact.object_key,
        bytes: file.bytes,
        legacy_element_count: elements.length,
      },
    });
  }
  return { cases, skipped };
}

export function batchParseEvalCases(cases, { maxCasesPerBatch = DEFAULT_MAX_CASES_PER_BATCH, maxBatchBytes = DEFAULT_MAX_BATCH_BYTES } = {}) {
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const testCase of cases) {
    const size = approxCaseBytes(testCase);
    if (batch.length > 0 && (batch.length >= maxCasesPerBatch || bytes + size > maxBatchBytes)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(testCase);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

async function requestJson(url, { key, method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} failed ${res.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function summarizeReports(reports) {
  const rows = reports.flatMap((report) => Array.isArray(report.rows) ? report.rows : []);
  const failed = rows.filter((row) => !row.ok);
  const parserCounts = {};
  for (const report of reports) {
    for (const [parser, count] of Object.entries(report.parser_counts ?? {})) {
      parserCounts[parser] = (parserCounts[parser] ?? 0) + count;
    }
  }
  return {
    batches: reports.length,
    n: rows.length,
    passed: rows.length - failed.length,
    pass_rate: rows.length ? (rows.length - failed.length) / rows.length : null,
    parser_counts: parserCounts,
    failed: failed.map((row) => ({
      id: row.id,
      filename: row.filename,
      parser: row.parser,
      missing_text: row.missing_text,
      text_length: row.text_length,
      min_text_length: row.min_text_length,
    })),
    report_ids: reports.map((report) => report.report_id).filter(Boolean),
  };
}

export async function runLegacyParseEval(options) {
  const { cases, skipped } = await buildLegacyParseEvalCases(options);
  if (options.requireCases && cases.length === 0) throw new Error('legacy parse eval selected zero cases');
  const batches = batchParseEvalCases(cases, options);
  const plan = {
    dry_run: Boolean(options.dryRun),
    cases: cases.length,
    base_url: options.baseUrl,
    markdown_conversion: options.markdownConversion || 'auto',
    vision_ocr_model: options.visionOcrModel || null,
    include_text_preview: Boolean(options.includeTextPreview),
    require_cases: Boolean(options.requireCases),
    min_pass_rate: options.minPassRate ?? null,
    filters: {
      domain: options.domain || null,
      direct_domain: options.directDomain || null,
      direct_content_hash: options.directContentHash || null,
      direct_filename: options.directFilename || null,
      filename_contains: options.filenameContains || null,
      content_hash: options.contentHash || null,
      case_id: options.caseId || null,
    },
    skipped,
    batches: batches.map((batch) => ({
      cases: batch.length,
      bytes: Buffer.byteLength(JSON.stringify({ cases: batch }), 'utf8'),
      domains: [...new Set(batch.map((testCase) => testCase.domain))].sort(),
    })),
  };
  if (options.dryRun) return plan;

  const reports = [];
  for (const [i, batch] of batches.entries()) {
    const started = performance.now();
    const payload = await requestJson(`${options.baseUrl}/v1/kb/evals/parse`, {
      key: options.key,
      method: 'POST',
      body: {
        domain: options.domain || undefined,
        markdown_conversion: options.markdownConversion || 'auto',
        vision_ocr_model: options.visionOcrModel || undefined,
        include_text_preview: Boolean(options.includeTextPreview),
        cases: batch.map(({ domain: _domain, legacy: _legacy, ...testCase }) => testCase),
      },
    });
    reports.push({
      ...payload,
      batch: i + 1,
      elapsed_ms: Math.round((performance.now() - started) * 100) / 100,
    });
  }
  const summary = summarizeReports(reports);
  if (options.minPassRate !== null && options.minPassRate !== undefined) {
    const passRate = typeof summary.pass_rate === 'number' ? summary.pass_rate : 0;
    if (passRate < options.minPassRate) {
      throw new Error(`legacy parse eval pass_rate ${passRate} is below required ${options.minPassRate}`);
    }
  }
  return {
    ...plan,
    dry_run: false,
    summary,
    reports,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runLegacyParseEval(args);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
