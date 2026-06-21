import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  batchParseEvalCases,
  buildLegacyParseEvalCases,
  runLegacyParseEval,
} from '../scripts/legacy-parse-eval.mjs';

const fixtureOptions = {
  exportPath: 'fixtures/d1-metadata-export.sample.json',
  rawRoot: 'fixtures/legacy-parse-eval',
  parseRoot: 'fixtures/legacy-parse-eval',
  domain: '',
  expectedPerCase: 2,
  minTextRatio: 0.2,
  maxCasesPerBatch: 8,
  maxBatchBytes: 6_000_000,
};

describe('legacy-parse-eval', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds parse eval cases from legacy D1 exports and parse artifacts', async () => {
    const result = await buildLegacyParseEvalCases(fixtureOptions);

    expect(result.skipped).toEqual([]);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]).toMatchObject({
      id: 'sec:hash-file-1',
      domain: 'sec',
      filename: 'aapl-10k.txt',
      mime: 'text/plain',
      expected_text: [
        'Apple Inc. annual filing',
        'Revenue risk factors and services growth are discussed in this filing.',
      ],
      legacy: {
        content_hash: 'hash-file-1',
        raw_object_key: 'raw/sec/hash-file-1/aapl-10k.txt',
        parse_object_key: 'parsed/sec/hash-file-1/elements.json',
      },
    });
    expect(result.cases[0]?.content_base64).toBeTypeOf('string');
    expect(result.cases[0]?.min_text_length).toBeGreaterThan(0);
  });

  it('batches cases by count and approximate payload size', async () => {
    const { cases } = await buildLegacyParseEvalCases(fixtureOptions);
    const batches = batchParseEvalCases([...cases, ...cases, ...cases], {
      maxCasesPerBatch: 2,
      maxBatchBytes: 1_000_000,
    });

    expect(batches.map((batch) => batch.length)).toEqual([2, 1]);
  });

  it('filters legacy parse eval cases before reading raw artifacts', async () => {
    const byFilename = await buildLegacyParseEvalCases({
      ...fixtureOptions,
      filenameContains: 'AAPL',
    });
    const noFilenameMatch = await buildLegacyParseEvalCases({
      ...fixtureOptions,
      filenameContains: 'nvda',
    });
    const byContentHash = await buildLegacyParseEvalCases({
      ...fixtureOptions,
      contentHash: 'hash-file-1',
    });
    const byCaseId = await buildLegacyParseEvalCases({
      ...fixtureOptions,
      caseId: 'sec:hash-file-1',
    });

    expect(byFilename.cases.map((testCase) => testCase.id)).toEqual(['sec:hash-file-1']);
    expect(noFilenameMatch).toMatchObject({ cases: [], skipped: [] });
    expect(byContentHash.cases.map((testCase) => testCase.id)).toEqual(['sec:hash-file-1']);
    expect(byCaseId.cases.map((testCase) => testCase.id)).toEqual(['sec:hash-file-1']);
  });

  it('builds a direct case from MinIO inline xl.meta objects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-parse-eval-'));
    try {
      const hash = 'hash-minio-inline';
      const rawDir = join(root, 'raw/sec', hash, 'scan.pdf');
      const parseDir = join(root, 'parse', hash, 'elements.json');
      await mkdir(rawDir, { recursive: true });
      await mkdir(parseDir, { recursive: true });
      await writeFile(join(rawDir, 'xl.meta'), Buffer.from('XL2 x-minio-internal-inline-data true\n%PDF-1.4\n%%EOF'));
      await writeFile(join(parseDir, 'xl.meta'), Buffer.from(
        'XL2 x-minio-internal-inline-data true\n' +
        JSON.stringify([{ type: 'Title', text: 'Scanned risk factor text from OCR' }]),
      ));

      const result = await buildLegacyParseEvalCases({
        ...fixtureOptions,
        exportPath: '',
        rawRoot: root,
        parseRoot: root,
        directDomain: 'sec',
        directContentHash: hash,
        directFilename: 'scan.pdf',
        directMime: 'application/pdf',
      });

      expect(result.skipped).toEqual([]);
      expect(result.cases).toHaveLength(1);
      expect(result.cases[0]).toMatchObject({
        id: 'sec:hash-minio-inline',
        filename: 'scan.pdf',
        mime: 'application/pdf',
        expected_text: ['Scanned risk factor text from OCR'],
      });
      expect(Buffer.from(result.cases[0]?.content_base64 ?? '', 'base64').toString('utf8')).toContain('%PDF-1.4');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('summarizes dry-run plans without a service key', async () => {
    const result = await runLegacyParseEval({
      ...fixtureOptions,
      baseUrl: 'http://rag.local',
      key: '',
      markdownConversion: 'auto',
      filenameContains: 'aapl',
      dryRun: true,
    });

    expect(result).toMatchObject({
      dry_run: true,
      cases: 1,
      base_url: 'http://rag.local',
      markdown_conversion: 'auto',
      vision_ocr_model: null,
      include_text_preview: false,
      require_cases: false,
      min_pass_rate: null,
      filters: { filename_contains: 'aapl' },
      skipped: [],
      batches: [{ cases: 1, domains: ['sec'] }],
    });
  });

  it('includes costly OCR gates in dry-run plans', async () => {
    const result = await runLegacyParseEval({
      ...fixtureOptions,
      baseUrl: 'https://knowledgebase.example.workers.dev',
      key: '',
      markdownConversion: 'auto',
      visionOcrModel: '@cf/meta/llama-3.2-11b-vision-instruct',
      includeTextPreview: true,
      requireCases: true,
      minPassRate: 1,
      dryRun: true,
    });

    expect(result).toMatchObject({
      dry_run: true,
      base_url: 'https://knowledgebase.example.workers.dev',
      markdown_conversion: 'auto',
      vision_ocr_model: '@cf/meta/llama-3.2-11b-vision-instruct',
      include_text_preview: true,
      require_cases: true,
      min_pass_rate: 1,
      cases: 1,
    });
  });

  it('can fail dry runs when filters select zero cases', async () => {
    await expect(runLegacyParseEval({
      ...fixtureOptions,
      baseUrl: 'http://rag.local',
      key: '',
      filenameContains: 'nvda',
      requireCases: true,
      dryRun: true,
    })).rejects.toThrow('selected zero cases');
  });

  it('posts batches to the deployed parse eval route', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json({
        report_id: 'report-1',
        n: 1,
        pass_rate: 1,
        parser_counts: { 'text-v1': 1 },
        rows: [{ id: 'sec:hash-file-1', ok: true, parser: 'text-v1' }],
      });
    }));

    const result = await runLegacyParseEval({
      ...fixtureOptions,
      baseUrl: 'http://rag.local',
      key: 'service-key',
      markdownConversion: 'auto',
      visionOcrModel: '@cf/meta/llama-3.2-11b-vision-instruct',
      dryRun: false,
    });

    expect(result).toHaveProperty('summary');
    expect('summary' in result ? result.summary : null).toMatchObject({
      batches: 1,
      n: 1,
      passed: 1,
      pass_rate: 1,
      parser_counts: { 'text-v1': 1 },
      report_ids: ['report-1'],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://rag.local/v1/kb/evals/parse');
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: 'Bearer service-key' });
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toMatchObject({
      markdown_conversion: 'auto',
      vision_ocr_model: '@cf/meta/llama-3.2-11b-vision-instruct',
    });
    expect(body.cases[0]).not.toHaveProperty('legacy');
    expect(body.cases[0]).not.toHaveProperty('domain');
  });

  it('can fail live evals below the required pass rate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      report_id: 'report-1',
      n: 1,
      pass_rate: 0,
      parser_counts: { 'workers-ai-markdown-v1': 1 },
      rows: [{
        id: 'sec:hash-file-1',
        ok: false,
        parser: 'workers-ai-markdown-v1',
        missing_text: ['Customer concentration'],
      }],
    })));

    await expect(runLegacyParseEval({
      ...fixtureOptions,
      baseUrl: 'http://rag.local',
      key: 'service-key',
      markdownConversion: 'auto',
      minPassRate: 1,
      dryRun: false,
    })).rejects.toThrow('pass_rate 0 is below required 1');
  });
});
