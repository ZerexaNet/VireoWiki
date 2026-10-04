import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const dir = await mkdtemp(join(tmpdir(), 'vireo-git-'));
try {
    const outfile = join(dir, 'git.test.mjs');
    await build({ entryPoints: ['tests/git.test.ts'], outfile, bundle: true, platform: 'node', format: 'esm', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
    process.exitCode = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' }).status ?? 1;
} finally { await rm(dir, { recursive: true, force: true }); }
