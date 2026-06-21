#!/usr/bin/env node

export const LLAMA32_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

function usage() {
  console.error(`Usage:
  node scripts/accept-llama32-vision-license.mjs [--dry-run] [--json]

Environment:
  CLOUDFLARE_ACCOUNT_ID  Required.
  CLOUDFLARE_AUTH_TOKEN  Required unless --dry-run is set.

This sends the one-time Workers AI license acceptance request for
${LLAMA32_VISION_MODEL}. It never prints the token.`);
}

export function parseArgs(argv, env = process.env) {
  const out = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID || '',
    token: env.CLOUDFLARE_AUTH_TOKEN || '',
    dryRun: false,
    jsonOnly: false,
  };

  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--json') {
      out.jsonOnly = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return out;
}

function acceptanceUrl(accountId) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${LLAMA32_VISION_MODEL}`;
}

export async function acceptLlama32VisionLicense(options) {
  const accountId = String(options.accountId || '').trim();
  const token = String(options.token || '').trim();
  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required');
  if (!options.dryRun && !token) throw new Error('CLOUDFLARE_AUTH_TOKEN is required unless --dry-run is set');

  const request = {
    method: 'POST',
    url: acceptanceUrl(accountId),
    model: LLAMA32_VISION_MODEL,
    body: { prompt: 'agree' },
  };

  if (options.dryRun) {
    return {
      ok: true,
      dry_run: true,
      request,
      token_present: Boolean(token),
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(request.url, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request.body),
  });
  const payload = await response.json().catch(async () => ({ text: await response.text().catch(() => '') }));
  const ok = response.ok && payload?.success !== false;
  return {
    ok,
    dry_run: false,
    status: response.status,
    request: {
      method: request.method,
      url: request.url,
      model: request.model,
      body: request.body,
    },
    result: payload,
  };
}

function printHuman(result) {
  if (result.dry_run) {
    console.log(`DRY RUN would POST { "prompt": "agree" } to ${result.request.url}`);
    console.log('No request was sent. Authorization token is not printed.');
    return;
  }
  console.log(`${result.ok ? 'ACCEPTED' : 'FAILED'} ${result.request.model} license request, status ${result.status}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await acceptLlama32VisionLicense(args);
    if (args.jsonOnly) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
