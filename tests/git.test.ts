import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Hono } from 'hono';
import { RBAC } from '../src/utils/role';
import routes from '../src/routes/git';
import { packet, parseUpdate, REF, ZERO } from '../src/git/protocol';
import { deflate } from 'pako';
import { ObjectStore, validatePackBounds } from '../src/git/objectStore';
const exec = promisify(execFile);
(globalThis as any).caches = { default: { delete: async () => true, match: async () => undefined, put: async () => {} } };
function database() {
    const sql = new DatabaseSync(':memory:');
    const db: any = { prepare(query: string) {
        let params: any[] = [];
        const statement = { bind(...values: any[]) { params = values; return statement; },
            async first() { return sql.prepare(query).get(...params) || null; },
            async all() { return { results: sql.prepare(query).all(...params), success: true }; },
            async run() { const result = sql.prepare(query).run(...params); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
        }; return statement;
    }, async batch(items: any[]) { sql.exec('BEGIN'); try { const output = []; for (const item of items) output.push(await item.run()); sql.exec('COMMIT'); return output; } catch (error) { sql.exec('ROLLBACK'); throw error; } } };
    return { sql, db };
}
class Bucket {
    objects = new Map<string, Uint8Array>();
    async put(key: string, body: any) { this.objects.set(key, typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body)); return {}; }
    async get(key: string) { const value = this.objects.get(key); return value ? { arrayBuffer: async () => value.slice().buffer, text: async () => new TextDecoder().decode(value), body: new Blob([value]).stream(), httpMetadata: {} } : null; }
    async delete(key: string) { this.objects.delete(key); }
}
test('reference parser rejects deletions, creations, alternate refs and multiple updates', () => {
    const command = (old: string, next: string, ref = REF) => Buffer.concat([packet(`${old} ${next} ${ref}\0report-status\n`), Buffer.from('0000')]);
    for (const data of [command('a'.repeat(40), ZERO), command(ZERO, 'b'.repeat(40)), command('a'.repeat(40), 'b'.repeat(40), 'refs/tags/x')]) assert.throws(() => parseUpdate(data));
    assert.equal(parseUpdate(command('a'.repeat(40), 'b'.repeat(40))).newOid, 'b'.repeat(40));
});
test('pack preflight rejects inflated bombs and oversized delta results', () => {
    const header = Buffer.from('PACK00000000'); header.writeUInt32BE(2, 4); header.writeUInt32BE(1, 8);
    const pack = (object: number[], data: Uint8Array) => Buffer.concat([header, Buffer.from(object), Buffer.from(deflate(data)), Buffer.alloc(20)]);
    assert.throws(() => validatePackBounds(pack([0x31], Buffer.alloc(1024 * 1024 + 1))), /limit/);
    assert.throws(() => validatePackBounds(pack([0x65, 1], new Uint8Array([0, 128, 128, 128, 8]))), /Delta result/);
});
test('real Git clone, web pull, push, rejected force/delete, revoked permissions and privacy', { timeout: 120000 }, async () => {
    const { sql, db } = database();
    sql.exec(await readFile('migrations/schema.sql', 'utf8'));
    sql.exec("INSERT INTO users(id,provider,uid,email,name,role) VALUES(1,'nodeloc','1','test@example.com','Test editor','user'); INSERT INTO pages(id,slug,content,version) VALUES(1,'Git test','hello\\n',1); INSERT INTO revisions(id,page_id,page_version,content,author_id) VALUES(1,1,1,'hello\\n',1); UPDATE pages SET last_revision_id=1 WHERE id=1;");
    const bucket = new Bucket(), kv = new Map<string, string>();
    const env: any = { DB: db, MEDIA: bucket, KV: { get: async (key: string) => kv.get(key) || null, put: async (key: string, value: string) => kv.set(key, value), delete: async (key: string) => kv.delete(key) },
        ENABLED_EXTENSIONS: '', WIKI_NAME: 'Test Wiki', WIKI_VISIBILITY: 'public', SUPER_ADMIN_EMAILS: '', MAX_UPLOAD_SIZE: '15728640', EDIT_REQUEST_ENABLED: 'false', ASSETS: { fetch: async () => new Response('', { status: 404 }) } };
    const app = new Hono<any>();
    app.use('*', async (c, next) => { c.set('rbac', await RBAC.load(db)); c.set('user', c.req.path.startsWith('/api/') ? sql.prepare('SELECT * FROM users WHERE id=1').get() : null); await next(); });
    app.route('/', routes);
    const pending: Promise<any>[] = [], ctx: any = { waitUntil: (p: Promise<any>) => pending.push(p), passThroughOnException() {} };
    const tokenResponse = await app.request('/api/me/git-token', { method: 'POST' }, env, ctx);
    const token = (await tokenResponse.json() as any).token;
    assert.match(token, /^git_/);
    const server = createServer(async (req, res) => {
        try {
            const chunks = []; for await (const chunk of req) chunks.push(chunk);
            const headers: any = req.headers;
            const request = new Request(`http://127.0.0.1:${(server.address() as any).port}${req.url}`, { method: req.method, headers, ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: Buffer.concat(chunks) } : {}) });
            const response = await app.fetch(request, env, ctx);
            res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) { res.writeHead(500); res.end(String(error)); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    const dir = await mkdtemp(join(tmpdir(), 'vireo-native-git-'));
    const auth = Buffer.from(`wiki:${token}`).toString('base64');
    const git = (args: string[], cwd = dir) => exec('git', ['-c', `http.extraHeader=Authorization: Basic ${auth}`, ...args], { cwd, timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    try {
        await git(['clone', `http://127.0.0.1:${port}/git/pages/1.git`, 'page']);
        const repo = join(dir, 'page');
        assert.equal(await readFile(join(repo, 'page.md'), 'utf8'), 'hello\\n');
        await git(['config', 'user.name', 'Local Git Author'], repo); await git(['config', 'user.email', 'local@example.com'], repo);
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(repo, 'page.md'), 'first git change\n');
        await git(['add', 'page.md'], repo); await git(['commit', '-m', 'First Git edit'], repo);
        await writeFile(join(repo, 'page.md'), 'from git\n');
        await git(['add', 'page.md'], repo); await git(['commit', '-m', 'Native Git edit'], repo);
        await git(['push', 'origin', 'main'], repo);
        assert.equal((sql.prepare('SELECT content FROM pages WHERE id=1').get() as any).content, 'from git\n');
        assert.match((sql.prepare('SELECT summary FROM revisions ORDER BY id DESC LIMIT 1').get() as any).summary, /^\[Git /);
        const accepted = (await git(['rev-parse', 'HEAD'], repo)).stdout.trim();
        await git(['reset', '--hard', 'HEAD~1'], repo);
        await assert.rejects(() => git(['push', '--force', 'origin', 'main'], repo), /rejected|Non-fast-forward|linear/i);
        await assert.rejects(() => git(['push', 'origin', ':main'], repo), /rejected|deletion/i);
        assert.equal((sql.prepare('SELECT head FROM git_page_heads WHERE page_id=1').get() as any).head, accepted);
        await git(['reset', '--hard', accepted], repo);
        // A web revision appears as a descendant commit on the next fetch.
        sql.exec("INSERT INTO revisions(page_id,page_version,content,summary,author_id) VALUES(1,3,'from web','Web edit',1); UPDATE pages SET content='from web',version=3,last_revision_id=last_insert_rowid() WHERE id=1;");
        await git(['pull', '--rebase'], repo);
        assert.equal(await readFile(join(repo, 'page.md'), 'utf8'), 'from web');
        sql.exec('UPDATE revisions SET deleted_at=unixepoch() WHERE page_version=2');
        await git(['clone', `http://127.0.0.1:${port}/git/pages/1.git`, 'filtered']);
        assert.equal((await git(['rev-list', '--count', 'HEAD'], join(dir, 'filtered'))).stdout.trim(), '1');
        sql.exec('UPDATE revisions SET deleted_at=NULL WHERE page_version=2');
        await writeFile(join(repo, 'README.md'), 'unsupported file');
        await git(['add', 'README.md'], repo); await git(['commit', '-m', 'Unsupported file'], repo);
        await assert.rejects(() => git(['push', 'origin', 'main'], repo), /remote rejected/);
        await git(['reset', '--hard', 'HEAD~1'], repo);
        sql.prepare('UPDATE pages SET edit_acl=? WHERE id=1').run(JSON.stringify({flags:['admin_only']}));
        await writeFile(join(repo, 'page.md'), 'ACL denied');
        await git(['add', 'page.md'], repo); await git(['commit', '-m', 'ACL denied'], repo);
        await assert.rejects(() => git(['push', 'origin', 'main'], repo), /remote rejected/);
        assert.equal((sql.prepare('SELECT content FROM pages WHERE id=1').get() as any).content, 'from web');
        await git(['reset', '--hard', 'HEAD~1'], repo);
        sql.exec('UPDATE pages SET edit_acl=NULL WHERE id=1');
        await writeFile(join(repo, 'page.md'), 'denied edit'); await git(['add', 'page.md'], repo); await git(['commit', '-m', 'Denied edit'], repo);
        await db.prepare('UPDATE permission_groups SET permissions=? WHERE id=1').bind(JSON.stringify({ user: ['wiki:edit'] })).run();
        await assert.rejects(() => git(['push', 'origin', 'main'], repo), /403/);
        sql.exec('UPDATE pages SET is_private=1 WHERE id=1');
        await assert.rejects(() => git(['fetch'], repo), /404|not found/);
        sql.exec('UPDATE pages SET is_private=0 WHERE id=1');
        await app.request('/api/me/git-token', { method: 'DELETE' }, env, ctx);
        await assert.rejects(() => git(['fetch'], repo), /401|Authentication|could not read/i);
    } finally {
        await Promise.allSettled(pending); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); sql.close();
    }
});
