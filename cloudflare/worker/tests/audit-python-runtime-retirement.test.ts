import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pythonRuntimeRetirementReport } from '../scripts/audit-python-runtime-retirement.mjs';

async function makeRepo() {
  return mkdtemp(join(tmpdir(), 'kb-python-runtime-audit-'));
}

describe('audit-python-runtime-retirement', () => {
  it('passes when retired Python runtime surfaces are absent', async () => {
    const repoRoot = await makeRepo();

    const report = pythonRuntimeRetirementReport({ repoRoot });

    expect(report).toMatchObject({
      ok: true,
      present_count: 0,
      present: [],
    });
  });

  it('ignores generated Python cache artifacts left by local cleanup', async () => {
    const repoRoot = await makeRepo();
    mkdirSync(resolve(repoRoot, 'src/kb/__pycache__'), { recursive: true });
    mkdirSync(resolve(repoRoot, 'tests/.pytest_cache'), { recursive: true });
    writeFileSync(resolve(repoRoot, 'src/kb/__pycache__/cli.cpython-311.pyc'), 'cache');
    writeFileSync(resolve(repoRoot, 'tests/.pytest_cache/README.md'), 'cache');

    const report = pythonRuntimeRetirementReport({ repoRoot });

    expect(report).toMatchObject({
      ok: true,
      present_count: 0,
      present: [],
    });
  });

  it('fails when retired Python runtime files or directories exist', async () => {
    const repoRoot = await makeRepo();
    mkdirSync(resolve(repoRoot, 'src/kb/api'), { recursive: true });
    mkdirSync(resolve(repoRoot, 'scripts'), { recursive: true });
    mkdirSync(resolve(repoRoot, 'streamlit_app'), { recursive: true });
    mkdirSync(resolve(repoRoot, 'tests'), { recursive: true });
    writeFileSync(resolve(repoRoot, 'pyproject.toml'), '[project]\nname = "knowledgebase"\n');
    writeFileSync(resolve(repoRoot, 'scripts/bench.py'), 'print("old bench")\n', { flag: 'w' });
    writeFileSync(resolve(repoRoot, 'src/kb/api/app.py'), 'app = object()\n');
    writeFileSync(resolve(repoRoot, 'streamlit_app/app.py'), 'print("ui")\n');
    writeFileSync(resolve(repoRoot, 'tests/test_api.py'), 'def test_api(): pass\n');

    const report = pythonRuntimeRetirementReport({ repoRoot });

    expect(report.ok).toBe(false);
    expect(report.present).toEqual([
      'pyproject.toml',
      'scripts/bench.py',
      'src/kb',
      'streamlit_app',
      'tests',
    ]);
  });
});
