import type { Env } from '../types';
import { ObjectStore } from './objectStore';
import { getRevisionContent } from '../utils/r2';
const migrations = new WeakMap<D1Database, Promise<void>>();
export function ensureGit(db: D1Database) {
    let pending = migrations.get(db);
    if (!pending) {
        pending = db.batch([
            db.prepare('CREATE TABLE IF NOT EXISTS git_tokens (user_id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, masked_token TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)'),
            db.prepare("CREATE TABLE IF NOT EXISTS git_page_heads (page_id INTEGER PRIMARY KEY, head TEXT, version INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0)"),
            db.prepare('CREATE TABLE IF NOT EXISTS git_commit_links (page_id INTEGER NOT NULL, oid TEXT NOT NULL, revision_id INTEGER, user_id INTEGER, PRIMARY KEY(page_id, oid))'),
        ]).then(() => {});
        migrations.set(db, pending); pending.catch(() => migrations.delete(db));
    }
    return pending;
}
export type GitPage = { id: number; slug: string; version: number; content: string; is_private: number; deleted_at: number | null; last_revision_id: number | null };
export async function page(db: D1Database, id: number) {
    return db.prepare('SELECT id, slug, version, content, is_private, deleted_at, last_revision_id FROM pages WHERE id = ?').bind(id).first<GitPage>();
}
export async function acquire(db: D1Database, id: number) {
    await ensureGit(db);
    await db.prepare('INSERT OR IGNORE INTO git_page_heads (page_id) VALUES (?)').bind(id).run();
    const lease = crypto.randomUUID();
    const result = await db.prepare('UPDATE git_page_heads SET lease = ?, lease_until = unixepoch() + 120 WHERE page_id = ? AND lease_until < unixepoch()').bind(lease, id).run();
    if (!result.meta.changes) throw new Error('Repository is busy; retry shortly');
    return lease;
}
export async function release(db: D1Database, id: number, lease: string) {
    await db.prepare('UPDATE git_page_heads SET lease = NULL, lease_until = 0 WHERE page_id = ? AND lease = ?').bind(id, lease).run();
}
export async function recordHead(db: D1Database, id: number, lease: string, oid: string, version: number, revision: number | null, user: number | null, commits = [oid]) {
    const updated = await db.batch([
        ...commits.map(commit => db.prepare('INSERT OR IGNORE INTO git_commit_links (page_id, oid, revision_id, user_id) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM git_page_heads WHERE page_id = ? AND lease = ? AND lease_until >= unixepoch())').bind(id, commit, revision, user, id, lease)),
        db.prepare('UPDATE git_page_heads SET head = ?, version = ?, lease_until = unixepoch() + 120 WHERE page_id = ? AND lease = ? AND lease_until >= unixepoch()').bind(oid, version, id, lease),
    ]);
    if (!updated.at(-1)!.meta.changes) throw new Error('Repository lease expired; fetch before retrying');
}
/** Web changes are appended, never replace the existing Git head. Initial import is bounded. */
export async function synchronize(env: Env['Bindings'], store: ObjectStore, current: GitPage, lease: string, origin: string) {
    const db = env.DB;
    let saved = await db.prepare('SELECT head, version FROM git_page_heads WHERE page_id = ?').bind(current.id).first<{ head: string | null; version: number }>();
    if (!saved) throw new Error('Repository not initialized');
    if (saved.version === current.version && saved.head) return saved.head;
    const revisions = await db.prepare(`SELECT r.id, r.page_version, r.content, r.r2_key, r.summary, r.created_at, u.name
        FROM revisions r LEFT JOIN users u ON u.id = r.author_id
        WHERE r.page_id = ? AND r.page_version > ? AND r.page_version <= ? AND r.is_virtual = 0 AND r.deleted_at IS NULL AND r.purged_at IS NULL
        ORDER BY r.page_version DESC LIMIT 20`).bind(current.id, saved.version, current.version)
        .all<{ id: number; page_version: number; content: string; r2_key: string | null; summary: string | null; created_at: number; name: string | null }>();
    let head = saved.head;
    for (const rev of revisions.results.reverse()) {
        const content = await getRevisionContent(env.MEDIA, rev, origin);
        const oid = await store.snapshot(content, head, rev.name || 'Wiki editor', rev.created_at, rev.summary || `Wiki revision #${rev.id}`);
        await store.persist((await store.content(oid)).objects);
        await recordHead(db, current.id, lease, oid, rev.page_version, rev.id, null);
        head = oid; saved.version = rev.page_version;
    }
    if (saved.version !== current.version || !head) {
        // Legacy pages may not have a revision row. Do not read a hidden/purged revision as fallback.
        if (current.last_revision_id) {
            const rev = await db.prepare('SELECT deleted_at, purged_at FROM revisions WHERE id = ?').bind(current.last_revision_id).first<{ deleted_at: number | null; purged_at: number | null }>();
            if (!rev || rev.deleted_at || rev.purged_at) throw new Error('Current revision is unavailable');
        }
        const oid = await store.snapshot(current.content, head, 'Wiki editor', Math.floor(Date.now() / 1000), `Wiki version ${current.version}`);
        await store.persist((await store.content(oid)).objects);
        await recordHead(db, current.id, lease, oid, current.version, current.last_revision_id, null);
        head = oid;
    }
    return head!;
}
