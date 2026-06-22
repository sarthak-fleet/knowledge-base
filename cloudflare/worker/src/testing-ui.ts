export const TESTING_UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Knowledgebase Cloudflare</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --line: #d7dce2;
      --text: #17202a;
      --muted: #5b6572;
      --accent: #0f766e;
      --accent-dark: #0b5f59;
      --bad: #b42318;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 64px;
      padding: 14px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 { margin: 0; font-size: 18px; font-weight: 680; letter-spacing: 0; }
    main { width: min(1240px, 100%); margin: 0 auto; padding: 20px; }
    .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 16px; align-items: start; }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
    }
    .span-4 { grid-column: span 4; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }
    h2 { margin: 0 0 12px; font-size: 14px; font-weight: 680; letter-spacing: 0; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; font-weight: 600; }
    input, textarea, select {
      width: 100%;
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 10px;
      color: var(--text);
      background: #fff;
      font: inherit;
    }
    textarea { min-height: 132px; resize: vertical; line-height: 1.45; }
    .stack { display: grid; gap: 10px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    button {
      min-height: 36px;
      border: 1px solid var(--accent-dark);
      border-radius: 6px;
      padding: 8px 12px;
      background: var(--accent);
      color: white;
      font-weight: 650;
      cursor: pointer;
    }
    button.secondary { background: #fff; color: var(--accent-dark); }
    button:disabled { opacity: .55; cursor: not-allowed; }
    pre {
      min-height: 320px;
      max-height: 620px;
      overflow: auto;
      margin: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #101418;
      color: #edf2f7;
      padding: 12px;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .status { color: var(--muted); font-size: 12px; }
    .error { color: var(--bad); }
    @media (max-width: 860px) {
      main { padding: 12px; }
      header { padding: 12px; align-items: stretch; flex-direction: column; }
      .span-4, .span-8 { grid-column: span 12; }
      .row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Knowledgebase Cloudflare</h1>
    <label>
      Service key
      <input id="key" type="password" autocomplete="off">
    </label>
  </header>
  <main>
    <div class="grid">
      <section class="span-4 stack">
        <h2>Corpus</h2>
        <label>Domain <input id="domain" value="manuals"></label>
        <label>Description <input id="description" value=""></label>
        <button id="createDomain">Save Domain</button>
        <label>File <input id="file" type="file"></label>
        <button id="uploadFile">Upload To R2</button>
        <button class="secondary" id="inferUpload">Infer From File</button>
        <label>Structured sample <textarea id="schemaSample">[
  { "id": "doc-1", "title": "Example", "category": "manual" }
]</textarea></label>
        <button id="inferSchema">Infer Schema</button>
        <button class="secondary" id="applySchema">Apply Last Schema</button>
        <label>Record type <input id="recordType" value="Record"></label>
        <label>Structured records <textarea id="recordData">[
  { "id": "doc-1", "title": "Example", "category": "manual" }
]</textarea></label>
        <button class="secondary" id="ingestRecords">Ingest Records</button>
        <label>Text title <input id="domainTextTitle" value="note"></label>
        <label>Domain text <textarea id="domainText">Paste free-form domain text.</textarea></label>
        <button class="secondary" id="ingestDomainText">Ingest Domain Text</button>
        <button class="secondary" id="ingestDomain">Inline Ingest</button>
        <button class="secondary" id="queueIngestDomain">Queue Ingest</button>
        <label>Run id <input id="runId" placeholder="queued ingest run id"></label>
        <button class="secondary" id="loadRunProgress">Load Run Progress</button>
        <label>Source type
          <select id="sourceType">
            <option value="url">url</option>
            <option value="edgar">edgar</option>
          </select>
        </label>
        <label>Source URLs <textarea id="sourceUrls">https://example.com/document.html</textarea></label>
        <label>SEC tickers <input id="sourceTickers" value="NVDA"></label>
        <label>SEC forms <input id="sourceForms" value="10-K,10-Q,8-K"></label>
        <label>SEC user agent <input id="secUserAgent" placeholder="app email@example.com"></label>
        <label><input id="sourceAutoIngest" type="checkbox" checked> Stage ingest jobs</label>
        <button class="secondary" id="importSource">Import Source</button>
        <button class="secondary" id="loadSourceSets">Load Source Sets</button>
        <label>Source action
          <select id="sourceAction">
            <option value="requeue_failed">requeue_failed</option>
            <option value="requeue_pending">requeue_pending</option>
            <option value="archive_failed">archive_failed</option>
            <option value="archive_ready">archive_ready</option>
            <option value="delete_failed">delete_failed</option>
            <option value="delete_pending">delete_pending</option>
          </select>
        </label>
        <button class="secondary" id="dryRunSourceAction">Dry Run Source Action</button>
        <button class="secondary" id="applySourceAction">Apply Source Action</button>
        <button class="secondary" id="loadEntities">Load Entities</button>
        <button class="secondary" id="searchEntities">Search Entities</button>
        <button class="secondary" id="loadRelationships">Load Relationships</button>
        <button class="secondary" id="backfillRelationships">Backfill Relationships</button>
        <button class="secondary" id="loadJobs">Load Jobs</button>
        <button class="secondary" id="loadStatus">Refresh Status</button>
      </section>
      <section class="span-4 stack">
        <h2>Index</h2>
        <label>Index name <input id="indexName" value="Test Index"></label>
        <label>Embedding profile
          <select id="embeddingProfile">
            <option value="base">base</option>
            <option value="small">small</option>
          </select>
        </label>
        <label>Embedding model
          <select id="embeddingModel">
            <option value="">profile default</option>
          </select>
        </label>
        <button class="secondary" id="loadEmbeddingModels">Load Embedding Models</button>
        <button id="createIndex">Create Index</button>
        <label>Index id <input id="indexId"></label>
        <label>Raw text <textarea id="rawText">Paste text to ingest into Vectorize.</textarea></label>
        <button id="ingestText">Ingest Text</button>
      </section>
      <section class="span-4 stack">
        <h2>Query</h2>
        <label>Mode
          <select id="mode">
            <option value="auto">auto</option>
            <option value="hybrid">hybrid</option>
            <option value="lexical">lexical</option>
            <option value="semantic">semantic</option>
          </select>
        </label>
        <label>Top K <input id="topK" type="number" min="1" max="50" value="5"></label>
        <label>Semantic model
          <select id="semanticModel">
            <option value="base">base</option>
            <option value="small">small</option>
          </select>
        </label>
        <label>Min score <input id="minScore" type="number" min="0" max="1" step="0.01" placeholder="index query only"></label>
        <label><input id="rerank" type="checkbox" checked> Rerank</label>
        <label>Rerank model
          <select id="rerankModel">
            <option value="keyword">keyword</option>
            <option value="workers_ai">Workers AI</option>
          </select>
        </label>
        <label>Answer mode
          <select id="answerMode">
            <option value="extractive">extractive</option>
            <option value="workers_ai">Workers AI</option>
          </select>
        </label>
        <label>Answer model <input id="answerModel" value="@cf/meta/llama-3.1-8b-instruct"></label>
        <label><input id="mmr" type="checkbox" checked> MMR</label>
	        <label><input id="queryRewrite" type="checkbox" checked> Rewrite</label>
	        <label><input id="queryDecompose" type="checkbox" checked> Decompose</label>
	        <label><input id="aiJudge" type="checkbox"> AI judge eval</label>
	        <label>Judge model <input id="judgeModel" value="@cf/meta/llama-3.1-8b-instruct"></label>
        <label>Markdown conversion
          <select id="markdownConversion">
            <option value="">env/default</option>
            <option value="auto">auto</option>
            <option value="always">always</option>
            <option value="off">off</option>
          </select>
        </label>
        <label>Vision OCR model <input id="visionOcrModel" placeholder="@cf/..."></label>
        <label><input id="parseTextPreview" type="checkbox"> Text preview</label>
	        <label>Scope <input id="scope" placeholder="optional answer scope"></label>
        <label>Vector filter <textarea id="queryFilter">{}</textarea></label>
        <label>Session id <input id="sessionId" placeholder="optional"></label>
        <label>Query <textarea id="query">What is this corpus about?</textarea></label>
        <button id="runQuery">Run Query</button>
        <button class="secondary" id="runKbSearch">Search Domain</button>
        <button class="secondary" id="runKbAnswer">Answer Domain</button>
        <button class="secondary" id="streamKbAnswer">Stream Answer</button>
        <button class="secondary" id="createSession">Create Session</button>
        <button class="secondary" id="loadSessions">Load Sessions</button>
        <button class="secondary" id="loadTraces">Load Traces</button>
        <button class="secondary" id="exportTraces">Export Traces</button>
        <div class="row">
          <label>Trace A <input id="traceA" placeholder="baseline trace id"></label>
          <label>Trace B <input id="traceB" placeholder="candidate trace id"></label>
        </div>
        <button class="secondary" id="compareTraces">Compare Traces</button>
        <button class="secondary" id="loadTraceDrilldown">Load Trace Drilldown</button>
        <label>Eval cases <textarea id="evalCases">[
  { "id": "q1", "query": "example", "expected_text": "example" }
]</textarea></label>
        <button class="secondary" id="runEval">Run Eval</button>
        <button class="secondary" id="runAnswerEval">Run Answer Eval</button>
        <button class="secondary" id="runParseEval">Run Parse Eval</button>
        <button class="secondary" id="loadEvalSummary">Load Eval Summary</button>
        <button class="secondary" id="loadEvalReports">Load Eval Reports</button>
      </section>
      <section class="span-12 stack">
        <h2>Output</h2>
        <div class="status" id="statusLine">Idle</div>
        <pre id="output">{}</pre>
      </section>
    </div>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    const out = $('output');
    const statusLine = $('statusLine');
    let activeIndexId = '';
    let lastSchema = null;
    let pollTimer = null;

    function key() { return $('key').value.trim(); }
    function headers(json = true) {
      const h = { Authorization: 'Bearer ' + key() };
      if (json) h['Content-Type'] = 'application/json';
      return h;
    }
    function show(value) {
      out.textContent = JSON.stringify(value, null, 2);
    }
    function setLastSchema(spec) {
      lastSchema = spec;
      const entity = spec && Array.isArray(spec.entities) ? spec.entities[0] : null;
      if (entity && entity.name) $('recordType').value = entity.name;
    }
    function rankingOptions() {
      return {
        rerank: $('rerank').checked,
        rerank_model: $('rerankModel').value,
        mmr: $('mmr').checked,
      };
    }
    function parsedFilter() {
      const raw = $('queryFilter').value.trim();
      if (!raw || raw === '{}') return undefined;
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
    function queryOptions(includeIndexOnly = false) {
      const minScore = Number($('minScore').value);
      const filter = parsedFilter();
      return {
        top_k: Number($('topK').value || 5),
        mode: $('mode').value,
        semantic_model: $('semanticModel').value,
        ...rankingOptions(),
        query_rewrite: $('queryRewrite').checked,
        query_decompose: $('queryDecompose').checked,
        ...(includeIndexOnly && Number.isFinite(minScore) ? { min_score: minScore } : {}),
        ...(includeIndexOnly && filter ? { filter } : {}),
      };
    }
    function answerOptions() {
      return {
        answer_mode: $('answerMode').value,
        answer_model: $('answerModel').value.trim() || undefined,
      };
    }
    function embeddingSelection() {
      const embeddingModel = $('embeddingModel').value.trim();
      return embeddingModel ? { embedding_model: embeddingModel } : {};
    }
    function applyEmbeddingSelectionForm(form) {
      const embeddingModel = $('embeddingModel').value.trim();
      if (embeddingModel) form.set('embedding_model', embeddingModel);
    }
    function listInput(id) {
      return $(id).value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
    }
    async function call(path, init = {}) {
      statusLine.textContent = init.method || 'GET';
      const res = await fetch(path, init);
      const text = await res.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
      show({ status: res.status, body });
      statusLine.textContent = res.ok ? 'OK' : 'Error';
      statusLine.className = res.ok ? 'status' : 'status error';
      if (!res.ok) throw new Error('request failed');
      return body;
    }
    async function loadRunProgress() {
      const runId = $('runId').value.trim();
      if (!runId) return null;
      return await call('/v1/kb/ingest/runs/' + encodeURIComponent(runId) + '?domain=' + encodeURIComponent($('domain').value.trim()), {
        headers: headers(false),
      });
    }
    function watchRunProgress() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        try {
          const body = await loadRunProgress();
          if (body && body.summary && body.summary.done) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        } catch {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }, 2000);
    }

    $('createDomain').onclick = async () => {
      await call('/v1/kb/domains', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          name: $('domain').value.trim(),
          description: $('description').value.trim(),
          ...embeddingSelection(),
        }),
      });
    };
    $('uploadFile').onclick = async () => {
      const file = $('file').files[0];
      if (!file) return;
      const form = new FormData();
      form.set('domain', $('domain').value.trim());
      form.set('file', file);
      applyEmbeddingSelectionForm(form);
      if ($('markdownConversion').value) form.set('markdown_conversion', $('markdownConversion').value);
      if ($('visionOcrModel').value.trim()) form.set('vision_ocr_model', $('visionOcrModel').value.trim());
      await call('/v1/kb/files/upload', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key() },
        body: form,
      });
    };
    $('inferUpload').onclick = async () => {
      const file = $('file').files[0];
      if (!file) return;
      const form = new FormData();
      form.set('domain', $('domain').value.trim());
      form.set('file', file);
      applyEmbeddingSelectionForm(form);
      if ($('markdownConversion').value) form.set('markdown_conversion', $('markdownConversion').value);
      if ($('visionOcrModel').value.trim()) form.set('vision_ocr_model', $('visionOcrModel').value.trim());
      const body = await call('/v1/kb/schemas/infer-upload', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key() },
        body: form,
      });
      setLastSchema(body.spec);
    };
    $('loadStatus').onclick = async () => {
      await call('/v1/kb/status', { headers: headers(false) });
    };
    $('loadJobs').onclick = async () => {
      await call('/v1/kb/jobs?domain=' + encodeURIComponent($('domain').value.trim()), {
        headers: headers(false),
      });
    };
    $('loadEntities').onclick = async () => {
      await call('/v1/kb/entities?domain=' + encodeURIComponent($('domain').value.trim()), {
        headers: headers(false),
      });
    };
    $('searchEntities').onclick = async () => {
      await call('/v1/kb/entities/search', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          domain: $('domain').value.trim(),
          query: $('query').value,
          limit: Number($('topK').value || 5),
        }),
      });
    };
    $('loadRelationships').onclick = async () => {
      await call('/v1/kb/relationships?domain=' + encodeURIComponent($('domain').value.trim()), {
        headers: headers(false),
      });
    };
    $('backfillRelationships').onclick = async () => {
      await call('/v1/kb/relationships/backfill', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ domain: $('domain').value.trim() }),
      });
    };
    $('inferSchema').onclick = async () => {
      let input = $('schemaSample').value;
      try { input = JSON.parse(input); } catch {}
      const body = await call('/v1/kb/schemas/infer', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ domain: $('domain').value.trim(), input, ...embeddingSelection() }),
      });
      setLastSchema(body.spec);
    };
    $('applySchema').onclick = async () => {
      if (!lastSchema) return;
      await call('/v1/kb/schemas', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(lastSchema),
      });
    };
    $('ingestRecords').onclick = async () => {
      let data = [];
      try { data = JSON.parse($('recordData').value); } catch {}
      await call('/v1/kb/ingest/record', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          domain: $('domain').value.trim(),
          type: $('recordType').value.trim(),
          data,
          ...embeddingSelection(),
        }),
      });
    };
    $('ingestDomainText').onclick = async () => {
      await call('/v1/kb/ingest/text', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          domain: $('domain').value.trim(),
          type: $('recordType').value.trim() || undefined,
          title: $('domainTextTitle').value.trim() || undefined,
          text: $('domainText').value,
          ...embeddingSelection(),
        }),
      });
    };
    $('ingestDomain').onclick = async () => {
      await call('/v1/kb/ingest/run', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          domain: $('domain').value.trim(),
          async: false,
          ...embeddingSelection(),
          markdown_conversion: $('markdownConversion').value || undefined,
          vision_ocr_model: $('visionOcrModel').value.trim() || undefined,
        }),
      });
    };
    $('queueIngestDomain').onclick = async () => {
      const body = await call('/v1/kb/ingest/run', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          domain: $('domain').value.trim(),
          async: true,
          ...embeddingSelection(),
          markdown_conversion: $('markdownConversion').value || undefined,
          vision_ocr_model: $('visionOcrModel').value.trim() || undefined,
        }),
      });
      if (body.run_id) {
        $('runId').value = body.run_id;
        watchRunProgress();
      }
    };
    $('loadRunProgress').onclick = async () => {
      await loadRunProgress();
    };
    $('importSource').onclick = async () => {
      const source = $('sourceType').value;
      await call('/v1/kb/sources/import', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          domain: $('domain').value.trim(),
          source,
          auto_ingest: $('sourceAutoIngest').checked,
          ...embeddingSelection(),
          config: source === 'edgar'
            ? {
                tickers: listInput('sourceTickers'),
                forms: listInput('sourceForms'),
                limit_total: 5,
                per_ticker_per_form: 1,
                ...($('secUserAgent').value.trim() ? { user_agent: $('secUserAgent').value.trim() } : {}),
              }
            : { urls: listInput('sourceUrls') },
        }),
      });
    };
    $('loadSourceSets').onclick = async () => {
      await call('/v1/kb/source-sets?domain=' + encodeURIComponent($('domain').value.trim()), {
        headers: headers(false),
      });
    };
    async function sourceAction(dryRun) {
      await call('/v1/kb/source-sets/' + encodeURIComponent('domain:' + $('domain').value.trim()) + '/actions', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ action: $('sourceAction').value, dry_run: dryRun }),
      });
    }
    $('dryRunSourceAction').onclick = async () => {
      await sourceAction(true);
    };
    $('applySourceAction').onclick = async () => {
      await sourceAction(false);
    };
    $('createIndex').onclick = async () => {
      const embeddingModel = $('embeddingModel').value.trim();
      const payload = { name: $('indexName').value.trim() };
      if (embeddingModel) payload.embedding_model = embeddingModel;
      else payload.embedding_profile = $('embeddingProfile').value;
      const body = await call('/v1/indexes', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload),
      });
      activeIndexId = body.id;
      $('indexId').value = body.id;
    };
    $('loadEmbeddingModels').onclick = async () => {
      const body = await call('/v1/embedding-models', { headers: headers() });
      const models = Array.isArray(body.free_ai_models) ? body.free_ai_models : [];
      const select = $('embeddingModel');
      select.replaceChildren(new Option('profile default', ''));
      if (body.catalog_source !== 'free_ai') return;
      for (const model of models.filter((item) => item && item.selectable === true)) {
        select.append(new Option(model.id + ' (' + (model.provider || '') + ', ' + (model.dimensions || '') + 'd, ' + (model.vectorize_binding || model.compatible_profile) + ')', model.id));
      }
    };
    $('ingestText').onclick = async () => {
      const id = $('indexId').value.trim() || activeIndexId;
      await call('/v1/indexes/' + encodeURIComponent(id) + '/ingest', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ documents: [{ content: $('rawText').value, metadata: { source: 'testing-ui' } }] }),
      });
    };
    $('runQuery').onclick = async () => {
      const id = $('indexId').value.trim() || activeIndexId;
      await call('/v1/indexes/' + encodeURIComponent(id) + '/query', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          query: $('query').value,
          ...queryOptions(true),
        }),
      });
    };
    $('runKbSearch').onclick = async () => {
      await call('/v1/kb/search', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          domain: $('domain').value.trim(),
          query: $('query').value,
          ...queryOptions(),
        }),
      });
    };
    $('runKbAnswer').onclick = async () => {
      const sessionId = $('sessionId').value.trim();
      await call('/v1/kb/query', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          domain: $('domain').value.trim(),
          question: $('query').value,
          ...queryOptions(),
          ...answerOptions(),
          ...($('scope').value.trim() ? { scope: $('scope').value.trim() } : {}),
          ...(sessionId ? { session_id: sessionId } : {}),
        }),
      });
    };
    $('streamKbAnswer').onclick = async () => {
      const sessionId = $('sessionId').value.trim();
      statusLine.textContent = 'POST stream';
      const res = await fetch('/v1/kb/query/stream', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          domain: $('domain').value.trim(),
          question: $('query').value,
          ...queryOptions(),
          ...answerOptions(),
          ...($('scope').value.trim() ? { scope: $('scope').value.trim() } : {}),
          ...(sessionId ? { session_id: sessionId } : {}),
        }),
      });
      const text = await res.text();
      out.textContent = text;
      statusLine.textContent = res.ok ? 'OK stream' : 'Error';
      statusLine.className = res.ok ? 'status' : 'status error';
      if (!res.ok) throw new Error('request failed');
    };
    $('createSession').onclick = async () => {
      const body = await call('/v1/kb/sessions', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          domain: $('domain').value.trim(),
          id: $('sessionId').value.trim() || undefined,
        }),
      });
      $('sessionId').value = body.id || $('sessionId').value;
    };
    $('loadSessions').onclick = async () => {
      await call('/v1/kb/sessions?domain=' + encodeURIComponent($('domain').value.trim()), {
        headers: headers(false),
      });
    };
    $('loadTraces').onclick = async () => {
      await call('/v1/kb/query/traces?domain=' + encodeURIComponent($('domain').value.trim()), {
        headers: headers(false),
      });
    };
    $('exportTraces').onclick = async () => {
      await call('/v1/kb/query/traces/export?domain=' + encodeURIComponent($('domain').value.trim()), {
        headers: headers(false),
      });
    };
    $('compareTraces').onclick = async () => {
      await call('/v1/kb/query/traces/compare', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          baseline_trace_id: $('traceA').value.trim(),
          candidate_trace_id: $('traceB').value.trim(),
        }),
      });
    };
    $('loadTraceDrilldown').onclick = async () => {
      const traceId = $('traceA').value.trim();
      await call('/v1/kb/query/trace/' + encodeURIComponent(traceId) + '/drilldown', {
        headers: headers(false),
      });
    };
    $('runEval').onclick = async () => {
      const id = $('indexId').value.trim() || activeIndexId;
      let cases = [];
      try { cases = JSON.parse($('evalCases').value); } catch {}
      await call('/v1/kb/evals/search', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          index_id: id,
          ...queryOptions(),
          cases,
        }),
      });
    };
    $('runAnswerEval').onclick = async () => {
      let cases = [];
      try { cases = JSON.parse($('evalCases').value); } catch {}
      await call('/v1/kb/evals/query', {
        method: 'POST',
        headers: headers(),
	        body: JSON.stringify({
	          domain: $('domain').value.trim(),
	          ...queryOptions(),
	          ...answerOptions(),
	          ai_judge: $('aiJudge').checked,
	          judge_model: $('judgeModel').value.trim() || undefined,
	          cases,
	        }),
      });
    };
    $('runParseEval').onclick = async () => {
      let cases = [];
      try { cases = JSON.parse($('evalCases').value); } catch {}
      await call('/v1/kb/evals/parse', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          domain: $('domain').value.trim(),
          markdown_conversion: $('markdownConversion').value || undefined,
          vision_ocr_model: $('visionOcrModel').value.trim() || undefined,
          include_text_preview: $('parseTextPreview').checked,
          cases,
        }),
      });
    };
    $('loadEvalReports').onclick = async () => {
      await call('/v1/kb/evals/reports?domain=' + encodeURIComponent($('domain').value.trim()), {
        headers: headers(false),
      });
    };
    $('loadEvalSummary').onclick = async () => {
      await call('/v1/kb/evals/summary?domain=' + encodeURIComponent($('domain').value.trim()), {
        headers: headers(false),
      });
    };
  </script>
</body>
</html>`;
