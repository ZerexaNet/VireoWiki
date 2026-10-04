export const EDITABLE_ROLES = ['user', 'discussion_manager', 'admin'] as const;
export const PERMISSION_KEYS = [
    'wiki:create', 'wiki:edit', 'wiki:delete', 'wiki:restore', 'wiki:move', 'wiki:revert', 'git:push',
    'revision:delete', 'wiki:private', 'media:upload', 'media:delete',
    'comment:create', 'discussion:manage', 'ticket:create', 'ticket:manage', 'user:manage', 'wiki:manage',
] as const;
export type RoleOverrides = Partial<Record<typeof EDITABLE_ROLES[number], string[]>>;
const adminOnly = new Set(['media:delete', 'user:manage', 'wiki:manage']);
export function editablePermission(role: string, key: string): boolean {
    return (PERMISSION_KEYS as readonly string[]).includes(key) && (role === 'admin' || !adminOnly.has(key));
}
