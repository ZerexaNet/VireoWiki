/**
 * 하위 문서 카테고리 관리 모달 (구 "하위 문서 일괄 카테고리 적용").
 *
 * - public/edit.html 의 #bulkCategoryBtn 클릭 시 SweetAlert2 모달을 띄운다.
 * - 관리자 전용. 백엔드(/api/admin/category-prefix-rules*) 도 requireAdmin 으로 보호된다.
 * - 모달은 현재 편집 중인 문서의 슬러그를 prefix 로 사용해 하위 문서 트리를 펼치고,
 *   각 행에 체크박스를 두어 선택적으로 카테고리를 추가/제거할 수 있다.
 * - 카테고리 칩을 입력하면 이미 그 칩 전부를 가진 문서가 자동 체크된다.
 *   사용자가 직접 토글한 행은 칩 변경에 영향받지 않는다 (userTouched 플래그).
 * - 사전 체크된(이미 카테고리를 가진) 행의 체크를 해제하면 그 문서에서 카테고리를 제거한다.
 */

import { ui } from '../../../packages/wiki-shared/src/i18n/client';
import '../utils/swal';

import { normalizeSlug } from '../utils/slug';

interface PrefixRule {
    id: number;
    prefix: string;
    categories: string;
    created_at: number;
    created_by_name: string | null;
}

interface SubpageItem {
    id: number;
    slug: string;
    depth: number;
    categories: string[];
}

interface SubpagesResponse {
    prefix: string;
    scanned: number;
    items: SubpageItem[];
}

interface RowState {
    id: number;
    slug: string;
    depth: number;
    categories: string[];
    userTouched: boolean;
    currentlyChecked: boolean;
    checkbox: HTMLInputElement;
}

interface BulkCatModalState {
    prefix: string;
    rows: RowState[];
    getTags: () => string[];
}

function escapeHtml(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getCurrentSlug(): string {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('slug');
    return raw ? normalizeSlug(raw) : '';
}

async function fetchRules(relatedTo: string): Promise<PrefixRule[]> {
    const res = await fetch(`/api/admin/category-prefix-rules?relatedTo=${encodeURIComponent(relatedTo)}`);
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as PrefixRule[]) : [];
}

async function fetchSubpages(prefix: string): Promise<SubpagesResponse | { error: string }> {
    const res = await fetch(`/api/admin/category-prefix-rules/subpages?prefix=${encodeURIComponent(prefix)}`);
    if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { error: err.error || ui("m_f887c5441fa72e31", [res.status]) };
    }
    return (await res.json()) as SubpagesResponse;
}

function rulesTableHtml(rules: PrefixRule[]): string {
    if (rules.length === 0) {
        return ui("m_217f3927ada2d495");
    }
    const rows = rules
        .map(
            (r) => `
            <tr data-rule-id="${r.id}">
                <td><code>${escapeHtml(r.prefix)}/**</code></td>
                <td>${escapeHtml(r.categories)}</td>
                <td class="text-end">
                    <button type="button" class="btn btn-sm btn-wiki btn-wiki-danger bulkcat-rule-delete">
                        <i class="mdi mdi-trash-can-outline"></i>
                    </button>
                </td>
            </tr>`
        )
        .join('');
    return ui("m_da4b78a039d7ecf1", [rows]);
}

function buildModalHtml(currentSlug: string, rules: PrefixRule[]): string {
    return ui("m_7f64fa2837b5a993", [escapeHtml(currentSlug), window.uiInlineLoading({ block: true }), rulesTableHtml(rules)]);
}

async function deleteRule(id: number): Promise<boolean> {
    const res = await fetch(`/api/admin/category-prefix-rules/${id}`, { method: 'DELETE' });
    return res.ok;
}

async function refreshRulesTable(container: HTMLElement, relatedTo: string) {
    const rules = await fetchRules(relatedTo);
    container.innerHTML = rulesTableHtml(rules);
    hookRuleDeleteButtons(container, relatedTo);
}

function hookRuleDeleteButtons(container: HTMLElement, relatedTo: string) {
    container.querySelectorAll<HTMLButtonElement>('.bulkcat-rule-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const row = btn.closest<HTMLTableRowElement>('tr[data-rule-id]');
            if (!row) return;
            const id = Number(row.dataset.ruleId);
            if (!Number.isFinite(id)) return;
            const swal = window.Swal;
            const confirm = await swal?.fire({
                title: ui("m_7c29f4abd8717ff2"),
                text: ui("m_93e382fd871dcc17"),
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: ui("m_2f9daa828907b93f"),
                cancelButtonText: ui("m_2cd0f3be8738a86c"),
                confirmButtonColor: '#EF4444',
            });
            if (!confirm?.isConfirmed) return;
            const ok = await deleteRule(id);
            if (!ok) {
                swal?.fire({ icon: 'error', title: ui("m_c228558cf257fc49"), toast: true, position: 'top-end', timer: 2500, showConfirmButton: false });
                return;
            }
            await refreshRulesTable(container, relatedTo);
        });
    });
}

// 카테고리 칩 한 항목의 형식 검증 — 백엔드 CATEGORY_PATTERN 이 콤마 포함 문자열
// 전체에 한글/영문/숫자/공백/쉼표만 허용하므로, 칩 단위로는 콤마를 제외한
// 한글/영문/숫자/공백만 허용한다.
const BULK_CAT_TAG_RE = /^[가-힣a-zA-Z0-9\s]+$/;

interface BulkCatAcState {
    visible: boolean;
    results: string[];
    selectedIndex: number;
    query: string;
    lastQuery: string | null;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    div: HTMLElement | null;
}

/**
 * 모달이 열린 뒤 #bulkCatTagContainer / #bulkCatTagInput 에 칩 UI 와
 * 자동완성을 설치한다. tags 가 바뀔 때마다 onTagsChanged 콜백을 호출해
 * 트리의 자동 체크 상태를 재계산할 수 있게 한다.
 */
function installBulkCategoryTagUI(opts: { onTagsChanged?: () => void } = {}): {
    tags: string[];
    flushPending: () => void;
    hideAutocomplete: () => void;
    inputEl: HTMLInputElement | null;
} {
    const container = document.getElementById('bulkCatTagContainer');
    const input = document.getElementById('bulkCatTagInput') as HTMLInputElement | null;

    const tags: string[] = [];
    const fireChanged = () => opts.onTagsChanged?.();

    // 자동완성 dropdown 컨테이너는 모달 안에 동적으로 추가 (CSS 는 #category-autocomplete 와 공유)
    let acDiv: HTMLElement | null = null;
    if (container) {
        acDiv = document.createElement('div');
        acDiv.id = 'bulkCatAutocomplete';
        acDiv.className = 'list-group';
        acDiv.style.display = 'none';
        document.body.appendChild(acDiv);
    }

    const ac: BulkCatAcState = {
        visible: false,
        results: [],
        selectedIndex: -1,
        query: '',
        lastQuery: null,
        debounceTimer: null,
        div: acDiv,
    };

    function renderTags(): void {
        if (!container) return;
        container.querySelectorAll('.category-tag').forEach((t) => t.remove());
        tags.forEach((tagText, index) => {
            const tagEl = document.createElement('span');
            tagEl.className = 'category-tag';
            const labelSpan = document.createElement('span');
            labelSpan.textContent = tagText;
            const removeIcon = document.createElement('i');
            removeIcon.className = 'mdi mdi-close';
            removeIcon.style.cursor = 'pointer';
            removeIcon.addEventListener('click', (e) => {
                e.stopPropagation();
                tags.splice(index, 1);
                renderTags();
                fireChanged();
            });
            tagEl.appendChild(labelSpan);
            tagEl.appendChild(document.createTextNode(' '));
            tagEl.appendChild(removeIcon);
            if (input) {
                container.insertBefore(tagEl, input);
            } else {
                container.appendChild(tagEl);
            }
        });
    }

    function addTag(rawTag: string): boolean {
        const cleanTag = rawTag.trim();
        if (!cleanTag) return false;
        if (tags.includes(cleanTag)) return true;
        if (!BULK_CAT_TAG_RE.test(cleanTag)) {
            window.Swal?.fire({
                icon: 'warning',
                title: ui("m_63d43c7f9b539745"),
                text: ui("m_19823ed7547a358d"),
                toast: true,
                position: 'top-end',
                timer: 2000,
                showConfirmButton: false,
            });
            return false;
        }
        tags.push(cleanTag);
        renderTags();
        fireChanged();
        return true;
    }

    function hideAutocomplete(): void {
        ac.visible = false;
        ac.results = [];
        ac.selectedIndex = -1;
        ac.lastQuery = null;
        if (ac.div) ac.div.style.display = 'none';
    }

    function highlightItem(): void {
        if (!ac.div) return;
        ac.div.querySelectorAll('.cat-ac-item').forEach((item, idx) => {
            item.classList.toggle('active', idx === ac.selectedIndex);
            if (idx === ac.selectedIndex) item.scrollIntoView({ block: 'nearest' });
        });
    }

    function selectByIndex(index: number): void {
        const item = ac.results[index];
        if (!item) return;
        addTag(item);
        if (input) input.value = '';
        hideAutocomplete();
        input?.focus();
    }

    function renderResults(): void {
        if (!ac.div) return;
        if (ac.results.length === 0) {
            hideAutocomplete();
            return;
        }
        ac.div.innerHTML = '';
        ac.results.forEach((item, index) => {
            const row = document.createElement('div');
            row.className = 'list-group-item cat-ac-item';
            row.dataset.index = String(index);
            const icon = document.createElement('i');
            icon.className = 'mdi mdi-tag-outline';
            const label = document.createElement('span');
            label.textContent = item;
            row.appendChild(icon);
            row.appendChild(label);
            // blur 처리보다 먼저 fire 되도록 mousedown 사용
            row.addEventListener('mousedown', (e) => {
                e.preventDefault();
                selectByIndex(index);
            });
            ac.div!.appendChild(row);
        });
        ac.selectedIndex = -1;
        highlightItem();
    }

    function showAutocomplete(query: string): void {
        if (!ac.div || !container) return;
        ac.query = query;
        ac.visible = true;
        const rect = container.getBoundingClientRect();
        ac.div.style.position = 'fixed';
        ac.div.style.left = rect.left + 'px';
        ac.div.style.top = rect.bottom + 2 + 'px';
        ac.div.style.width = rect.width + 'px';
        ac.div.style.display = 'block';

        if (ac.query === ac.lastQuery) return;
        ac.lastQuery = ac.query;

        if (ac.debounceTimer !== null) clearTimeout(ac.debounceTimer);
        ac.debounceTimer = setTimeout(async () => {
            if (!ac.visible) return;
            try {
                const res = await fetch(`/api/w/search-categories?q=${encodeURIComponent(ac.query)}`);
                if (!res.ok) return;
                const data = (await res.json()) as { results?: string[] };
                ac.results = data.results || [];
                renderResults();
            } catch (e) {
                console.error('Category autocomplete fetch error:', e);
            }
        }, 200);
    }

    if (container && input) {
        container.addEventListener('click', () => input.focus());

        input.addEventListener('keydown', (e) => {
            if (e.isComposing) return;

            if (ac.visible) {
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (ac.results.length > 0) {
                        ac.selectedIndex = (ac.selectedIndex + 1) % ac.results.length;
                        highlightItem();
                    }
                    return;
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (ac.results.length > 0) {
                        ac.selectedIndex = (ac.selectedIndex - 1 + ac.results.length) % ac.results.length;
                        highlightItem();
                    }
                    return;
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    hideAutocomplete();
                    return;
                } else if ((e.key === 'Enter' || e.key === 'Tab') && ac.selectedIndex >= 0) {
                    e.preventDefault();
                    selectByIndex(ac.selectedIndex);
                    return;
                }
            }

            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                if (input.value.trim()) {
                    input.value.split(',').forEach((t) => addTag(t));
                    input.value = '';
                    hideAutocomplete();
                }
            } else if (e.key === 'Backspace' && input.value === '') {
                if (tags.length > 0) {
                    tags.pop();
                    renderTags();
                    fireChanged();
                }
            }
        });

        input.addEventListener('blur', () => {
            setTimeout(() => {
                hideAutocomplete();
            }, 150);
        });

        input.addEventListener('input', () => {
            if (input.value.includes(',')) {
                const parts = input.value.split(',');
                const lastFragment = parts.pop() ?? '';
                parts.forEach((t) => addTag(t));
                input.value = lastFragment;
                hideAutocomplete();
                return;
            }
            showAutocomplete(input.value.trim());
        });
    }

    return {
        tags,
        flushPending: () => {
            if (!input) return;
            const pending = input.value.trim();
            if (pending) {
                pending.split(',').forEach((t) => addTag(t));
                input.value = '';
            }
        },
        hideAutocomplete: () => {
            hideAutocomplete();
            if (ac.div && ac.div.parentNode) {
                ac.div.parentNode.removeChild(ac.div);
            }
        },
        inputEl: input,
    };
}

function computePreCheck(row: RowState, tags: string[]): boolean {
    if (tags.length === 0) return false;
    const cats = new Set(row.categories);
    return tags.every((t) => cats.has(t));
}

function renderSubpagesTable(items: SubpageItem[], prefix: string): { rows: RowState[]; panelHtml: string } {
    if (items.length === 0) {
        return {
            rows: [],
            panelHtml: window.uiEmptyState({ icon: 'bi bi-inbox', title: ui("m_8fad38bd78865ed0"), compact: true }),
        };
    }
    // DOM 생성은 호출자가 수행 — 여기서는 마크업만 만들고 rows 는 별도 객체로 채운다.
    const prefixWithSlash = prefix + '/';
    const tbodyRows = items.map((item) => {
        const display = item.slug.startsWith(prefixWithSlash) ? item.slug.slice(prefixWithSlash.length) : item.slug;
        const catsHtml = item.categories.length === 0
            ? ui("m_132826fa46e65b5f")
            : `<span class="bulkcat-row-categories">${item.categories.map((c) => `<span class="bulkcat-cat-chip">${escapeHtml(c)}</span>`).join('')}</span>`;
        return `
            <tr data-page-id="${item.id}" style="--bulkcat-depth: ${item.depth};">
                <td>
                    <label class="bulkcat-row-label">
                        <input type="checkbox" class="form-check-input bulkcat-checkbox" data-page-id="${item.id}">
                        <code class="bulkcat-slug">${escapeHtml(display)}</code>
                    </label>
                </td>
                <td class="bulkcat-row-cats-cell">${catsHtml}</td>
            </tr>
        `;
    }).join('');

    const warning = items.length > 500
        ? ui("m_22d4a168003098be", [items.length])
        : '';

    return {
        rows: [],
        panelHtml: ui("m_61e2fbeb63b40304", [warning, items.length, tbodyRows]),
    };
}

function updateMasterCheckbox(state: BulkCatModalState): void {
    const master = document.getElementById('bulkCatMasterCheckbox') as HTMLInputElement | null;
    if (!master) return;
    if (state.rows.length === 0) {
        master.checked = false;
        master.indeterminate = false;
        master.disabled = true;
        return;
    }
    master.disabled = false;
    const checked = state.rows.filter((r) => r.currentlyChecked).length;
    if (checked === 0) {
        master.checked = false;
        master.indeterminate = false;
    } else if (checked === state.rows.length) {
        master.checked = true;
        master.indeterminate = false;
    } else {
        master.checked = false;
        master.indeterminate = true;
    }
}

function updateCounter(state: BulkCatModalState): void {
    const counter = document.getElementById('bulkCatCounter');
    if (counter) {
        if (state.rows.length === 0) {
            counter.textContent = ui("m_15f2c0b076847d0c");
        } else {
            const checked = state.rows.filter((r) => r.currentlyChecked).length;
            const tags = state.getTags();
            let addCount = 0;
            let removeCount = 0;
            for (const r of state.rows) {
                const pageHasAll = tags.length > 0 && tags.every((t) => r.categories.includes(t));
                if (r.currentlyChecked && !pageHasAll) addCount++;
                // 자동 체크 규칙(ALL)과 대칭: pageHasAll 인 행만 체크 해제 시 제거 대상.
                // 부분 매칭만 되는 행을 "전체 해제" 등으로 우연히 해제해도 카테고리가 제거되지 않도록 한다.
                if (!r.currentlyChecked && r.userTouched && pageHasAll) removeCount++;
            }
            counter.textContent = ui("m_88e05cab0c0583b9", [checked, state.rows.length, addCount, removeCount]);
        }
    }
    updateMasterCheckbox(state);
}

function recomputePreChecks(state: BulkCatModalState): void {
    const tags = state.getTags();
    for (const row of state.rows) {
        if (row.userTouched) continue;
        const pre = computePreCheck(row, tags);
        row.currentlyChecked = pre;
        row.checkbox.checked = pre;
    }
    updateCounter(state);
}

async function loadAndRenderTree(state: BulkCatModalState): Promise<void> {
    const panel = document.getElementById('bulkCatSubpagesPanel');
    if (!panel) return;

    const res = await fetchSubpages(state.prefix);
    if ('error' in res) {
        panel.innerHTML = `<div class="bulkcat-warning">${escapeHtml(res.error)}</div>`;
        const counter = document.getElementById('bulkCatCounter');
        if (counter) counter.textContent = ui("m_ebaf4022cf1aed6d");
        return;
    }

    const { panelHtml } = renderSubpagesTable(res.items, state.prefix);
    panel.innerHTML = panelHtml;

    // 마스터 "전체" 체크박스 — 모든 행 일괄 토글
    const master = panel.querySelector<HTMLInputElement>('#bulkCatMasterCheckbox');
    if (master) {
        master.addEventListener('change', () => {
            setAllRows(state, master.checked);
        });
    }

    // RowState 채우기 — DOM 안의 체크박스 참조를 잡아 보관
    state.rows.length = 0;
    for (const item of res.items) {
        const cb = panel.querySelector<HTMLInputElement>(
            `input.bulkcat-checkbox[data-page-id="${item.id}"]`
        );
        if (!cb) continue;
        const row: RowState = {
            id: item.id,
            slug: item.slug,
            depth: item.depth,
            categories: item.categories,
            userTouched: false,
            currentlyChecked: false,
            checkbox: cb,
        };
        cb.addEventListener('change', () => {
            row.userTouched = true;
            row.currentlyChecked = cb.checked;
            const tr = cb.closest<HTMLTableRowElement>('tr[data-page-id]');
            tr?.classList.add('bulkcat-row-touched');
            updateCounter(state);
        });
        state.rows.push(row);
    }

    recomputePreChecks(state);
}

function setAllRows(state: BulkCatModalState, checked: boolean): void {
    for (const row of state.rows) {
        row.userTouched = true;
        row.currentlyChecked = checked;
        row.checkbox.checked = checked;
        const tr = row.checkbox.closest<HTMLTableRowElement>('tr[data-page-id]');
        tr?.classList.add('bulkcat-row-touched');
    }
    updateCounter(state);
}

async function openBulkCategoryModal() {
    const swal = window.Swal;
    if (!swal) return;

    const currentSlug = getCurrentSlug();
    if (!currentSlug) {
        await swal.fire({
            icon: 'warning',
            title: ui("m_b64a912c7cdc706f"),
            text: ui("m_0f8085b7bde2b753"),
        });
        return;
    }

    let rules: PrefixRule[] = [];
    try {
        rules = await fetchRules(currentSlug);
    } catch (e) {
        console.warn('Failed to load prefix rules', e);
    }

    let tagUI: ReturnType<typeof installBulkCategoryTagUI> | null = null;
    const state: BulkCatModalState = {
        prefix: currentSlug,
        rows: [],
        getTags: () => tagUI?.tags ?? [],
    };

    const result = await swal.fire({
        title: ui("m_92e1fdf8beae6d63"),
        html: buildModalHtml(currentSlug, rules),
        width: 760,
        showCancelButton: true,
        confirmButtonText: ui("m_ac2a58826d92e6ae"),
        cancelButtonText: ui("m_3fd47edce45b3603"),
        focusConfirm: false,
        didOpen: () => {
            const tableEl = document.getElementById('bulkCatRulesTable');
            if (tableEl) hookRuleDeleteButtons(tableEl, currentSlug);

            tagUI = installBulkCategoryTagUI({
                onTagsChanged: () => recomputePreChecks(state),
            });

            void loadAndRenderTree(state);
            tagUI.inputEl?.focus();
        },
        willClose: () => {
            tagUI?.hideAutocomplete();
        },
        preConfirm: () => {
            tagUI?.flushPending();
            const tags = tagUI?.tags ?? [];
            const persistEl = document.getElementById('bulkCatPersist') as HTMLInputElement | null;
            const persist = !!persistEl?.checked;

            const addIds: number[] = [];
            const removeIds: number[] = [];
            for (const r of state.rows) {
                const pageHasAll = tags.length > 0 && tags.every((t) => r.categories.includes(t));
                if (r.currentlyChecked && !pageHasAll) addIds.push(r.id);
                // 자동 체크 규칙(ALL)과 대칭: pageHasAll 인 행만 체크 해제 시 제거 대상.
                // 부분 매칭 행은 "전체 해제" 로 우연히 토글돼도 카테고리가 제거되지 않는다.
                if (!r.currentlyChecked && r.userTouched && pageHasAll) removeIds.push(r.id);
            }

            const willApply = addIds.length > 0 || removeIds.length > 0;
            if (willApply && tags.length === 0) {
                swal.showValidationMessage(ui("m_b4b1f2a564d854b5"));
                return false;
            }
            if (!willApply && !persist) {
                swal.showValidationMessage(ui("m_343252396d4d401c"));
                return false;
            }
            if (persist && tags.length === 0) {
                swal.showValidationMessage(ui("m_ca3e5733b920c6d7"));
                return false;
            }

            return {
                prefix: currentSlug,
                categories: tags.join(','),
                addIds,
                removeIds,
                persist,
                willApply,
            };
        },
    });

    if (!result.isConfirmed || !result.value) return;
    const { prefix, categories, addIds, removeIds, persist, willApply } = result.value as {
        prefix: string;
        categories: string;
        addIds: number[];
        removeIds: number[];
        persist: boolean;
        willApply: boolean;
    };

    try {
        if (willApply) {
            const res = await fetch('/api/admin/category-prefix-rules/bulk-apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prefix, categories, addIds, removeIds, persist }),
            });
            if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as { error?: string };
                await swal.fire({ icon: 'error', title: ui("m_2743911f83e1da69"), text: err.error || ui("m_f887c5441fa72e31", [res.status]) });
                return;
            }
            const data = (await res.json()) as {
                scanned: number;
                added: number;
                removed: number;
                ruleSaved: boolean;
            };
            await swal.fire({
                icon: 'success',
                title: ui("m_4f2ed8c604fc2f30"),
                html: ui("m_4f42e9c473808f1e", [escapeHtml(String(data.scanned)), escapeHtml(String(data.added)), escapeHtml(String(data.removed)), data.ruleSaved ? ui("m_060465fa16bfecec") : '']),
            });
        } else if (persist) {
            const res = await fetch('/api/admin/category-prefix-rules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prefix, categories }),
            });
            if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as { error?: string };
                await swal.fire({ icon: 'error', title: ui("m_2743911f83e1da69"), text: err.error || ui("m_f887c5441fa72e31", [res.status]) });
                return;
            }
            await swal.fire({
                icon: 'success',
                title: ui("m_95d3fea17c6818a9"),
                text: ui("m_f3b31700b077585d"),
            });
        }
    } catch (e) {
        console.error('bulk-category apply failed', e);
        await swal.fire({ icon: 'error', title: ui("m_0dd9df5c73a87e5c"), text: String(e) });
    }
}

function init() {
    const btn = document.getElementById('bulkCategoryBtn');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        void openBulkCategoryModal();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
