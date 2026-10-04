/**
 * 권한 관리 모달 — 문서 도구 드롭다운의 "권한 관리" 항목에서 호출.
 *
 * 한 모달에서 처리하는 것:
 *  1) 현재 문서 단건: 비공개 / 편집 ACL (admin_only 포함)
 *  2) 하위 문서 일괄 적용 (비공개 / 편집 ACL)
 *  3) 기존 자동 규칙 목록·삭제
 *
 * 호출 API (모두 관리자 전용 — adminRoutes.use(requireAdmin)):
 *  - GET    /api/admin/pages/:slug/edit-acl
 *  - PUT    /api/admin/pages/:slug/edit-acl
 *  - PATCH  /api/admin/pages/:slug/flags
 *  - GET    /api/admin/doc-setting-prefix-rules
 *  - DELETE /api/admin/doc-setting-prefix-rules/:id
 *  - GET    /api/admin/doc-setting-prefix-rules/subpages?prefix=<slug>
 *  - POST   /api/admin/doc-setting-prefix-rules/bulk-apply
 *
 * window.openPermissionsModal(slug) 으로만 노출 — 페이지 로드시 자동 실행되지 않는다.
 */

import { ui } from '../../../packages/wiki-shared/src/i18n/client';
import '../utils/swal';

import { normalizeSlug } from '../utils/slug';

declare global {
    interface Window {
        openPermissionsModal?: (slug: string) => Promise<void>;
    }
}

type FlagValue = 0 | 1 | null;
type FlagAction = 'none' | 'on' | 'off';
type AclAction = 'none' | 'clear' | 'set';
type CategoriesAction = 'none' | 'add' | 'set' | 'clear';
type EditAclFlag = 'aged' | 'page_editor' | 'any_editor' | 'admin_only';
interface EditAcl { flags: EditAclFlag[]; }

interface CurrentPage {
    id: number;
    slug: string;
    is_private: 0 | 1;
    edit_acl: EditAcl | null;
}

interface DocSettingRule {
    id: number;
    prefix: string;
    is_private: FlagValue;
    edit_acl: string | null;
    categories: string | null;
    created_at: number;
    created_by_name: string | null;
}

interface SubpageItem {
    id: number;
    slug: string;
    depth: number;
    is_private: 0 | 1;
    edit_acl: EditAcl | null;
    categories: string[];
}

interface RowState {
    id: number;
    slug: string;
    depth: number;
    is_private: 0 | 1;
    edit_acl: EditAcl | null;
    categories: string[];
    currentlyChecked: boolean;
    checkbox: HTMLInputElement;
}

interface ModalState {
    slug: string;
    prefix: string;
    rows: RowState[];
    page: CurrentPage | null;
    initialAcl: EditAcl | null;
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

function parseEditAclFromRaw(raw: string | null | undefined): EditAcl | null {
    if (!raw) return null;
    try {
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object' || !Array.isArray(obj.flags)) return null;
        const flags = obj.flags.filter((f: unknown): f is EditAclFlag =>
            f === 'aged' || f === 'page_editor' || f === 'any_editor' || f === 'admin_only'
        );
        if (flags.length === 0) return null;
        return { flags };
    } catch {
        return null;
    }
}

function aclSummary(acl: EditAcl | null): string {
    if (!acl || acl.flags.length === 0) return ui("m_ffdbb50e2aa475ec");
    return acl.flags.map(f => ACL_FLAG_LABELS[f]).join(ui("m_96df792915787246"));
}

function aclEqual(a: EditAcl | null, b: EditAcl | null): boolean {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    if (a.flags.length !== b.flags.length) return false;
    const setA = new Set(a.flags);
    for (const f of b.flags) if (!setA.has(f)) return false;
    return true;
}

// ── API 헬퍼 ─────────────────────────────────────────────────────────

async function fetchCurrentPage(slug: string): Promise<CurrentPage | { error: string }> {
    // GET /api/w/:slug 는 pages 컬럼을 flat 으로 반환 ({ id, slug, is_private, edit_acl, ... }).
    // edit_acl 은 raw JSON 문자열 — 호출 후 parseEditAclFromRaw 로 객체화한다.
    // 관리자 권한자만 모달을 열 수 있으므로 비공개 / 삭제 문서 조회도 통과한다.
    // redirect=no 필수: 리다이렉트 페이지에서 모달을 열 때 타겟 페이지 메타가 아닌
    // 호출 슬러그의 메타를 가져와야 한다 (저장은 원본 슬러그로 이루어지므로).
    const res = await fetch(`/api/w/${encodeURIComponent(slug)}?redirect=no&nocache=true`);
    if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { error: err.error || ui("m_15f4f9a5c6e140e5", [res.status]) };
    }
    const data = (await res.json()) as { id?: number; is_private?: number; edit_acl?: string | null };
    const id = Number(data.id);
    if (!Number.isFinite(id)) return { error: ui("m_3cb0ef453b7ddab2") };
    return {
        id,
        slug,
        is_private: (data.is_private ? 1 : 0) as 0 | 1,
        edit_acl: parseEditAclFromRaw(data.edit_acl ?? null),
    };
}

async function fetchAclForSlug(slug: string): Promise<EditAcl | null> {
    const res = await fetch(`/api/admin/pages/${encodeURIComponent(slug)}/edit-acl`);
    if (!res.ok) return null;
    const data = (await res.json()) as { edit_acl: EditAcl | null };
    return data.edit_acl ?? null;
}

async function patchPageFlags(slug: string, body: { is_private: 0 | 1 }): Promise<{ ok: true; data: { is_private: 0 | 1 } } | { ok: false; error: string }> {
    const res = await fetch(`/api/admin/pages/${encodeURIComponent(slug)}/flags`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_private: body.is_private }),
    });
    if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: err.error || ui("m_f887c5441fa72e31", [res.status]) };
    }
    const data = (await res.json()) as { is_private: 0 | 1 };
    return { ok: true, data: { is_private: data.is_private } };
}

async function putPageEditAcl(slug: string, acl: EditAcl | null): Promise<{ ok: true; acl: EditAcl | null } | { ok: false; error: string }> {
    const res = await fetch(`/api/admin/pages/${encodeURIComponent(slug)}/edit-acl`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edit_acl: acl }),
    });
    if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: err.error || ui("m_f887c5441fa72e31", [res.status]) };
    }
    const data = (await res.json()) as { edit_acl: EditAcl | null };
    return { ok: true, acl: data.edit_acl ?? null };
}

async function fetchRules(relatedTo: string): Promise<DocSettingRule[]> {
    const res = await fetch(`/api/admin/doc-setting-prefix-rules?relatedTo=${encodeURIComponent(relatedTo)}`);
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as DocSettingRule[]) : [];
}

async function deleteRule(id: number): Promise<boolean> {
    const res = await fetch(`/api/admin/doc-setting-prefix-rules/${id}`, { method: 'DELETE' });
    return res.ok;
}

async function fetchSubpages(prefix: string): Promise<{ items: SubpageItem[] } | { error: string }> {
    const res = await fetch(`/api/admin/doc-setting-prefix-rules/subpages?prefix=${encodeURIComponent(prefix)}`);
    if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { error: err.error || ui("m_f887c5441fa72e31", [res.status]) };
    }
    return (await res.json()) as { items: SubpageItem[] };
}

// ── HTML 빌더 ────────────────────────────────────────────────────────

function privateBadge(flag: 0 | 1): string {
    if (!flag) return '<span class="bulkcat-cat-chip" style="opacity: .4;">—</span>';
    return ui("m_04493f83d34189ef");
}

function aclBadge(acl: EditAcl | null): string {
    if (!acl) return '<span class="bulkcat-cat-chip" style="opacity: .4;">—</span>';
    return `<span class="bulkcat-cat-chip" title="${escapeHtml(JSON.stringify(acl))}"><i class="mdi mdi-shield-account"></i> ${acl.flags.length}</span>`;
}

function rulePrivateLabel(v: FlagValue): string {
    if (v === null || v === undefined) return '<span style="opacity: .4;">—</span>';
    if (v === 1) return ui("m_473159f674ff67ca");
    return ui("m_0a7103cfc0743130");
}

function ruleAclLabel(raw: string | null): string {
    const acl = parseEditAclFromRaw(raw);
    if (!acl) return '<span style="opacity: .4;">—</span>';
    return `<span title="${escapeHtml(JSON.stringify(acl))}"><i class="mdi mdi-shield-account"></i> ${escapeHtml(aclSummary(acl))}</span>`;
}

function parseCategoriesString(raw: string | null | undefined): string[] {
    if (!raw) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const piece of raw.split(',')) {
        const v = piece.trim();
        if (!v || seen.has(v)) continue;
        seen.add(v);
        out.push(v);
    }
    return out;
}

function categoriesChips(cats: string[]): string {
    if (cats.length === 0) return '<span class="bulkcat-cat-chip" style="opacity: .4;">—</span>';
    return cats.map(c => `<span class="bulkcat-cat-chip" title="${escapeHtml(c)}"><i class="mdi mdi-tag-outline"></i> ${escapeHtml(c)}</span>`).join(' ');
}

function ruleCategoriesLabel(raw: string | null): string {
    const cats = parseCategoriesString(raw);
    if (cats.length === 0) return '<span style="opacity: .4;">—</span>';
    return categoriesChips(cats);
}

function rulesTableHtml(rules: DocSettingRule[]): string {
    if (rules.length === 0) {
        return ui("m_217f3927ada2d495");
    }
    const rows = rules.map((r) => `
        <tr data-rule-id="${r.id}">
            <td><code>${escapeHtml(r.prefix)}/**</code></td>
            <td>${rulePrivateLabel(r.is_private)}</td>
            <td>${ruleAclLabel(r.edit_acl)}</td>
            <td>${ruleCategoriesLabel(r.categories)}</td>
            <td class="text-end">
                <button type="button" class="btn btn-sm btn-wiki btn-wiki-danger perm-rule-delete">
                    <i class="mdi mdi-trash-can-outline"></i>
                </button>
            </td>
        </tr>
    `).join('');
    return ui("m_8270da95811fe10f", [rows]);
}

function aclFieldsetHtml(idPrefix: string, initialAcl: EditAcl | null, initiallyVisible: boolean): string {
    const flagSet = new Set(initialAcl?.flags ?? []);
    return ui("m_41e7be2dde07e3b9", [idPrefix, initiallyVisible ? '' : 'display: none;', ACL_FLAG_ORDER.map(f => `
                    <label class="form-check-inline mb-0"><input class="form-check-input ${idPrefix}-flag" type="checkbox" value="${f}"${flagSet.has(f) ? ' checked' : ''}> <span class="ms-1">${ACL_FLAG_LABELS[f]}</span></label>
                `).join('')]);
}

function buildModalHtml(slug: string, page: CurrentPage | null, pageLoadError: string | null, rules: DocSettingRule[]): string {
    const currentSection = page
        ? ui("m_8edcb1517374d55f", [page.is_private ? ' checked' : '', page.edit_acl ? '' : ' checked', page.edit_acl ? ' checked' : '', aclFieldsetHtml('permCurAcl', page.edit_acl, !!page.edit_acl)])
        : `<div class="bulkcat-warning">${escapeHtml(pageLoadError || ui("m_c5ac0714fceb948d"))}</div>`;

    return ui("m_0c53e3964dd0d9de", [currentSection, escapeHtml(slug), window.uiInlineLoading({ block: true }), aclFieldsetHtml('permBulkAcl', null, false), rulesTableHtml(rules)]);
}

// ── 섹션 1: 현재 문서 단건 ─────────────────────────────────────────

function readCurAclAction(): AclAction {
    const el = document.querySelector<HTMLInputElement>('input[name="permCurAclAction"]:checked');
    const v = el?.value;
    return v === 'set' || v === 'clear' ? v : 'none';
}

function readAclValueFrom(idPrefix: string): EditAcl | null {
    const flags: EditAclFlag[] = [];
    document.querySelectorAll<HTMLInputElement>(`.${idPrefix}-flag`).forEach((el) => {
        if (!el.checked) return;
        const v = el.value;
        if (v === 'aged' || v === 'page_editor' || v === 'any_editor' || v === 'admin_only') {
            flags.push(v);
        }
    });
    if (flags.length === 0) return null;
    return { flags };
}

function toggleCurAclFieldset() {
    const fs = document.getElementById('permCurAclFieldset') as HTMLFieldSetElement | null;
    if (!fs) return;
    fs.style.display = readCurAclAction() === 'set' ? '' : 'none';
}

function setCurSaveStatus(text: string, kind: 'info' | 'ok' | 'err' = 'info') {
    const el = document.getElementById('permCurSaveStatus');
    if (!el) return;
    el.textContent = text;
    el.style.color = kind === 'err' ? 'var(--wiki-danger, #EF4444)'
        : kind === 'ok' ? 'var(--wiki-success, #10B981)'
            : 'var(--wiki-text-muted)';
}

async function saveCurrent(state: ModalState): Promise<void> {
    if (!state.page) return;
    const privEl = document.getElementById('permCurPrivate') as HTMLInputElement | null;
    if (!privEl) return;

    const nextPriv: 0 | 1 = privEl.checked ? 1 : 0;

    const aclAction = readCurAclAction();
    let nextAcl: EditAcl | null = state.page.edit_acl;
    if (aclAction === 'clear') nextAcl = null;
    else if (aclAction === 'set') {
        nextAcl = readAclValueFrom('permCurAcl');
        if (!nextAcl) {
            setCurSaveStatus(ui("m_e549e8950801ce52"), 'err');
            return;
        }
    }

    const privChanged = nextPriv !== state.page.is_private;
    const aclChanged = aclAction !== 'none' && !aclEqual(nextAcl, state.page.edit_acl);

    if (!privChanged && !aclChanged) {
        setCurSaveStatus(ui("m_93b58fbaf5e77126"), 'info');
        return;
    }

    setCurSaveStatus(ui("m_88daaeedfe4c69c6"), 'info');
    const tasks: Promise<{ ok: boolean; error?: string }>[] = [];
    if (privChanged) {
        tasks.push(patchPageFlags(state.slug, { is_private: nextPriv }).then(r => r.ok ? { ok: true } : { ok: false, error: r.error }));
    }
    if (aclChanged) {
        tasks.push(putPageEditAcl(state.slug, nextAcl).then(r => r.ok ? { ok: true } : { ok: false, error: r.error }));
    }

    const results = await Promise.all(tasks);
    const failed = results.find(r => !r.ok);
    if (failed) {
        setCurSaveStatus(ui("m_6c0f44e353829285", [failed.error]), 'err');
        return;
    }

    if (privChanged) state.page.is_private = nextPriv;
    if (aclAction !== 'none') state.page.edit_acl = nextAcl;
    setCurSaveStatus(ui("m_f700b8ce7c8002d7"), 'ok');

    // 토스트 — SweetAlert2
    const swal = window.Swal;
    swal?.fire({ icon: 'success', title: ui("m_f700b8ce7c8002d7"), toast: true, position: 'top-end', timer: 1800, showConfirmButton: false });
}

// ── 섹션 2: 하위 일괄 적용 ─────────────────────────────────────────

function readBulkPrivateAction(): FlagAction {
    const el = document.querySelector<HTMLInputElement>('input[name="permBulkPrivateAction"]:checked');
    const v = el?.value;
    return v === 'on' || v === 'off' ? v : 'none';
}
function readBulkAclAction(): AclAction {
    const el = document.querySelector<HTMLInputElement>('input[name="permBulkAclAction"]:checked');
    const v = el?.value;
    return v === 'set' || v === 'clear' ? v : 'none';
}
function toggleBulkAclFieldset() {
    const fs = document.getElementById('permBulkAclFieldset') as HTMLFieldSetElement | null;
    if (!fs) return;
    fs.style.display = readBulkAclAction() === 'set' ? '' : 'none';
}

function readBulkCatAction(): CategoriesAction {
    const el = document.querySelector<HTMLInputElement>('input[name="permBulkCatAction"]:checked');
    const v = el?.value;
    return v === 'add' || v === 'set' || v === 'clear' ? v : 'none';
}

let currentBulkCategoryTags: string[] = [];

function readBulkCatInput(): string {
    return currentBulkCategoryTags.join(',');
}

function renderBulkCategoryTags(): void {
    const container = document.getElementById('permBulkCatContainer');
    const input = document.getElementById('permBulkCatInput') as HTMLInputElement | null;
    if (!container || !input) return;

    container.querySelectorAll('.category-tag').forEach(el => el.remove());

    currentBulkCategoryTags.forEach((tag, index) => {
        const tagEl = document.createElement('span');
        tagEl.className = 'category-tag';
        tagEl.innerHTML = `<span>${escapeHtml(tag)}</span> <i class="mdi mdi-close" data-index="${index}" style="cursor:pointer;"></i>`;
        container.insertBefore(tagEl, input);
    });
}

function toggleBulkCatFieldset() {
    const fs = document.getElementById('permBulkCatFieldset') as HTMLFieldSetElement | null;
    if (!fs) return;
    const action = readBulkCatAction();
    fs.style.display = (action === 'add' || action === 'set') ? '' : 'none';
}

function normalizeCatList(raw: string): string[] {
    return parseCategoriesString(raw);
}

function arrayEqualSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const s = new Set(a);
    for (const v of b) if (!s.has(v)) return false;
    return true;
}

function targetCatsForRow(row: RowState, action: CategoriesAction, catVal: string[]): string[] {
    if (action === 'none') return row.categories;
    if (action === 'clear') return [];
    if (action === 'set') return [...catVal];
    // add: 합집합 (기존 순서 보존)
    const seen = new Set(row.categories);
    const out = [...row.categories];
    for (const v of catVal) {
        if (!seen.has(v)) { seen.add(v); out.push(v); }
    }
    return out;
}

function actionToTarget(a: FlagAction): 0 | 1 | null {
    return a === 'on' ? 1 : a === 'off' ? 0 : null;
}

function targetAclForRow(row: RowState, action: AclAction, aclVal: EditAcl | null): EditAcl | null {
    if (action === 'none') return row.edit_acl;
    if (action === 'clear') return null;
    return aclVal;
}

function updateBulkMaster(state: ModalState): void {
    const master = document.getElementById('permBulkMaster') as HTMLInputElement | null;
    if (!master) return;
    if (state.rows.length === 0) {
        master.checked = false;
        master.indeterminate = false;
        master.disabled = true;
        return;
    }
    master.disabled = false;
    const checked = state.rows.filter(r => r.currentlyChecked).length;
    if (checked === 0) {
        master.checked = false; master.indeterminate = false;
    } else if (checked === state.rows.length) {
        master.checked = true; master.indeterminate = false;
    } else {
        master.checked = false; master.indeterminate = true;
    }
}

function updateBulkCounter(state: ModalState): void {
    const counter = document.getElementById('permBulkCounter');
    if (counter) {
        if (state.rows.length === 0) {
            counter.textContent = ui("m_15f2c0b076847d0c");
        } else {
            const privA = readBulkPrivateAction();
            const aclA = readBulkAclAction();
            const aclV = aclA === 'set' ? readAclValueFrom('permBulkAcl') : null;
            const catA = readBulkCatAction();
            const catV = (catA === 'add' || catA === 'set') ? normalizeCatList(readBulkCatInput()) : [];
            const targetPriv = actionToTarget(privA);
            const checked = state.rows.filter(r => r.currentlyChecked).length;
            let changeCount = 0;
            for (const r of state.rows) {
                if (!r.currentlyChecked) continue;
                const newPriv = targetPriv === null ? r.is_private : targetPriv;
                const newAcl = targetAclForRow(r, aclA, aclV);
                const newCats = targetCatsForRow(r, catA, catV);
                if (
                    newPriv !== r.is_private ||
                    !aclEqual(newAcl, r.edit_acl) ||
                    !arrayEqualSet(newCats, r.categories)
                ) changeCount++;
            }
            counter.textContent = ui("m_bcb2dd464c283b8b", [checked, state.rows.length, changeCount]);
        }
    }
    updateBulkMaster(state);
}

function setAllBulkRows(state: ModalState, checked: boolean): void {
    for (const row of state.rows) {
        row.currentlyChecked = checked;
        row.checkbox.checked = checked;
        const tr = row.checkbox.closest<HTMLTableRowElement>('tr[data-page-id]');
        tr?.classList.add('bulkcat-row-touched');
    }
    updateBulkCounter(state);
}

function renderBulkSubpages(items: SubpageItem[], prefix: string): string {
    if (items.length === 0) {
        return window.uiEmptyState({ icon: 'bi bi-inbox', title: ui("m_8678a8c0ff001570"), compact: true });
    }
    const prefixWithSlash = prefix + '/';
    const rows = items.map((item) => {
        const display = item.slug.startsWith(prefixWithSlash) ? item.slug.slice(prefixWithSlash.length) : item.slug;
        const flags = `${privateBadge(item.is_private)} ${aclBadge(item.edit_acl)} ${categoriesChips(item.categories)}`;
        return `
            <tr data-page-id="${item.id}" style="--bulkcat-depth: ${item.depth};">
                <td>
                    <label class="bulkcat-row-label">
                        <input type="checkbox" class="form-check-input perm-bulk-checkbox" data-page-id="${item.id}">
                        <code class="bulkcat-slug">${escapeHtml(display)}</code>
                    </label>
                </td>
                <td class="bulkcat-row-cats-cell">${flags}</td>
            </tr>
        `;
    }).join('');
    const warning = items.length > 500
        ? ui("m_22d4a168003098be", [items.length])
        : '';
    return ui("m_61f429d04adf9133", [warning, items.length, rows]);
}

async function loadBulkTree(state: ModalState): Promise<void> {
    const panel = document.getElementById('permBulkPanel');
    if (!panel) return;
    const res = await fetchSubpages(state.prefix);
    if ('error' in res) {
        panel.innerHTML = `<div class="bulkcat-warning">${escapeHtml(res.error)}</div>`;
        const counter = document.getElementById('permBulkCounter');
        if (counter) counter.textContent = ui("m_ebaf4022cf1aed6d");
        return;
    }
    panel.innerHTML = renderBulkSubpages(res.items, state.prefix);

    const master = panel.querySelector<HTMLInputElement>('#permBulkMaster');
    master?.addEventListener('change', () => setAllBulkRows(state, master.checked));

    state.rows.length = 0;
    for (const item of res.items) {
        const cb = panel.querySelector<HTMLInputElement>(`input.perm-bulk-checkbox[data-page-id="${item.id}"]`);
        if (!cb) continue;
        const row: RowState = {
            id: item.id,
            slug: item.slug,
            depth: item.depth,
            is_private: item.is_private,
            edit_acl: item.edit_acl,
            categories: Array.isArray(item.categories) ? item.categories : [],
            currentlyChecked: false,
            checkbox: cb,
        };
        cb.addEventListener('change', () => {
            row.currentlyChecked = cb.checked;
            const tr = cb.closest<HTMLTableRowElement>('tr[data-page-id]');
            tr?.classList.add('bulkcat-row-touched');
            updateBulkCounter(state);
        });
        state.rows.push(row);
    }
    updateBulkCounter(state);
}

// ── 섹션 3: 자동 규칙 표 ─────────────────────────────────────────

function hookRuleDeleteButtons(container: HTMLElement, relatedTo: string) {
    container.querySelectorAll<HTMLButtonElement>('.perm-rule-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const row = btn.closest<HTMLTableRowElement>('tr[data-rule-id]');
            if (!row) return;
            const id = Number(row.dataset.ruleId);
            if (!Number.isFinite(id)) return;
            const swal = window.Swal;
            const confirm = await swal?.fire({
                title: ui("m_7c29f4abd8717ff2"),
                text: ui("m_eec2407187e26eff"),
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: ui("m_6139b6c3ed73cd4a"),
                cancelButtonText: ui("m_be876433993ab7ba"),
                confirmButtonColor: '#EF4444',
            });
            if (!confirm?.isConfirmed) return;
            const ok = await deleteRule(id);
            if (!ok) {
                swal?.fire({ icon: 'error', title: ui("m_154d878a1e5a9b5c"), toast: true, position: 'top-end', timer: 2500, showConfirmButton: false });
                return;
            }
            const rules = await fetchRules(relatedTo);
            container.innerHTML = rulesTableHtml(rules);
            hookRuleDeleteButtons(container, relatedTo);
        });
    });
}

// ── 진입점 ───────────────────────────────────────────────────────

export async function openPermissionsModal(rawSlug: string): Promise<void> {
    const swal = window.Swal;
    if (!swal) return;
    const slug = normalizeSlug(rawSlug || '');
    if (!slug) {
        await swal.fire({ icon: 'warning', title: ui("m_b64a912c7cdc706f"), text: ui("m_b90c889e61a85b91") });
        return;
    }

    const [pageRes, rules] = await Promise.all([
        fetchCurrentPage(slug),
        fetchRules(slug).catch(() => [] as DocSettingRule[]),
    ]);

    let page: CurrentPage | null = null;
    let pageLoadError: string | null = null;
    if ('error' in pageRes) {
        pageLoadError = pageRes.error;
    } else {
        page = pageRes;
        // edit-acl 은 관리자 전용 응답이 정답 — GET /api/w/:slug 의 edit_acl 은 admin 전용 표면이 아닐 수 있어 보완.
        const acl = await fetchAclForSlug(slug).catch(() => page!.edit_acl);
        page.edit_acl = acl;
    }

    const state: ModalState = {
        slug,
        prefix: slug,
        rows: [],
        page,
        initialAcl: page?.edit_acl ?? null,
    };

    const result = await swal.fire({
        title: ui("m_2e98257ab2ed913a", [slug]),
        html: buildModalHtml(slug, page, pageLoadError, rules),
        width: 820,
        showCancelButton: true,
        confirmButtonText: ui("m_cb9865d6f0415fb3"),
        cancelButtonText: ui("m_1e8c10206f5b35bd"),
        focusConfirm: false,
        didOpen: () => {
            // 섹션 1: 현재 문서
            document.querySelectorAll<HTMLInputElement>('input[name="permCurAclAction"]').forEach((el) => {
                el.addEventListener('change', toggleCurAclFieldset);
            });
            toggleCurAclFieldset();
            document.getElementById('permCurSaveBtn')?.addEventListener('click', () => { void saveCurrent(state); });

            // 섹션 2: 일괄
            document.querySelectorAll<HTMLInputElement>(
                'input[name="permBulkPrivateAction"], input[name="permBulkAclAction"], input[name="permBulkCatAction"]'
            ).forEach((el) => el.addEventListener('change', () => updateBulkCounter(state)));
            document.querySelectorAll<HTMLInputElement>('input[name="permBulkAclAction"]').forEach((el) => {
                el.addEventListener('change', toggleBulkAclFieldset);
            });
            document.querySelectorAll<HTMLInputElement>('input[name="permBulkCatAction"]').forEach((el) => {
                el.addEventListener('change', toggleBulkCatFieldset);
            });
            document.querySelectorAll<HTMLInputElement>('.permBulkAcl-flag').forEach((el) => {
                el.addEventListener('change', () => updateBulkCounter(state));
            });

            currentBulkCategoryTags = [];
            const catContainer = document.getElementById('permBulkCatContainer');
            const catInput = document.getElementById('permBulkCatInput') as HTMLInputElement | null;

            if (catContainer && catInput) {
                const addTag = (tag: string) => {
                    const cleanTag = tag.trim();
                    if (!cleanTag) return;
                    if (!/^[가-힣a-zA-Z0-9\s_.-]+$/.test(cleanTag)) {
                        swal.fire({
                            icon: 'warning',
                            title: ui("m_4907df8dbe60e7cc"),
                            text: ui("m_19823ed7547a358d"),
                            toast: true,
                            position: 'top-end',
                            timer: 2000,
                            showConfirmButton: false,
                        });
                        return;
                    }
                    if (currentBulkCategoryTags.includes(cleanTag)) return;
                    currentBulkCategoryTags.push(cleanTag);
                    renderBulkCategoryTags();
                    updateBulkCounter(state);
                };

                catContainer.addEventListener('click', (e) => {
                    const target = e.target as HTMLElement;
                    if (target.matches('.mdi-close')) {
                        const index = parseInt(target.getAttribute('data-index') || '-1', 10);
                        if (index >= 0) {
                            currentBulkCategoryTags.splice(index, 1);
                            renderBulkCategoryTags();
                            updateBulkCounter(state);
                        }
                    }
                });

                catInput.addEventListener('keydown', (e) => {
                    if (e.isComposing) return;
                    if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        if (catInput.value.trim()) {
                            catInput.value.split(',').forEach(addTag);
                            catInput.value = '';
                        }
                    } else if (e.key === 'Backspace' && catInput.value === '') {
                        if (currentBulkCategoryTags.length > 0) {
                            currentBulkCategoryTags.pop();
                            renderBulkCategoryTags();
                            updateBulkCounter(state);
                        }
                    }
                });

                catInput.addEventListener('blur', () => {
                    setTimeout(() => {
                        if (catInput.value.trim()) {
                            catInput.value.split(',').forEach(addTag);
                            catInput.value = '';
                        }
                    }, 150);
                });

                catInput.addEventListener('input', () => {
                    if (catInput.value.includes(',')) {
                        const parts = catInput.value.split(',');
                        const lastFragment = parts.pop() ?? '';
                        parts.forEach(addTag);
                        catInput.value = lastFragment;
                    }
                });
            }

            toggleBulkAclFieldset();
            toggleBulkCatFieldset();
            void loadBulkTree(state);

            // 섹션 3: 규칙 표
            const tableEl = document.getElementById('permRulesTable');
            if (tableEl) hookRuleDeleteButtons(tableEl, slug);
        },
        preConfirm: () => {
            const privateAction = readBulkPrivateAction();
            const aclAction = readBulkAclAction();
            const aclValue = aclAction === 'set' ? readAclValueFrom('permBulkAcl') : null;
            const categoriesAction = readBulkCatAction();
            const categoriesList = (categoriesAction === 'add' || categoriesAction === 'set')
                ? normalizeCatList(readBulkCatInput())
                : [];
            const persistEl = document.getElementById('permBulkPersist') as HTMLInputElement | null;
            const persist = !!persistEl?.checked;

            if (aclAction === 'set' && !aclValue) {
                swal.showValidationMessage(ui("m_452730bf876c22f5"));
                return false;
            }
            if ((categoriesAction === 'add' || categoriesAction === 'set') && categoriesList.length === 0) {
                swal.showValidationMessage(ui("m_f4ed3622226140c2"));
                return false;
            }
            if (categoriesAction === 'add' || categoriesAction === 'set') {
                const raw = readBulkCatInput();
                if (!/^[가-힣a-zA-Z0-9\s_.,-]+$/.test(raw)) {
                    swal.showValidationMessage(ui("m_35926634b2949979"));
                    return false;
                }
            }

            const targetPriv = actionToTarget(privateAction);
            const ids: number[] = [];
            for (const r of state.rows) {
                if (!r.currentlyChecked) continue;
                const newPriv = targetPriv === null ? r.is_private : targetPriv;
                const newAcl = aclAction === 'none' ? r.edit_acl : aclAction === 'clear' ? null : aclValue;
                const newCats = targetCatsForRow(r, categoriesAction, categoriesList);
                if (
                    newPriv !== r.is_private ||
                    !aclEqual(newAcl, r.edit_acl) ||
                    !arrayEqualSet(newCats, r.categories)
                ) ids.push(r.id);
            }

            const willApply = ids.length > 0;
            const anyAction = privateAction !== 'none' || aclAction !== 'none' || categoriesAction !== 'none';

            if (!willApply && !persist) {
                swal.showValidationMessage(ui("m_5883deb01ff006e3"));
                return false;
            }
            if (willApply && !anyAction) {
                swal.showValidationMessage(ui("m_4ae0f2688cbcd728"));
                return false;
            }
            if (persist) {
                // 'clear' 도 명시적 액션 — 기존 룰의 해당 필드만 NULL 로 갱신하면서 나머지 필드는 서버에서 보존된다.
                // 카테고리만 비우거나 ACL 만 끄는 비파괴적 편집 경로를 막지 않도록 'none' 만 "지정 안 함" 으로 본다.
                const persistHasPriv = privateAction !== 'none';
                const persistHasAcl = aclAction !== 'none';
                const persistHasCats = categoriesAction !== 'none';
                if (!persistHasPriv && !persistHasAcl && !persistHasCats) {
                    swal.showValidationMessage(ui("m_816a9963ad2fb3a3"));
                    return false;
                }
            }

            return {
                prefix: state.prefix,
                privateAction,
                aclAction,
                aclValue,
                categoriesAction,
                categoriesValue: categoriesList.join(','),
                ids,
                persist,
                willApply,
            };
        },
    });

    if (!result.isConfirmed || !result.value) return;
    const { prefix, privateAction, aclAction, aclValue, categoriesAction, categoriesValue, ids, persist, willApply } = result.value as {
        prefix: string; privateAction: FlagAction; aclAction: AclAction;
        aclValue: EditAcl | null; categoriesAction: CategoriesAction; categoriesValue: string;
        ids: number[]; persist: boolean; willApply: boolean;
    };

    try {
        const res = await fetch('/api/admin/doc-setting-prefix-rules/bulk-apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prefix, privateAction, aclAction, aclValue, categoriesAction, categoriesValue, ids, persist }),
        });
        if (!res.ok) {
            const err = (await res.json().catch(() => ({}))) as { error?: string };
            await swal.fire({ icon: 'error', title: ui("m_2743911f83e1da69"), text: err.error || ui("m_f887c5441fa72e31", [res.status]) });
            return;
        }
        const data = (await res.json()) as { scanned: number; requested: number; changed: number; ruleSaved: boolean };
        const changeMsg = willApply
            ? ui("m_24fdc521ee0a8f67", [data.scanned, data.changed])
            : '';
        const ruleMsg = data.ruleSaved
            ? (changeMsg ? ui("m_dfa4cd979d3624f4") : ui("m_af46859340851645"))
            : '';
        await swal.fire({ icon: 'success', title: ui("m_4f2ed8c604fc2f30"), html: changeMsg + ruleMsg || ui("m_93b58fbaf5e77126") });
    } catch (e) {
        console.error('permissions modal bulk-apply failed', e);
        await swal.fire({ icon: 'error', title: ui("m_0dd9df5c73a87e5c"), text: String(e) });
    }
}

window.openPermissionsModal = openPermissionsModal;
