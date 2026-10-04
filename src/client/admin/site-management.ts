import { ui } from '../../../packages/wiki-shared/src/i18n/client';
import { editablePermission } from '../../shared/permissionCatalog';
import { DEFAULT_SITE_POLICIES } from '../../shared/sitePolicies';

type Matrix = { roles: string[]; keys: string[]; groups: Record<string, string[]>; defaults: Record<string, string[]>; version: number };
export function mountSiteManagement(showTab: (id: string) => void): void {
    const user = (window as any).currentUser;
    if (user?.role !== 'super_admin') return;
    const nav = document.querySelector('.admin-sidebar-nav'), body = document.querySelector('.wiki-container');
    if (!nav || !body) return;
    function addTab(id: string, label: string): HTMLElement {
        const button = document.createElement('a');
        button.href = '#'; button.className = 'admin-nav-item'; button.textContent = label;
        button.setAttribute('onclick', `showTab('${id}'); return false;`);
        nav!.append(button);
        const pane = document.createElement('section'); pane.id = id; pane.className = 'tab-pane'; body!.append(pane);
        return pane;
    }
    const pane = addTab('tab-permission-groups', ui('permissions.title'));
    const heading = document.createElement('h3'); heading.textContent = ui('permissions.title'); pane.append(heading);
    const help = document.createElement('p'); help.textContent = ui('permissions.help'); pane.append(help);
    const status = document.createElement('p'); status.setAttribute('role', 'status'); pane.append(status);
    const table = document.createElement('div'); table.className = 'table-responsive'; pane.append(table);
    const save = document.createElement('button'); save.type = 'button'; save.className = 'btn btn-wiki me-2'; save.textContent = ui('permissions.save'); save.disabled = true;
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'btn btn-wiki-outline'; reset.textContent = ui('permissions.defaults'); reset.disabled = true;
    pane.append(save, reset);
    let matrix: Matrix;
    function render(groups: Record<string, string[]>): void {
        table.replaceChildren(); const grid = document.createElement('table'); grid.className = 'table align-middle';
        const head = document.createElement('thead'), header = document.createElement('tr');
        for (const text of [ui('permissions.operation'), ...matrix.roles.map(r => ui('permissions.role.' + r))]) {
            const th = document.createElement('th'); th.textContent = text; header.append(th);
        }
        head.append(header); grid.append(head); const rows = document.createElement('tbody');
        for (const key of matrix.keys) {
            const row = document.createElement('tr'), title = document.createElement('th'); title.scope = 'row'; title.textContent = ui('permissions.key.' + key); row.append(title);
            for (const role of matrix.roles) {
                const cell = document.createElement('td'), input = document.createElement('input'); input.type = 'checkbox'; input.className = 'form-check-input';
                input.dataset.role = role; input.dataset.permission = key; input.checked = groups[role]?.includes(key) ?? false;
                input.disabled = !editablePermission(role, key); input.setAttribute('aria-label', `${ui('permissions.role.' + role)}: ${ui('permissions.key.' + key)}`);
                cell.append(input); row.append(cell);
            }
            rows.append(row);
        }
        grid.append(rows); table.append(grid);
    }
    async function load() {
        status.textContent = ui('permissions.loading');
        try {
            const res = await fetch('/api/admin/permission-groups'); if (!res.ok) throw new Error(ui('permissions.loadFailed'));
            matrix = await res.json(); render(matrix.groups); save.disabled = reset.disabled = false; status.textContent = '';
        } catch (e) { status.textContent = String((e as Error).message); }
    }
    save.addEventListener('click', async () => {
        save.disabled = reset.disabled = true;
        const groups: Record<string, string[]> = Object.fromEntries(matrix.roles.map(r => [r, []]));
        table.querySelectorAll<HTMLInputElement>('input:checked:not(:disabled)').forEach(input => groups[input.dataset.role!]!.push(input.dataset.permission!));
        try {
            const res = await fetch('/api/admin/permission-groups', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groups, version: matrix.version }) });
            const result = await res.json(); if (!res.ok) throw new Error(result.error);
            matrix.version = result.version; status.textContent = ui('permissions.saved');
        } catch (e) { status.textContent = (e as Error).message; }
        finally { save.disabled = reset.disabled = false; }
    });
    reset.addEventListener('click', () => { render(matrix.defaults); status.textContent = ui('permissions.unsaved'); });
    void load();

    const legal = addTab('tab-site-policies', ui('policies.title'));
    const legalHeading = document.createElement('h3'); legalHeading.textContent = ui('policies.title'); legal.append(legalHeading);
    const legalHelp = document.createElement('p'); legalHelp.textContent = ui('policies.help'); legal.append(legalHelp);
    for (const kind of ['terms', 'privacy'] as const) {
        const config = (window as any).appConfig;
        const slug = (kind === 'terms' ? config.termsOfServiceSlug : config.privacyPolicySlug) || DEFAULT_SITE_POLICIES[kind].slug;
        const section = document.createElement('div'); section.className = 'card p-3 mb-4';
        const label = document.createElement('h4'); label.textContent = ui('policies.' + kind); section.append(label);
        const textarea = document.createElement('textarea'); textarea.className = 'form-control mb-3'; textarea.rows = 18; textarea.setAttribute('aria-label', label.textContent); section.append(textarea);
        const actions = document.createElement('div'); section.append(actions);
        const publish = document.createElement('button'); publish.type = 'button'; publish.className = 'btn btn-wiki me-2'; publish.textContent = ui('policies.publish'); publish.disabled = true;
        const template = document.createElement('button'); template.type = 'button'; template.className = 'btn btn-wiki-outline me-2'; template.textContent = ui('policies.template');
        const view = document.createElement('a'); view.className = 'btn btn-wiki-outline'; view.href = '/w/' + encodeURIComponent(slug); view.target = '_blank'; view.rel = 'noopener'; view.textContent = ui('policies.view');
        const message = document.createElement('p'); message.className = 'mt-2'; message.setAttribute('role', 'status'); section.append(message); actions.append(publish, template, view); legal.append(section);
        let version: number | null = null;
        const defaultText = DEFAULT_SITE_POLICIES[kind].content.replaceAll('{{SITE_NAME}}', config.wikiName || 'Nodeloc Wiki');
        async function reload() {
            try {
                const res = await fetch('/api/w/' + encodeURIComponent(slug) + '?for_edit=true&nocache=1');
                if (res.status === 404) textarea.value = defaultText;
                else { const page = await res.json(); if (!res.ok) throw new Error(page.error || ui('permissions.loadFailed')); textarea.value = page.content || ''; version = page.version; }
                publish.disabled = false;
            } catch (e) { message.textContent = (e as Error).message; }
        }
        template.addEventListener('click', () => {
            if (!textarea.value || window.confirm(ui('policies.confirmTemplate'))) { textarea.value = defaultText; message.textContent = ui('permissions.unsaved'); }
        });
        publish.addEventListener('click', async () => {
            if (!textarea.value.trim()) { message.textContent = ui('policies.empty'); return; }
            publish.disabled = true;
            try {
                const body: Record<string, unknown> = { content: textarea.value, summary: ui('policies.updateSummary'), edit_acl: { flags: ['admin_only'], mode: 'all' } };
                if (version !== null) body.expected_version = version;
                const res = await fetch('/api/w/' + encodeURIComponent(slug), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                const data = await res.json(); if (!res.ok) throw new Error(data.error || ui('permissions.saveFailed'));
                await reload(); message.textContent = ui('policies.saved');
            } catch (e) { message.textContent = (e as Error).message; }
            finally { publish.disabled = false; }
        });
        void reload();
    }
}
