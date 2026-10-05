import type { Env, User } from '../types';
import { isSuperAdmin } from './auth';
import { sha256Hex } from './oauth';

// Keep the original table so existing Git credentials remain valid and revocable.
const ready = new WeakMap<D1Database, Promise<void>>();
export function ensurePersonalTokens(db: D1Database) {
    let pending = ready.get(db);
    if (!pending) {
        pending = db.prepare('CREATE TABLE IF NOT EXISTS git_tokens (user_id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, masked_token TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)').run().then(() => {});
        ready.set(db, pending); pending.catch(() => ready.delete(db));
    }
    return pending;
}
export const isPersonalToken = (token: string) => /^(wiki|git)_[a-f0-9]{64}$/.test(token);
export async function authenticatePersonalToken(env: Env['Bindings'], token: string): Promise<User | null> {
    if (!isPersonalToken(token)) return null;
    await ensurePersonalTokens(env.DB);
    const now = Math.floor(Date.now() / 1000);
    const user = await env.DB.prepare(`SELECT u.* FROM users u JOIN git_tokens t ON t.user_id=u.id WHERE t.token_hash=? AND (t.expires_at=0 OR t.expires_at>?)`).bind(await sha256Hex(token),now).first<User>();
    if (!user || user.role==='deleted' || (user.banned_until && user.banned_until>now) || (user.role==='banned' && !user.banned_until)) return null;
    if (isSuperAdmin(user.email,env)) user.role='super_admin';
    else if (user.role==='banned') user.role='user';
    return user;
}
/** Unix seconds; null/0 explicitly means no expiry, omission retains the 30-day default. */
export function personalTokenExpiry(value: unknown, now = Math.floor(Date.now()/1000)): number {
    if (value===undefined) return now+30*86400;
    if (value===null || value===0) return 0;
    if (typeof value!=='number' || !Number.isSafeInteger(value) || value<=now || value>253402300799) throw new Error('Invalid expiration');
    return value;
}
