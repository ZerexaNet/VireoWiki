import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { RBAC } from '../src/utils/role';
import { validateOverrides, loadPermissionGroups, PERMISSION_KEYS } from '../src/utils/permissionGroups';
import groupRoutes from '../src/routes/permissionGroups';
import { applyDraftMutation } from '../src/utils/mcpDraftApply';
import { applyExistingPageUpdate, applyNewPageInsert } from '../src/routes/admin-mcp';

function database() {
    const sql = new DatabaseSync(':memory:');
    sql.exec('CREATE TABLE admin_log (type TEXT, log TEXT, user INTEGER)');
    const db = { prepare(query: string) {
        let params: any[] = [];
        const bound = { bind(...values: any[]) { params = values; return bound; },
            async first() { return sql.prepare(query).get(...params) ?? null; },
            async run() { return { meta: { changes: Number(sql.prepare(query).run(...params).changes) } }; } };
        return bound;
    } } as unknown as D1Database;
    return { db, sql };
}

test('defaults preserve existing grants and split independent operations', () => {
    const rbac = new RBAC();
    for (const key of ['wiki:create', 'wiki:edit', 'wiki:revert', 'comment:create', 'ticket:create', 'media:upload']) assert.ok(rbac.can('user', key), key);
    for (const key of ['wiki:delete', 'wiki:restore', 'wiki:move', 'revision:delete', 'media:delete']) assert.equal(rbac.can('user', key), false, key);
    for (const key of PERMISSION_KEYS) assert.ok(rbac.can('super_admin', key), key);
    assert.equal(rbac.can('discussion_manager', 'discussion:manage'), true);
    assert.equal(rbac.can('banned', 'wiki:edit'), false);
});

test('revocations are independent across groups and cannot remove owner access', () => {
    const rbac = new RBAC({ user: ['wiki:delete'], admin: ['wiki:restore'] });
    assert.equal(rbac.can('user', 'wiki:edit'), false);
    assert.equal(rbac.can('user', 'wiki:delete'), true);
    assert.equal(rbac.can('discussion_manager', 'wiki:edit'), true);
    assert.equal(rbac.can('admin', 'wiki:delete'), false);
    assert.equal(rbac.can('admin', 'wiki:restore'), true);
    assert.equal(rbac.can('admin', 'admin:access'), true);
    assert.equal(rbac.can('super_admin', '*'), true);
    assert.equal(rbac.can('guest', 'wiki:delete'), false);
});

test('wildcards, protected roles, dashboard grants and unknown permissions are rejected', () => {
    for (const value of [{ user: ['*'] }, { super_admin: [] }, { guest: ['wiki:edit'] }, { user: ['admin:access'] }, { user: ['user:manage'] }, { admin: ['made:up'] }]) {
        assert.throws(() => validateOverrides(value));
    }
});

test('policy reads use the latest persisted version without a stale permission cache', async () => {
    const { db } = database();
    assert.ok((await RBAC.load(db)).can('user', 'wiki:edit'));
    await db.prepare('UPDATE permission_groups SET permissions = ?, version = 1 WHERE id = 1').bind(JSON.stringify({ user: [] })).run();
    assert.equal((await RBAC.load(db)).can('user', 'wiki:edit'), false);
    assert.equal((await loadPermissionGroups(db)).version, 1);
    await db.prepare('UPDATE permission_groups SET permissions = ? WHERE id = 1').bind('{bad').run();
    await assert.rejects(() => RBAC.load(db));
});

test('only the owner can save groups; stale versions and malformed grants cannot write', async () => {
    const { db } = database();
    const app = new Hono<any>();
    app.use('*', async (c, next) => { c.set('user', { id: 1, role: c.req.header('X-Test-Role') || 'user' }); await next(); });
    app.route('/groups', groupRoutes);
    const request = (role: string, data: unknown) => app.request('/groups', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Test-Role': role }, body: JSON.stringify(data) }, { DB: db });
    assert.equal((await request('admin', { groups: { user: [] }, version: 0 })).status, 403);
    const current = await app.request('/groups', { headers: { 'X-Test-Role': 'super_admin' } }, { DB: db });
    assert.equal(current.status, 200);
    assert.equal((await request('super_admin', { groups: { user: ['*'] }, version: 0 })).status, 400);
    assert.equal((await request('super_admin', { groups: { user: [] }, version: 0 })).status, 200);
    assert.equal((await request('super_admin', { groups: { user: ['wiki:edit'] }, version: 0 })).status, 409);
    assert.equal((await RBAC.load(db)).can('user', 'wiki:edit'), false);
});

test('MCP and approval mutation primitives deny writes before touching storage', async () => {
    const rbac = new RBAC({ user: [] });
    const user = { id: 1, role: 'user' } as any;
    const c = { get: () => rbac, env: { DB: { prepare() { throw new Error('storage must not be touched'); } } } } as any;
    const create = await applyDraftMutation(c, user, rbac, { slug: 'new', action: 'create' } as any, null);
    const edit = await applyDraftMutation(c, user, rbac, { slug: 'old', action: 'update' } as any, null);
    assert.equal(create.status, 403); assert.equal(edit.status, 403);
    await assert.rejects(() => applyNewPageInsert(c, user, 'new', 'text', {} as any), (e: any) => e.status === 403);
    await assert.rejects(() => applyExistingPageUpdate(c, user, {} as any, 'text', {} as any), (e: any) => e.status === 403);
});
