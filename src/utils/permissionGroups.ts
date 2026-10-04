import type { RolePermissions } from '../types';

import { EDITABLE_ROLES, PERMISSION_KEYS, editablePermission, type RoleOverrides } from '../shared/permissionCatalog';
export { EDITABLE_ROLES, PERMISSION_KEYS, editablePermission, type RoleOverrides } from '../shared/permissionCatalog';
export function validateOverrides(input: unknown): RoleOverrides {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid permission groups');
    const result: RoleOverrides = {};
    for (const [role, permissions] of Object.entries(input)) {
        if (!(EDITABLE_ROLES as readonly string[]).includes(role) || !Array.isArray(permissions) ||
            permissions.some(p => typeof p !== 'string' || !editablePermission(role, p))) throw new Error('invalid permission groups');
        result[role as keyof RoleOverrides] = [...new Set(permissions)];
    }
    return result;
}
export function applyOverrides(defaults: RolePermissions, overrides: RoleOverrides): RolePermissions {
    const collect = (role: string, seen = new Set<string>()): string[] => {
        if (seen.has(role)) return [];
        seen.add(role);
        const entry = defaults.roles[role];
        if (!entry) return [];
        return [...new Set([...(entry.permissions ?? []), ...(entry.inherits ?? []).flatMap(parent => collect(parent, seen))])];
    };
    const roles = Object.fromEntries(Object.keys(defaults.roles).map(role => [role, { permissions: collect(role), inherits: [] }]));
    for (const role of EDITABLE_ROLES) {
        if (!Object.hasOwn(overrides, role)) continue;
        // Dashboard access and public reading stay tied to the built-in role.
        const fixed = role === 'admin' ? ['wiki:read', 'admin:access'] : ['wiki:read'];
        roles[role] = { permissions: [...fixed, ...overrides[role]!], inherits: [] };
    }
    return { roles };
}
const initialized = new WeakMap<object, Promise<void>>();
export async function ensurePermissionGroups(db: D1Database): Promise<void> {
    let pending = initialized.get(db);
    if (!pending) {
        pending = db.prepare(`CREATE TABLE IF NOT EXISTS permission_groups (
            id INTEGER PRIMARY KEY CHECK (id = 1), permissions TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 0, updated_by INTEGER, updated_at INTEGER
        )`).run().then(async () => {
            await db.prepare("INSERT OR IGNORE INTO permission_groups (id, permissions, version) VALUES (1, '{}', 0)").run();
        });
        initialized.set(db, pending);
        pending.catch(() => initialized.delete(db));
    }
    await pending;
}
export async function loadPermissionGroups(db: D1Database) {
    await ensurePermissionGroups(db);
    const row = await db.prepare('SELECT permissions, version FROM permission_groups WHERE id = 1')
        .first<{ permissions: string; version: number }>();
    if (!row) throw new Error('permission groups unavailable');
    // Never silently widen permissions if stored data is invalid.
    return { overrides: validateOverrides(JSON.parse(row.permissions)), version: row.version };
}
