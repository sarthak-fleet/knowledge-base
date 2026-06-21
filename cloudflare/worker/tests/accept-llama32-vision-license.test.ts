import { describe, expect, it, vi } from 'vitest';
import { acceptLlama32VisionLicense, parseArgs } from '../scripts/accept-llama32-vision-license.mjs';

describe('accept-llama32-vision-license', () => {
  it('builds a dry-run request without requiring an auth token', async () => {
    const result = await acceptLlama32VisionLicense({
      accountId: 'account-123',
      token: '',
      dryRun: true,
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: true,
      token_present: false,
      request: {
        method: 'POST',
        url: 'https://api.cloudflare.com/client/v4/accounts/account-123/ai/run/@cf/meta/llama-3.2-11b-vision-instruct',
        body: { prompt: 'agree' },
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('requires an auth token for the real acceptance request', async () => {
    await expect(acceptLlama32VisionLicense({
      accountId: 'account-123',
      token: '',
      dryRun: false,
    })).rejects.toThrow('CLOUDFLARE_AUTH_TOKEN is required');
  });

  it('posts the acceptance payload and redacts the token from the result', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ success: true }));

    const result = await acceptLlama32VisionLicense({
      accountId: 'account-123',
      token: 'secret-token',
      dryRun: false,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account-123/ai/run/@cf/meta/llama-3.2-11b-vision-instruct',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ prompt: 'agree' }),
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      dry_run: false,
      status: 200,
    });
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('parses environment-driven arguments', () => {
    expect(parseArgs(['--', '--dry-run', '--json'], {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: 'account-123',
      CLOUDFLARE_AUTH_TOKEN: 'secret-token',
    })).toEqual({
      accountId: 'account-123',
      token: 'secret-token',
      dryRun: true,
      jsonOnly: true,
    });
  });
});
