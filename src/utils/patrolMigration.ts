/** Existing installations may predate the revision patrol table. */
const ready = new WeakMap<D1Database, Promise<void>>();

export function ensurePatrolTable(db: D1Database): Promise<void> {
    const existing = ready.get(db);
    if (existing) return existing;
    const pending = db.prepare(`CREATE TABLE IF NOT EXISTS revision_patrols (
        revision_id INTEGER PRIMARY KEY,
        patroller_id INTEGER NOT NULL,
        patrolled_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY (revision_id) REFERENCES revisions(id) ON DELETE CASCADE,
        FOREIGN KEY (patroller_id) REFERENCES users(id)
    )`).run().then(() => {});
    ready.set(db, pending);
    pending.catch(() => ready.delete(db));
    return pending;
}
