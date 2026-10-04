/**
 * 카테고리 ACL 편집 모달 — 카테고리 문서의 "문서 도구 > 권한 관리" 항목에서 호출된다.
 * 관리자 콘솔 카드의 목록/탐색은 admin.html 인라인 스크립트가 직접 처리한다.
 *
 * 호출 API (모두 관리자 전용 — adminRoutes.use(requireAdmin)):
 *   GET    /api/admin/category-acl/:name      — 단건 조회
 *   PUT    /api/admin/category-acl/:name      — ACL upsert (null/빈 flags → DELETE)
 *   GET    /api/admin/category-acl/:name/pages — 카테고리에 속한 페이지 목록
 *   POST   /api/admin/category-acl/:name/bulk-apply
 *
 * window.openCategoryAclModal(name) — 카테고리 ACL 편집 폼을 연다.
 */

import { ui } from '../../../packages/wiki-shared/src/i18n/client';
import '../utils/swal';

declare global {
    interface Window {
        openCategoryAclModal?: (name: string) => Promise<void>;
    }
}

type EditAclFlag = 'aged' | 'page_editor' | 'any_editor' | 'admin_only';
interface EditAcl { flags: EditAclFlag[]; }
type BulkMode = 'overwrite' | 'merge' | 'ignore';

interface PageItem {
    id: number;
    slug: string;
    edit_acl: EditAcl | null;
}

interface PageRowState {
    id: number;
    slug: string;
    edit_acl: EditAcl | null;
    currentlyChecked: boolean;
    checkbox: HTMLInputElement;
}

const ACL_FLAG_LABELS: Record<EditAclFlag, string> = {
    aged: ui("m_bf8508933cb57822"),
    page_editor: ui("m_6e8b991fd801742e"),
    any_editor: ui("m_33a7ab7ce21a4ef0"),
    admin_only: ui("m_593efa9a64e89c3f"),
};

const ACL_FLAG_ORDER: EditAclFlag[] = ['aged', 'page_editor', 'any_editor', 'admin_only'];

function escapeHtml(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function aclSummary(acl: EditAcl | null): string {
    if (!acl || acl.flags.length === 0) return ui("m_ffdbb50e2aa475ec");
    return acl.flags.map(f => ACL_FLAG_LABELS[f]).join(ui("m_96df792915787246"));
}

function readCheckedFlags(scope: HTMLElement, selector: string): EditAclFlag[] {
    const out: EditAclFlag[] = [];
    scope.querySelectorAll<HTMLInputElement>(selector).forEach(el => {
        if (el.checked && ACL_FLAG_ORDER.includes(el.value as EditAclFlag)) {
            out.push(el.value as EditAclFlag);
        }
    });
    return out;
}

// ── API ──────────────────────────────────────────────────────────────

async function apiFetchPages(name: string): Promise<PageItem[]> {
    const res = await fetch(`/api/admin/category-acl/${encodeURIComponent(name)}/pages`);
    if (!res.ok) throw new Error(ui("m_08c4c1c28368326a", [res.status]));
    const data = (await res.json()) as { items?: PageItem[] };
    return data.items || [];
}

async function apiBulkApply(name: string, payload: {
    mode: BulkMode;
    ids: number[];
    persistTemplate: boolean;
    templateAcl: EditAcl | null;
}): Promise<{ scanned: number; requested: number; changed: number; templateSaved: boolean }> {
    const res = await fetch(`/api/admin/category-acl/${encodeURIComponent(name)}/bulk-apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || ui("m_32bc3a35ff2af116", [res.status]));
    }
    return (await res.json()) as { scanned: number; requested: number; changed: number; templateSaved: boolean };
}

// ── HTML 빌더 ─────────────────────────────────────────────────────────

function aclFieldsetHtml(idPrefix: string, initialAcl: EditAcl | null): string {
    const flagSet = new Set(initialAcl?.flags ?? []);
    return ui("m_9dd06df2c1659f2a", [ACL_FLAG_ORDER.map(f => `
                    <label class="form-check-inline mb-0"><input class="form-check-input ${idPrefix}-flag" type="checkbox" value="${f}"${flagSet.has(f) ? ' checked' : ''}> <span class="ms-1">${ACL_FLAG_LABELS[f]}</span></label>
                `).join('')]);
}

function aclBadge(acl: EditAcl | null): string {
    if (!acl) return '<span class="bulkcat-cat-chip" style="opacity: .4;">—</span>';
    return `<span class="bulkcat-cat-chip" title="${escapeHtml(JSON.stringify(acl))}"><i class="mdi mdi-shield-account"></i> ${escapeHtml(aclSummary(acl))}</span>`;
}

function pageListHtml(pages: PageItem[]): string {
    if (pages.length === 0) {
        return window.uiEmptyState({
            icon: 'bi bi-folder',
            title: ui("m_3b72b1d7d0bf92b2"),
            text: ui("m_39df27dd6a8e691f"),
            compact: true,
        });
    }
    const rows = pages.map(p => `
        <tr data-page-id="${p.id}">
            <td>
                <label class="bulkcat-row-label">
                    <input type="checkbox" class="form-check-input cat-page-check" data-page-id="${p.id}" checked>
                    <code class="bulkcat-slug">${escapeHtml(p.slug)}</code>
                </label>
            </td>
            <td class="bulkcat-row-cats-cell">${aclBadge(p.edit_acl)}</td>
        </tr>
    `).join('');
    const warning = pages.length > 500
        ? ui("m_6fb4a203b25cd6ed", [pages.length])
        : '';
    return ui("m_3eb9ef27079c224d", [warning, pages.length, pages.length, rows]);
}

function buildEditorHtml(name: string, initialAcl: EditAcl | null, pageCount: number): string {
    return ui("m_07c4e39e57b57e3a", [escapeHtml(name), pageCount, aclFieldsetHtml('catAcl', initialAcl), window.uiInlineLoading({ block: true })]);
}

// ── 인터랙션 ─────────────────────────────────────────────────────────

async function showCategoryEditor(name: string): Promise<void> {
    if (!window.Swal) return;
    const res = await fetch(`/api/admin/category-acl/${encodeURIComponent(name)}`);
    if (!res.ok) {
        await window.Swal.fire({ icon: 'error', title: ui("m_61b67c1d6c0398be"), text: `(${res.status})` });
        return;
    }
    const data = (await res.json()) as { name: string; edit_acl: EditAcl | null; exists: boolean; page_count: number };

    const result = await window.Swal.fire({
        title: ui("m_bed1b7ec8d28399c"),
        html: buildEditorHtml(name, data.edit_acl, data.page_count),
        width: 720,
        showConfirmButton: false,
        showCloseButton: true,
        didOpen: async (modal: HTMLElement) => {
            const pagesPanel = modal.querySelector('#catAclPagesPanel') as HTMLElement;
            const pagesCounter = modal.querySelector('#catAclPagesCounter') as HTMLElement;

            const rowStates: PageRowState[] = [];
            try {
                const pages = await apiFetchPages(name);
                pagesPanel.innerHTML = pageListHtml(pages);
                pagesCounter.textContent = ui("m_11111f0787d39696", [pages.length]);

                const master = pagesPanel.querySelector<HTMLInputElement>('#catAclMaster');
                const selectedCounter = pagesPanel.querySelector<HTMLElement>('#catAclSelectedCount');

                const updateMaster = () => {
                    if (!master) return;
                    if (rowStates.length === 0) {
                        master.checked = false;
                        master.indeterminate = false;
                        master.disabled = true;
                        return;
                    }
                    master.disabled = false;
                    const checked = rowStates.filter(r => r.currentlyChecked).length;
                    if (checked === 0) { master.checked = false; master.indeterminate = false; }
                    else if (checked === rowStates.length) { master.checked = true; master.indeterminate = false; }
                    else { master.checked = false; master.indeterminate = true; }
                };
                const updateCounter = () => {
                    const checked = rowStates.filter(r => r.currentlyChecked).length;
                    if (selectedCounter) selectedCounter.textContent = `${checked} / ${rowStates.length}`;
                    updateMaster();
                };

                for (const p of pages) {
                    const cb = pagesPanel.querySelector<HTMLInputElement>(`input.cat-page-check[data-page-id="${p.id}"]`);
                    if (!cb) continue;
                    const row: PageRowState = {
                        id: p.id,
                        slug: p.slug,
                        edit_acl: p.edit_acl,
                        currentlyChecked: cb.checked,
                        checkbox: cb,
                    };
                    cb.addEventListener('change', () => {
                        row.currentlyChecked = cb.checked;
                        const tr = cb.closest<HTMLTableRowElement>('tr[data-page-id]');
                        tr?.classList.add('bulkcat-row-touched');
                        updateCounter();
                    });
                    rowStates.push(row);
                }

                master?.addEventListener('change', () => {
                    const next = master.checked;
                    for (const row of rowStates) {
                        row.currentlyChecked = next;
                        row.checkbox.checked = next;
                        const tr = row.checkbox.closest<HTMLTableRowElement>('tr[data-page-id]');
                        tr?.classList.add('bulkcat-row-touched');
                    }
                    updateCounter();
                });

                updateCounter();
            } catch (e) {
                pagesPanel.innerHTML = `<div class="bulkcat-warning">${escapeHtml(String(e))}</div>`;
            }

            modal.querySelector('#catAclSaveTemplateBtn')?.addEventListener('click', async () => {
                const flags = readCheckedFlags(modal, '.catAcl-flag');
                const acl: EditAcl | null = flags.length > 0 ? { flags } : null;
                try {
                    const saveRes = await fetch(`/api/admin/category-acl/${encodeURIComponent(name)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ edit_acl: acl }),
                    });
                    if (!saveRes.ok) {
                        const err = (await saveRes.json().catch(() => ({}))) as { error?: string };
                        throw new Error(err.error || ui("m_7e6dcbfd369a97fc", [saveRes.status]));
                    }
                    await window.Swal!.fire({ icon: 'success', title: ui("m_bbf060308e9397a4"), toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
                    window.Swal!.close();
                } catch (e: any) {
                    await window.Swal!.fire({ icon: 'error', title: ui("m_ae94ec51b2c23b4f"), text: e?.message || String(e) });
                }
            });

            modal.querySelector('#catAclBulkApplyBtn')?.addEventListener('click', async () => {
                const flags = readCheckedFlags(modal, '.catAcl-flag');
                const templateAcl: EditAcl | null = flags.length > 0 ? { flags } : null;
                const modeEl = modal.querySelector<HTMLInputElement>('input[name="catAclBulkMode"]:checked');
                const mode = (modeEl?.value as BulkMode) || 'merge';
                const ids: number[] = [];
                modal.querySelectorAll<HTMLInputElement>('.cat-page-check:checked').forEach(el => {
                    const id = Number(el.dataset.pageId);
                    if (Number.isFinite(id) && id > 0) ids.push(id);
                });

                if (mode !== 'ignore' && ids.length === 0) {
                    await window.Swal!.fire({ icon: 'warning', title: ui("m_f3a8c0c950d108e9"), text: ui("m_112e62b837e922bc") });
                    return;
                }

                const confirm = await window.Swal!.fire({
                    icon: 'question',
                    title: ui("m_f58e16c31a678661"),
                    html: ui("m_cf5e45edcbdef181", [mode, escapeHtml(aclSummary(templateAcl)), mode === 'ignore' ? 0 : ids.length]),
                    showCancelButton: true,
                    confirmButtonText: ui("m_6a1c963d5bc5e2e5"),
                    cancelButtonText: ui("m_be876433993ab7ba"),
                });
                if (!confirm.isConfirmed) return;

                try {
                    const result = await apiBulkApply(name, {
                        mode,
                        ids,
                        persistTemplate: false,
                        templateAcl,
                    });
                    await window.Swal!.fire({
                        icon: 'success',
                        title: ui("m_727333ab0740d7d8"),
                        html: ui("m_5b184d53be313f58", [result.scanned, result.changed, result.requested]),
                    });
                    window.Swal!.close();
                } catch (e: any) {
                    await window.Swal!.fire({ icon: 'error', title: ui("m_2743911f83e1da69"), text: e?.message || String(e) });
                }
            });
        },
    });

    void result;
}

window.openCategoryAclModal = async (name: string) => {
    await showCategoryEditor(name);
};
