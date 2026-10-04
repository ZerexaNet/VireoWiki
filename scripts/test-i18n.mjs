import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const dir = await mkdtemp(join(tmpdir(), 'vireo-i18n-'));
try {
    const outfile = join(dir, 'i18n.test.cjs');
    await build({ entryPoints: ['tests/i18n.test.ts'], outfile, bundle: true, platform: 'node', format: 'cjs' });
    const result = spawnSync(process.execPath, ['--test', outfile, 'tests/i18n-shells.test.mjs'], { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
} finally { await rm(dir, { recursive: true, force: true }); }
