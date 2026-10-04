import { Hono } from 'hono';
import { Buffer } from 'node:buffer';
import * as git from 'isomorphic-git';
import type { Env, User } from '../types';
import { requireAuth } from '../middleware/session';
import { isSuperAdmin } from '../utils/auth';
import { ObjectStore, newCommits } from '../git/objectStore';
import { advertisement, parsePackets, parseUpdate, packet, status, OID } from '../git/protocol';
import { acquire, release, ensureGit, page, synchronize, recordHead } from '../git/storage';
import wikiRoutes from './wiki';
import { ui } from '../i18n/server';
const routes = new Hono<Env>();
const hash = async (token: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');
const challenge = () => new Response('Git authentication required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="VireoWiki Git", charset="UTF-8"', 'Cache-Control': 'no-store' } });
const transport = (body: Uint8Array, service: string) => new Response(Buffer.from(body), { headers: { 'Content-Type': `application/x-${service}-result`, 'Cache-Control': 'no-store' } });
async function boundedBody(request: Request, limit: number) {
    if (Number(request.headers.get('Content-Length') || 0) > limit) throw new Error('Request too large');
    if (!request.body) return Buffer.alloc(0);
    const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error('Request too large'); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks);
}
// Browser token management uses the normal session and CSRF protection. Passwords are one-time output.
routes.get('/api/me/git-token', requireAuth, async c => {
    await ensureGit(c.env.DB);
    const token = await c.env.DB.prepare('SELECT masked_token, expires_at FROM git_tokens WHERE user_id = ?').bind(c.get('user')!.id).first();
    return c.json({ token }, 200, { 'Cache-Control': 'no-store' });
});
routes.post('/api/me/git-token', requireAuth, async c => {
    await ensureGit(c.env.DB);
    const raw = `git_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`;
    const expires = Math.floor(Date.now() / 1000) + 30 * 86400;
    await c.env.DB.prepare('INSERT OR REPLACE INTO git_tokens (user_id, token_hash, masked_token, expires_at, created_at) VALUES (?, ?, ?, ?, unixepoch())')
        .bind(c.get('user')!.id, await hash(raw), raw.slice(0, 8) + '…' + raw.slice(-4), expires).run();
    return c.json({ token: raw, expires_at: expires }, 200, { 'Cache-Control': 'no-store' });
});
routes.delete('/api/me/git-token', requireAuth, async c => { await ensureGit(c.env.DB); await c.env.DB.prepare('DELETE FROM git_tokens WHERE user_id = ?').bind(c.get('user')!.id).run(); return c.json({ success: true }); });
// Basic credentials are intentionally restricted to the Git transport, never accepted for browser APIs.
routes.use('/git/pages/*', async (c, next) => {
    const authorization = c.req.header('Authorization') || '';
    if (!authorization.startsWith('Basic ')) return challenge();
    let token: string;
    try { const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8'); token = decoded.slice(decoded.indexOf(':') + 1); }
    catch { return challenge(); }
    if (!/^git_[a-f0-9]{64}$/.test(token)) return challenge();
    await ensureGit(c.env.DB);
    const user = await c.env.DB.prepare(`SELECT u.* FROM users u JOIN git_tokens t ON t.user_id = u.id WHERE t.token_hash = ? AND t.expires_at > unixepoch()`)
        .bind(await hash(token)).first<User>();
    if (!user || user.role === 'deleted' || (user.banned_until && user.banned_until > Math.floor(Date.now() / 1000))) return challenge();
    if (isSuperAdmin(user.email, c.env)) user.role = 'super_admin';
    else if (user.role === 'banned') { if (!user.banned_until) return challenge(); user.role = 'user'; }
    c.set('user', user); await next();
});
async function accessible(c: any) {
    const idText = c.req.param('repository');
    if (!/^[1-9][0-9]*\.git$/.test(idText)) return null;
    const id = Number(idText.slice(0, -4));
    if (!Number.isSafeInteger(id)) return null;
    const current = await page(c.env.DB, id);
    if (!current || current.deleted_at || (current.is_private && !c.get('rbac').can(c.get('user').role, 'wiki:private'))) return null;
    return current;
}

async function exportHistory(db: D1Database, store: ObjectStore, id: number, head: string) {
    const objects: string[] = [], commits: string[] = [];
    let exportedBytes = 0;
    let cursor: string | null = head, shallow: string | null = null, last: string | null = null;
    while (cursor) {
        const link = await db.prepare(`SELECT l.revision_id, r.id AS revision_present, r.deleted_at, r.purged_at FROM git_commit_links l LEFT JOIN revisions r ON r.id = l.revision_id WHERE l.page_id = ? AND l.oid = ?`)
            .bind(id, cursor).first<{ revision_id: number | null; revision_present: number | null; deleted_at: number | null; purged_at: number | null }>();
        if (!link || link.deleted_at || link.purged_at || commits.length >= 100) { shallow = last; break; }
        // A physically removed revision must not leak through a previously exported Git object.
        if (link.revision_id && !link.revision_present) { shallow = last; break; }
        const commit: git.CommitObject = (await git.readCommit({ ...store.args, oid: cursor })).commit;
        const snapshot = await store.content(cursor);
        exportedBytes += Buffer.byteLength(snapshot.text);
        if (exportedBytes > 8 * 1024 * 1024) { shallow = last; break; }
        objects.push(...snapshot.objects); commits.push(cursor); last = cursor; cursor = commit.parent[0] || null;
    }

    if (!commits.length) throw new Error('Revision unavailable');
    return { objects, shallow };
}
routes.get('/git/pages/:repository/info/refs', async c => {
    const service = c.req.query('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return c.text('Unsupported Git service', 400);
    const current = await accessible(c);
    if (!current) return c.text('Repository unavailable', 404);
    if (service === 'git-receive-pack' && (!c.get('rbac').can(c.get('user')!.role, 'git:push') || !c.get('rbac').can(c.get('user')!.role, 'wiki:edit'))) return c.text('Editing permission required', 403);
    let lease: string | undefined;
    try {
        lease = await acquire(c.env.DB, current.id);
        const store = new ObjectStore(c.env.MEDIA, current.id);
        const head = await synchronize(c.env, store, current, lease, new URL(c.req.url).origin);
        const { shallow } = await exportHistory(c.env.DB, store, current.id, head);
        return new Response(advertisement(head, service, shallow), { headers: { 'Content-Type': `application/x-${service}-advertisement`, 'Cache-Control': 'no-store' } });
    } catch (e) { return c.text((e as Error).message, 409); }
    finally { if (lease) await release(c.env.DB, current.id, lease); }
});
routes.post('/git/pages/:repository/git-upload-pack', async c => {
    const current = await accessible(c); if (!current) return c.text('Repository unavailable', 404);
    if (!c.req.header('Content-Type')?.startsWith('application/x-git-upload-pack-request')) return c.text('Invalid content type', 415);
    try {
        const body = await boundedBody(c.req.raw, 256 * 1024);
        const { lines, rest } = parsePackets(body);
        const saved = await c.env.DB.prepare('SELECT head, version FROM git_page_heads WHERE page_id = ?').bind(current.id).first<{ head: string; version: number }>();
        if (!saved || saved.version !== current.version) return c.text('Wiki changed; fetch again', 409);
        const wants = lines.filter(s => s.startsWith('want ')).map(s => s.split(' ')[1]);
        if (wants.length !== 1 || wants[0] !== saved.head) return c.text('Only the advertised head can be fetched', 403);
        if (lines.some(s => s.startsWith('deepen'))) return c.text('Client-selected shallow depth is not supported', 400);
        const store = new ObjectStore(c.env.MEDIA, current.id);
        const { objects } = await exportHistory(c.env.DB, store, current.id, saved.head);
        // Recheck visibility after the object walk, before any content leaves the worker.
        const fresh = await accessible(c); if (!fresh || fresh.version !== current.version) return c.text('Wiki changed; fetch again', 409);
        const done = rest.includes(Buffer.from('done\n')) || lines.some(line => line.trim() === 'done');
        if (!done) return transport(packet('NAK\n'), 'git-upload-pack');
        return transport(Buffer.concat([packet('NAK\n'), Buffer.from(await store.pack(objects))]), 'git-upload-pack');
    } catch (e) { return c.text((e as Error).message, 400); }
});
routes.post('/git/pages/:repository/git-receive-pack', async c => {
    const current = await accessible(c); if (!current) return c.text('Repository unavailable', 404);
    const user = c.get('user')!, rbac = c.get('rbac');
    if (!rbac.can(user.role, 'git:push') || !rbac.can(user.role, 'wiki:edit')) return c.text('Editing permission required', 403);
    if (!c.req.header('Content-Type')?.startsWith('application/x-git-receive-pack-request')) return c.text('Invalid content type', 415);
    let lease: string | undefined;
    try {
        const update = parseUpdate(await boundedBody(c.req.raw, 4 * 1024 * 1024));
        lease = await acquire(c.env.DB, current.id);
        const store = new ObjectStore(c.env.MEDIA, current.id);
        const head = await synchronize(c.env, store, current, lease, new URL(c.req.url).origin);
        if (update.oldOid !== head) throw new Error('Stale head; pull before pushing');
        await store.unpack(update.pack);
        const commits = await newCommits(store, head, update.newOid);
        if (!commits.length) return transport(status(true), 'git-receive-pack');
        const objects: string[] = [];
        for (const oid of commits) objects.push(...(await store.content(oid)).objects);
        const final = await store.content(update.newOid);
        const commit = (await git.readCommit({ ...store.args, oid: update.newOid })).commit;
        // Use the existing Wiki writer so ACLs, locks, edit queues, validation and conflict checks remain authoritative.
        const writer = new Hono<Env>();
        writer.use('*', async (ctx, next) => { ctx.set('user', user); ctx.set('rbac', rbac); ctx.set('gitAuthenticated', true); ctx.set('gitTargetPageId', current.id); await next(); });
        writer.route('/api', wikiRoutes);
        const write = await writer.fetch(new Request(new URL(`/api/w/${encodeURIComponent(current.slug)}`, c.req.url), {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: final.text,
                expected_version: current.version, summary: `[Git ${update.newOid.slice(0, 12)}] ${commit.message.trim().slice(0, 180)}${commits.length > 1 ? ` (${commits.length} commits)` : ''}` }),
        }), c.env, c.executionCtx);
        const result = await write.json() as { version?: number; error?: string; pending?: boolean };
        if (!write.ok || result.pending) throw new Error(result.error || 'Edit was not applied; use the website approval workflow');
        const after = await page(c.env.DB, current.id);
        if (!after || after.deleted_at || (result.version && after.version !== result.version)) throw new Error('Wiki changed concurrently; fetch before retrying');
        await store.persist(objects);
        await recordHead(c.env.DB, current.id, lease, update.newOid, after.version, after.last_revision_id, user.id, commits);
        return transport(status(true), 'git-receive-pack');
    } catch (e) { return transport(status(false, (e as Error).message), 'git-receive-pack'); }
    finally { if (lease) await release(c.env.DB, current.id, lease); }
});
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
routes.get('/git', requireAuth, c => {
    const id = c.req.query('page');
    const url = id && /^[1-9][0-9]*$/.test(id) ? `${new URL(c.req.url).origin}/git/pages/${id}.git` : '';
    const texts = Object.fromEntries(['title', 'intro', 'token', 'generate', 'revoke', 'clone', 'commands', 'limits', 'back', 'tokenHint', 'updated', 'failed', 'confirm'].map(key => [key, ui(`git.${key}`)]));
    return c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(texts.title)}</title><link rel="stylesheet" href="/css/style.css"></head><body><main class="wiki-container" style="max-width:850px;margin:40px auto;padding:20px"><a href="/">${escape(texts.back)}</a><h1>${escape(texts.title)}</h1><p>${escape(texts.intro)}</p><p>${escape(texts.limits)}</p><h2>${escape(texts.token)}</h2><p>${escape(texts.tokenHint)}</p><button id="generate">${escape(texts.generate)}</button> <button id="revoke">${escape(texts.revoke)}</button><pre id="result" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre><h2>${escape(texts.clone)}</h2>${url ? `<pre style="overflow:auto">git clone ${escape(url)}\ncd ${id}\n# ${escape(texts.commands)}\ngit add page.md\ngit commit -m "Update page"\ngit pull --rebase\ngit push origin main</pre>` : `<p>${escape(texts.updated)}</p>`}</main><script>
const messages=${JSON.stringify(texts).replace(/</g, '\\u003c')};
const result=document.getElementById('result');
async function load(){const r=await fetch('/api/me/git-token');const data=await r.json();if(data.token)result.textContent=data.token.masked_token+' · '+new Date(data.token.expires_at*1000).toLocaleString();}
document.getElementById('generate').onclick=async()=>{if(!confirm(messages.confirm))return;const r=await fetch('/api/me/git-token',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const data=await r.json();result.textContent=r.ok?data.token:messages.failed;};
document.getElementById('revoke').onclick=async()=>{const r=await fetch('/api/me/git-token',{method:'DELETE'});result.textContent=r.ok?messages.updated:messages.failed;};load().catch(()=>{result.textContent=messages.failed});
</script></body></html>`);
});
export default routes;
