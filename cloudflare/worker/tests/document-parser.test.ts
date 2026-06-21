import { compressSync, strToU8, zipSync } from 'fflate';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUploadBytes, parseUploadBytesWithCloudflare } from '../src/document-parser';

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function ascii85Encode(input: Uint8Array): string {
  let out = '<~';
  for (let i = 0; i < input.length; i += 4) {
    const chunk = input.slice(i, i + 4);
    const padded = new Uint8Array(4);
    padded.set(chunk);
    const value = (((padded[0] ?? 0) * 256 + (padded[1] ?? 0)) * 256 + (padded[2] ?? 0)) * 256 + (padded[3] ?? 0);
    if (chunk.length === 4 && value === 0) {
      out += 'z';
      continue;
    }
    const chars = Array.from({ length: 5 }, () => 0);
    let remaining = value;
    for (let j = 4; j >= 0; j -= 1) {
      chars[j] = (remaining % 85) + 33;
      remaining = Math.floor(remaining / 85);
    }
    out += String.fromCharCode(...chars.slice(0, chunk.length + 1));
  }
  return `${out}~>`;
}

function compressedPdfBytes(textOperators: string): ArrayBuffer {
  const stream = ascii85Encode(compressSync(new TextEncoder().encode(textOperators)));
  return bytes([
    '%PDF-1.4',
    '1 0 obj << /Type /Page >> endobj',
    '2 0 obj',
    '<< /Filter [ /ASCII85Decode /FlateDecode ] /Length ' + stream.length + ' >>',
    'stream',
    stream,
    'endstream',
    'endobj',
    '%%EOF',
  ].join('\n'));
}

function binaryPdfWithFlateImage(): ArrayBuffer {
  const pixels = new Uint8Array([
    255, 255, 255, 0, 0, 0,
    0, 0, 0, 255, 255, 255,
  ]);
  const stream = compressSync(pixels);
  const header = new TextEncoder().encode([
    '%PDF-1.4',
    '1 0 obj << /Type /Page >> endobj',
    '2 0 obj',
    `<< /Subtype /Image /Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /FlateDecode /Length ${stream.length} >>`,
    'stream',
    '',
  ].join('\n'));
  const footer = new TextEncoder().encode('\nendstream\nendobj\n%%EOF');
  const out = new Uint8Array(header.length + stream.length + footer.length);
  out.set(header, 0);
  out.set(stream, header.length);
  out.set(footer, header.length + stream.length);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

function binaryPdfWithLogoAndPageImage(): ArrayBuffer {
  const pageWidth = 300;
  const pageHeight = 300;
  const pagePixels = new Uint8Array(pageWidth * pageHeight * 3).fill(255);
  const pageStream = compressSync(pagePixels);
  const prefix = new TextEncoder().encode([
    '%PDF-1.4',
    '1 0 obj << /Type /Page >> endobj',
    '2 0 obj',
    '<< /Subtype /Image /Width 16 /Height 16 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /DCTDecode /Length 4 >>',
    'stream',
    'logo',
    'endstream',
    'endobj',
    '3 0 obj',
    `<< /Subtype /Image /Width ${pageWidth} /Height ${pageHeight} /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /FlateDecode /Length ${pageStream.length} >>`,
    'stream',
    '',
  ].join('\n'));
  const suffix = new TextEncoder().encode('\nendstream\nendobj\n%%EOF');
  const out = new Uint8Array(prefix.length + pageStream.length + suffix.length);
  out.set(prefix, 0);
  out.set(pageStream, prefix.length);
  out.set(suffix, prefix.length + pageStream.length);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

function extractInlinePdfFromMinioMeta(path: string): ArrayBuffer {
  const meta = readFileSync(path);
  const offset = meta.indexOf(Buffer.from('%PDF-'));
  if (offset < 0) throw new Error(`PDF marker not found in ${path}`);
  const pdf = meta.subarray(offset);
  return pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
}

function xlsxBytes(): ArrayBuffer {
  const zip = zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'),
    'xl/workbook.xml': strToU8(
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Contracts" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    'xl/sharedStrings.xml': strToU8(
      '<sst><si><t>contract_id</t></si><si><t>counterparty</t></si><si><t>value</t></si><si><t>c-1</t></si><si><t>Acme</t></si></sst>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      '<worksheet><sheetData><row r="1"><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c t="s"><v>2</v></c></row><row r="2"><c t="s"><v>3</v></c><c t="s"><v>4</v></c><c><v>1000</v></c></row></sheetData></worksheet>',
    ),
  });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}

function docxBytes(): ArrayBuffer {
  const zip = zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'),
    'word/document.xml': strToU8(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Cloudflare migration plan</w:t></w:r></w:p><w:p><w:r><w:t>Vectorize stores contract evidence</w:t></w:r></w:p></w:body></w:document>',
    ),
  });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}

function pptxBytes(): ArrayBuffer {
  const zip = zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'),
    'ppt/slides/slide1.xml': strToU8(
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>RAG migration</a:t></a:r></a:p><a:p><a:r><a:t>D1 metadata and R2 artifacts</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    ),
    'ppt/slides/slide2.xml': strToU8(
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Queue ingestion</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    ),
  });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}

describe('document-parser', () => {
  it('strips HTML into searchable text', () => {
    const parsed = parseUploadBytes(
      'guide.html',
      'text/html',
      bytes('<html><body><h1>Migration Guide</h1><script>ignore()</script><p>Cloudflare R2 upload</p></body></html>'),
    );

    expect(parsed.parser).toBe('worker-html-text-v1');
    expect(parsed.text).toContain('Migration Guide');
    expect(parsed.text).toContain('Cloudflare R2 upload');
    expect(parsed.text).not.toContain('ignore');
  });

  it('extracts digital PDF text operators with layout metadata', () => {
    const parsed = parseUploadBytes(
      'filing.pdf',
      'application/pdf',
      bytes('%PDF-1.7\n1 0 obj << /Type /Page >> endobj\nBT (Alpha revenue) Tj [(Beta) ( margin)] TJ ET\n%%EOF'),
    );

    expect(parsed.parser).toBe('worker-pdf-layout-v2');
    expect(parsed.text).toContain('Alpha revenue');
    expect(parsed.text).toContain('Beta');
    expect(parsed.documents[0]?.metadata).toMatchObject({ parser_layout: true });
    expect(parsed.page_count).toBe(1);
  });

  it('extracts compressed PDF text streams', () => {
    const parsed = parseUploadBytes(
      'compressed.pdf',
      'application/pdf',
      compressedPdfBytes('BT (Customer concentration: a small number of customers) Tj (Supply chain concentration: Taiwan) Tj ET'),
    );

    expect(parsed.parser).toBe('worker-pdf-layout-v2');
    expect(parsed.text).toContain('Customer concentration: a small number of customers');
    expect(parsed.text).toContain('Supply chain concentration: Taiwan');
    expect(parsed.documents.length).toBeGreaterThan(0);
  });

  it('preserves digital PDF table-like layout as a markdown table document', () => {
    const parsed = parseUploadBytes(
      'table.pdf',
      'application/pdf',
      bytes([
        '%PDF-1.7',
        '1 0 obj << /Type /Page >> endobj',
        'BT',
        '1 0 0 1 72 720 Tm (Metric) Tj',
        '1 0 0 1 180 720 Tm (Value) Tj',
        '1 0 0 1 72 700 Tm (Revenue) Tj',
        '1 0 0 1 180 700 Tm (1000) Tj',
        'ET',
        '%%EOF',
      ].join('\n')),
    );

    expect(parsed.parser).toBe('worker-pdf-layout-v2');
    expect(parsed.record_count).toBe(1);
    expect(parsed.text).toContain('Metric | Value');
    expect(parsed.text).toContain('| Revenue | 1000 |');
    expect(parsed.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          external_id: 'table.pdf:table:1',
          content: expect.stringContaining('| Metric | Value |'),
          metadata: expect.objectContaining({ parser_table: true, parser_layout: true }),
        }),
      ]),
    );
  });

  it('turns XLSX rows into structured documents', () => {
    const parsed = parseUploadBytes(
      'contracts.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xlsxBytes(),
    );

    expect(parsed.parser).toBe('worker-xlsx-xml-v1');
    expect(parsed.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining('counterparty: Acme'),
          metadata: expect.objectContaining({
            record: expect.objectContaining({ contract_id: 'c-1', counterparty: 'Acme', value: 1000 }),
          }),
        }),
      ]),
    );
    expect(parsed.record_count).toBe(1);
  });

  it('extracts DOCX paragraphs into searchable documents', () => {
    const parsed = parseUploadBytes(
      'migration.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      docxBytes(),
    );

    expect(parsed.parser).toBe('worker-docx-xml-v1');
    expect(parsed.text).toContain('Cloudflare migration plan');
    expect(parsed.text).toContain('Vectorize stores contract evidence');
    expect(parsed.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          external_id: 'migration.docx:paragraph:1',
          metadata: expect.objectContaining({ paragraph: 1, parser_source: 'docx' }),
        }),
      ]),
    );
  });

  it('extracts PPTX slide text into searchable documents', () => {
    const parsed = parseUploadBytes(
      'briefing.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      pptxBytes(),
    );

    expect(parsed.parser).toBe('worker-pptx-xml-v1');
    expect(parsed.text).toContain('[Slide 1] RAG migration D1 metadata and R2 artifacts');
    expect(parsed.text).toContain('[Slide 2] Queue ingestion');
    expect(parsed.page_count).toBe(2);
    expect(parsed.documents[0]?.metadata).toMatchObject({ slide: 1, parser_source: 'pptx' });
  });

  it('falls back to Workers AI Markdown Conversion for image/OCR-only inputs', async () => {
    const ai = {
      toMarkdown: async () => ({
        id: 'converted-1',
        name: 'scan.png',
        mimeType: 'image/png',
        format: 'markdown',
        tokens: 12,
        data: '# Scanned invoice\n\n| Field | Value |\n| --- | --- |\n| Total | 100 |',
      }),
    } as unknown as Ai;

    const parsed = await parseUploadBytesWithCloudflare('scan.png', 'image/png', bytes('not real image bytes'), ai);

    expect(parsed.parser).toBe('workers-ai-markdown-v1');
    expect(parsed.text).toContain('Scanned invoice');
    expect(parsed.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          external_id: 'scan.png:markdown-table:1',
          metadata: expect.objectContaining({ parser_table: true, parser_source: 'workers-ai-markdown' }),
        }),
      ]),
    );
  });

  it('merges explicit Workers AI vision OCR with Markdown Conversion for standalone image uploads', async () => {
    let visionInput: unknown = null;
    const ai = {
      run: async (_model: string, input: unknown) => {
        visionInput = input;
        return { response: 'Invoice OCR total due 100' };
      },
      toMarkdown: async () => ({
        id: 'converted-1',
        name: 'scan.png',
        mimeType: 'image/png',
        format: 'markdown',
        tokens: 8,
        data: 'Markdown image description with vendor Acme',
      }),
    } as unknown as Ai;

    const parsed = await parseUploadBytesWithCloudflare(
      'scan.png',
      'image/png',
      bytes('not real image bytes'),
      ai,
      'auto',
      '@cf/meta/llama-3.2-11b-vision-instruct',
    );

    expect(parsed.parser).toBe('workers-ai-vision-markdown-ocr-v1');
    expect(parsed.text).toContain('Invoice OCR total due 100');
    expect(parsed.text).toContain('vendor Acme');
    expect(visionInput).toMatchObject({
      prompt: expect.stringContaining('strict OCR transcription engine'),
      image: expect.any(Array),
      temperature: 0,
    });
    expect(parsed.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          external_id: 'scan.png:vision-image:1',
          metadata: expect.objectContaining({
            image_index: 1,
            parser_source: 'workers-ai-vision-ocr',
            vision_input: 'prompt-image',
            vision_model: '@cf/meta/llama-3.2-11b-vision-instruct',
          }),
        }),
      ]),
    );
  });

  it('runs explicit Workers AI vision OCR for standalone images when Markdown Conversion is disabled', async () => {
    const ai = {
      run: async () => ({ response: 'Receipt OCR text without Markdown Conversion' }),
      toMarkdown: async () => {
        throw new Error('should not call Markdown Conversion when disabled');
      },
    } as unknown as Ai;

    const parsed = await parseUploadBytesWithCloudflare(
      'receipt.jpg',
      'image/jpeg',
      bytes('not real image bytes'),
      ai,
      'off',
      '@cf/meta/llama-3.2-11b-vision-instruct',
    );

    expect(parsed.parser).toBe('workers-ai-vision-ocr-v1');
    expect(parsed.text).toBe('Receipt OCR text without Markdown Conversion');
    expect(parsed.documents[0]?.metadata).toMatchObject({
      filename: 'receipt.jpg',
      mime: 'image/jpeg',
      image_index: 1,
      parser_source: 'workers-ai-vision-ocr',
    });
  });

  it('keeps digital PDFs on the local parser in auto mode', async () => {
    const ai = {
      toMarkdown: async () => {
        throw new Error('should not call Markdown Conversion for text-layer PDFs');
      },
    } as unknown as Ai;

    const parsed = await parseUploadBytesWithCloudflare(
      'filing.pdf',
      'application/pdf',
      bytes('%PDF-1.7\n1 0 obj << /Type /Page >> endobj\nBT (Alpha revenue was 100 and beta margin was 20) Tj ET\n%%EOF'),
      ai,
      'auto',
    );

    expect(parsed.parser).toBe('worker-pdf-layout-v2');
    expect(parsed.text).toContain('Alpha revenue');
  });

  it('falls back to Workers AI Markdown Conversion for image-only PDFs in auto mode', async () => {
    const ai = {
      toMarkdown: async () => ({
        id: 'converted-1',
        name: 'scan.pdf',
        mimeType: 'application/pdf',
        format: 'markdown',
        tokens: 20,
        data: 'NVDA-RiskFactors-Sample\n\nCustomer concentration from OCR',
      }),
    } as unknown as Ai;

    const parsed = await parseUploadBytesWithCloudflare(
      'scan.pdf',
      'application/pdf',
      bytes('%PDF-1.4\n1 0 obj << /Subtype /Image /Length 4 >> stream\nxxxx\nendstream\nendobj\n%%EOF'),
      ai,
      'auto',
    );

    expect(parsed.parser).toBe('workers-ai-markdown-v1');
    expect(parsed.text).toContain('Customer concentration from OCR');
  });

  it('merges explicit Workers AI vision OCR with Markdown Conversion for embedded image-only PDFs', async () => {
    let visionInput: unknown = null;
    const ai = {
      run: async (_model: string, input: unknown) => {
        visionInput = input;
        return {
        response: 'NVDA-RiskFactors-Sample\nCustomer concentration: a small number of customers historically accounted for a large portion',
        };
      },
      toMarkdown: async () => ({
        id: 'converted-1',
        name: 'scan.pdf',
        mimeType: 'application/pdf',
        format: 'markdown',
        tokens: 12,
        data: 'Markdown Conversion page description with supply chain concentration',
      }),
    } as unknown as Ai;

    const parsed = await parseUploadBytesWithCloudflare(
      'scan.pdf',
      'application/pdf',
      bytes('%PDF-1.4\n1 0 obj << /Subtype /Image /Filter /DCTDecode /Length 4 >> stream\nxxxx\nendstream\nendobj\n%%EOF'),
      ai,
      'auto',
      '@cf/meta/llama-3.2-11b-vision-instruct',
    );

    expect(parsed.parser).toBe('workers-ai-vision-markdown-ocr-v1');
    expect(parsed.text).toContain('Customer concentration');
    expect(parsed.text).toContain('supply chain concentration');
    expect(parsed.documents.map((doc) => doc.metadata.parser_source)).toEqual(
      expect.arrayContaining(['workers-ai-vision-ocr', 'workers-ai-markdown']),
    );
    expect(visionInput).toMatchObject({
      prompt: expect.stringContaining('strict OCR transcription engine'),
      image: expect.any(Array),
      temperature: 0,
    });
    expect(visionInput).not.toHaveProperty('messages');
    expect(parsed.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            vision_model: '@cf/meta/llama-3.2-11b-vision-instruct',
            vision_input: 'prompt-image',
          }),
        }),
      ]),
    );
  });

  it('falls back to image_url messages for Llama 3.2 Vision when native image input returns empty text', async () => {
    const inputModes: string[] = [];
    const ai = {
      run: async (_model: string, input: { image?: unknown; messages?: unknown }) => {
        inputModes.push(Array.isArray(input.image) ? 'prompt-image' : 'image-url-message');
        if (Array.isArray(input.image)) return { response: '' };
        return { response: 'Llama 3.2 fallback image_url OCR text' };
      },
      toMarkdown: async () => ({
        id: 'converted-1',
        name: 'scan.pdf',
        mimeType: 'application/pdf',
        format: 'markdown',
        tokens: 12,
        data: 'Markdown fallback text',
      }),
    } as unknown as Ai;

    const parsed = await parseUploadBytesWithCloudflare(
      'scan.pdf',
      'application/pdf',
      bytes('%PDF-1.4\n1 0 obj << /Subtype /Image /Filter /DCTDecode /Length 4 >> stream\nxxxx\nendstream\nendobj\n%%EOF'),
      ai,
      'auto',
      '@cf/meta/llama-3.2-11b-vision-instruct',
    );

    expect(inputModes).toEqual(['prompt-image', 'image-url-message']);
    expect(parsed.text).toContain('Llama 3.2 fallback image_url OCR text');
    expect(parsed.warnings).toEqual(expect.arrayContaining([expect.stringContaining('vision_model_empty')]));
    expect(parsed.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            vision_model: '@cf/meta/llama-3.2-11b-vision-instruct',
            vision_input: 'image-url-message',
          }),
        }),
      ]),
    );
  });

  it('runs explicit vision OCR for PDFs with only weak local text', async () => {
    let visionCalled = false;
    const ai = {
      run: async () => {
        visionCalled = true;
        return { response: 'Customer concentration OCR text from the scanned page' };
      },
      toMarkdown: async () => ({
        id: 'converted-1',
        name: 'scan.pdf',
        mimeType: 'application/pdf',
        format: 'markdown',
        tokens: 8,
        data: 'Markdown page description',
      }),
    } as unknown as Ai;

    const parsed = await parseUploadBytesWithCloudflare(
      'scan.pdf',
      'application/pdf',
      bytes([
        '%PDF-1.4',
        '1 0 obj << /Type /Page >> endobj',
        'BT (NVDA-RiskFactors-Sample) Tj ET',
        '2 0 obj << /Subtype /Image /Filter /DCTDecode /Length 4 >> stream',
        'xxxx',
        'endstream',
        'endobj',
        '%%EOF',
      ].join('\n')),
      ai,
      'auto',
      '@cf/meta/llama-3.2-11b-vision-instruct',
    );

    expect(visionCalled).toBe(true);
    expect(parsed.parser).toBe('workers-ai-vision-markdown-ocr-v1');
    expect(parsed.text).toContain('Customer concentration OCR text');
  });

  it('uses the same image_url message content shape for Llama 4 Scout vision OCR', async () => {
    let visionInput: unknown = null;
    const ai = {
      run: async (_model: string, input: unknown) => {
        visionInput = input;
        return { response: 'Llama 4 Scout OCR text' };
      },
      toMarkdown: async () => ({
        id: 'converted-1',
        name: 'scan.pdf',
        mimeType: 'application/pdf',
        format: 'markdown',
        tokens: 12,
        data: 'Markdown fallback text',
      }),
    } as unknown as Ai;

    const parsed = await parseUploadBytesWithCloudflare(
      'scan.pdf',
      'application/pdf',
      bytes('%PDF-1.4\n1 0 obj << /Subtype /Image /Filter /DCTDecode /Length 4 >> stream\nxxxx\nendstream\nendobj\n%%EOF'),
      ai,
      'auto',
      '@cf/meta/llama-4-scout-17b-16e-instruct',
    );

    expect(parsed.parser).toBe('workers-ai-vision-markdown-ocr-v1');
    expect(parsed.text).toContain('Llama 4 Scout OCR text');
    expect(visionInput).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.arrayContaining([
            expect.objectContaining({ type: 'text' }),
            expect.objectContaining({
              type: 'image_url',
              image_url: expect.objectContaining({ url: expect.stringMatching(/^data:image\/jpeg;base64,/) }),
            }),
          ]),
        }),
      ]),
      temperature: 0,
    });
  });

  it('tries the next Cloudflare vision OCR model when the first configured model fails', async () => {
    const calls: string[] = [];
    const ai = {
      run: async (model: string) => {
        calls.push(model);
        if (model.includes('llama-3.2')) throw new Error('license not accepted');
        return { response: 'Fallback Scout OCR text' };
      },
      toMarkdown: async () => ({
        id: 'converted-1',
        name: 'scan.pdf',
        mimeType: 'application/pdf',
        format: 'markdown',
        tokens: 12,
        data: 'Markdown fallback text',
      }),
    } as unknown as Ai;

    const parsed = await parseUploadBytesWithCloudflare(
      'scan.pdf',
      'application/pdf',
      bytes('%PDF-1.4\n1 0 obj << /Subtype /Image /Filter /DCTDecode /Length 4 >> stream\nxxxx\nendstream\nendobj\n%%EOF'),
      ai,
      'auto',
      '@cf/meta/llama-3.2-11b-vision-instruct,@cf/meta/llama-4-scout-17b-16e-instruct',
    );

    expect(calls).toEqual([
      '@cf/meta/llama-3.2-11b-vision-instruct',
      '@cf/meta/llama-3.2-11b-vision-instruct',
      '@cf/meta/llama-4-scout-17b-16e-instruct',
    ]);
    expect(parsed.text).toContain('Fallback Scout OCR text');
    expect(parsed.warnings).toEqual(expect.arrayContaining([expect.stringContaining('license not accepted')]));
    expect(parsed.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ vision_model: '@cf/meta/llama-4-scout-17b-16e-instruct' }),
        }),
      ]),
    );
  });

  it('extracts the local NVDA scanned PDF embedded JPEG for Llama vision OCR when the fixture is present', async () => {
    const fixture = resolve(
      '../../data/minio/kb-bucket/raw/sec/a56062aa2ee3c2eb6e1128e440e4ab683641e2ef4ccfa7e955538676a02c4c39/NVDA_riskfactors_sample_scanned.pdf/xl.meta',
    );
    if (!existsSync(fixture)) return;

    let visionInput: { image?: unknown; messages?: Array<{ content?: unknown }> } = {};
    const ai = {
      run: async (_model: string, input: { image?: unknown; messages?: Array<{ content?: unknown }> }) => {
        visionInput = input;
        return {
          response: [
            'NVDA-RiskFactors-Sample',
            'Customer concentration: a small number of customers historically accounted for a large portion of revenue.',
            'Supply chain concentration: a substantial portion of our manufacturing is performed by Taiwan Semiconductor Manufacturing Company.',
          ].join('\n'),
        };
      },
      toMarkdown: async () => ({
        id: 'converted-1',
        name: 'NVDA_riskfactors_sample_scanned.pdf',
        mimeType: 'application/pdf',
        format: 'markdown',
        tokens: 12,
        data: 'Markdown Conversion page description',
      }),
    } as unknown as Ai;

    const parsed = await parseUploadBytesWithCloudflare(
      'NVDA_riskfactors_sample_scanned.pdf',
      'application/pdf',
      extractInlinePdfFromMinioMeta(fixture),
      ai,
      'auto',
      '@cf/meta/llama-3.2-11b-vision-instruct',
    );

    expect(parsed.parser).toBe('workers-ai-vision-markdown-ocr-v1');
    expect(parsed.text).toContain('Customer concentration');
    expect(parsed.text).toContain('Supply chain concentration');
    expect(Array.isArray(visionInput.image)).toBe(true);
  });

  it('converts Flate-compressed PDF image streams to PNG for Workers AI vision OCR', async () => {
    let visionInput: unknown = {};
    const ai = {
      run: async (_model: string, input: unknown) => {
        visionInput = input;
        return { response: 'Flate scanned page OCR text' };
      },
      toMarkdown: async () => ({
        id: 'converted-1',
        name: 'scan.pdf',
        mimeType: 'application/pdf',
        format: 'markdown',
        tokens: 12,
        data: 'Markdown fallback text',
      }),
    } as unknown as Ai;

    const parsed = await parseUploadBytesWithCloudflare(
      'scan.pdf',
      'application/pdf',
      binaryPdfWithFlateImage(),
      ai,
      'auto',
      '@cf/meta/llama-3.2-11b-vision-instruct',
    );

    expect(parsed.parser).toBe('workers-ai-vision-markdown-ocr-v1');
    expect(parsed.text).toContain('Flate scanned page OCR text');
    expect(visionInput).toMatchObject({
      prompt: expect.stringContaining('Transcribe scanned document image 1 of 1'),
      image: expect.any(Array),
    });
  });

  it('prioritizes page-like PDF images over tiny embedded logos for vision OCR', async () => {
    const visionInputs: Array<{ image?: number[] }> = [];
    const ai = {
      run: async (_model: string, input: { image?: number[] }) => {
        visionInputs.push(input);
        return { response: 'OCR text from the page-like scan' };
      },
      toMarkdown: async () => ({
        id: 'converted-1',
        name: 'scan.pdf',
        mimeType: 'application/pdf',
        format: 'markdown',
        tokens: 12,
        data: 'Markdown fallback text',
      }),
    } as unknown as Ai;

    const parsed = await parseUploadBytesWithCloudflare(
      'scan.pdf',
      'application/pdf',
      binaryPdfWithLogoAndPageImage(),
      ai,
      'auto',
      '@cf/meta/llama-3.2-11b-vision-instruct',
    );

    expect(visionInputs).toHaveLength(1);
    expect(visionInputs[0]?.image?.slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(parsed.text).toContain('OCR text from the page-like scan');
    expect(parsed.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          external_id: 'scan.pdf:vision-page:1',
          metadata: expect.objectContaining({
            image_width: 300,
            image_height: 300,
            vision_source_index: 2,
          }),
        }),
      ]),
    );
  });

  it('can force Workers AI Markdown Conversion for complex PDFs', async () => {
    const ai = {
      toMarkdown: async () => ({
        id: 'converted-1',
        name: 'complex.pdf',
        mimeType: 'application/pdf',
        format: 'markdown',
        tokens: 10,
        data: 'Converted OCR text from complex layout',
      }),
    } as unknown as Ai;

    const parsed = await parseUploadBytesWithCloudflare(
      'complex.pdf',
      'application/pdf',
      bytes('%PDF-1.7\n1 0 obj << /Type /Page >> endobj\nBT (tiny) Tj ET\n%%EOF'),
      ai,
      'always',
    );

    expect(parsed.parser).toBe('workers-ai-markdown-v1');
    expect(parsed.text).toBe('Converted OCR text from complex layout');
  });
});
