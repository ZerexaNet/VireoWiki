import { Hono } from 'hono';
import type { Env } from '../types';
import { RBAC } from '../utils/role';
import { EDITABLE_ROLES, PERMISSION_KEYS, editablePermission, loadPermissionGroups, validateOverrides } from '../utils/permissionGroups';
import { ui } from '../i18n/server';
const routes = new Hono<Env>();
routes.use('*', async (c, next) => {
    if (!c.get('user') || c.get('user')!.role !== 'super_admin') return c.json({ error: ui('permissions.ownerOnly') }, 403);
    await next();
});
routes.get('/', async c => {
    const saved = await loadPermissionGroups(c.env.DB);
    const current = new RBAC(saved.overrides), defaults = new RBAC();
    const matrix = (rbac: RBAC) => Object.fromEntries(EDITABLE_ROLES.map(role => [role,
        PERMISSION_KEYS.filter(key => editablePermission(role, key) && rbac.can(role, key))]));
    return c.json({ roles: EDITABLE_ROLES, keys: PERMISSION_KEYS, groups: matrix(current), defaults: matrix(defaults),
        version: saved.version }, 200, { 'Cache-Control': 'no-store' });
});
routes.put('/', async c => {
    let data: { groups: unknown; version: number };
    try { data = await c.req.json(); } catch { return c.json({ error: ui('permissions.invalid') }, 400); }
    if (!data || !Number.isSafeInteger(data.version) || data.version < 0) return c.json({ error: ui('permissions.invalid') }, 400);
    let groups;
    try { groups = validateOverrides(data.groups); } catch { return c.json({ error: ui('permissions.invalid') }, 400); }
    await loadPermissionGroups(c.env.DB);
    const result = await c.env.DB.prepare('UPDATE permission_groups SET permissions = ?, version = version + 1, updated_by = ?, updated_at = unixepoch() WHERE id = 1 AND version = ?')
        .bind(JSON.stringify(groups), c.get('user')!.id, data.version).run();
    if (!result.meta.changes) return c.json({ error: ui('permissions.conflict') }, 409);
    await c.env.DB.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
        .bind('permission_groups', JSON.stringify(groups), c.get('user')!.id).run();
    return c.json({ success: true, version: data.version + 1 });
});
export default routes;
