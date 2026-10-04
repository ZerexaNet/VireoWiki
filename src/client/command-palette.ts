/**
 * 전역 커맨드 팔레트 & 키보드 단축키 모듈.
 *
 * common.ts 가 import 후 initCommandPalette() 를 호출하며, common.js 번들에 포함돼
 * 모든 주요 페이지(error/login 제외)에 자동 로드된다. 별도 Vite 엔트리/`<script>` 불필요.
 *
 * 제공 기능:
 *  - Cmd/Ctrl+K: 커맨드 팔레트(문서/카테고리 제안 + 빠른 액션 + 명령 모드) — 입력/에디터
 *    포커스 중에도 항상 동작.
 *  - `/`(헤더 검색 포커스), `g h`/`g e`/`g r`(홈/탐색/랜덤 시퀀스), `e`(현재 문서 편집),
 *    `?`(단축키 도움말). 단일/시퀀스 키는 입력·CodeMirror 포커스 시·IME 조합 중 비활성.
 *
 * 문서/카테고리 제안은 기존 `GET /api/search/suggest` 를 그대로 재사용한다(백엔드 변경 없음).
 */

import { ui } from '../../packages/wiki-shared/src/i18n/client';
import { emptyState, skeletonList } from './utils/ui-state';

// window.* 로 노출된 common.ts / index.ts 전역 브리지에 접근하기 위한 캐스팅 헬퍼.
type GlobalBridge = typeof window & {
    navigateTo?: (url: string) => void;
    goRandomPage?: () => void;
    setTheme?: (mode: 'light' | 'dark' | 'auto') => void;
    openSettingsModal?: () => void;
    currentUser?: {
        id: number;
        name: string;
        role: string;
        permissions?: Record<string, boolean>;
    } | null;
    // index.ts 가 문서 렌더 시 노출하는 정식 편집 대상(리다이렉트 canonical·권한 반영). 없으면 편집 불가.
    currentArticleEdit?: { slug: string } | null;
    // 에디터 페이지(edit-cheatsheet 번들)에서만 정의되는 문법 치트시트 진입점.
    openSyntaxCheatsheet?: () => void;
    // SweetAlert2 CDN 전역. 팔레트가 새 문서 이름을 prompt 할 때 사용.
    Swal?: {
        fire: (opts: Record<string, unknown>) => Promise<{ isConfirmed: boolean; value?: string }>;
    };
};
const w = window as GlobalBridge;

// ───────────────────────────────────────────────────────────────────────────
// 공통 유틸
// ───────────────────────────────────────────────────────────────────────────

function esc(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 호출 식별자(slug) 네임스페이스별 mdi 아이콘 (헤더 자동완성 suggestionIcon 과 동일 규약).
function suggestionIcon(slug: string): string {
    const lower = slug.toLowerCase();
    if (lower.startsWith('map:')) return 'mdi mdi-file-tree-outline';
    if (slug.startsWith('카테고리:')) return 'mdi mdi-tag-outline';
    if (slug.startsWith('이미지:')) return 'mdi mdi-image-outline';
    return 'mdi mdi-file-document-outline';
}

function isVirtualNamespace(slug: string): boolean {
    const lower = slug.toLowerCase();
    return lower.startsWith('map:') || slug.startsWith('이미지:') || slug.startsWith('카테고리:');
}

// /w/<slug> 또는 / 면 SPA navigateTo, 그 외에는 풀 네비게이션.
function go(url: string): void {
    if ((url === '/' || url.startsWith('/w/')) && typeof w.navigateTo === 'function') {
        w.navigateTo(url);
    } else {
        window.location.href = url;
    }
}

// 새 문서 만들기. 문서 이름(슬러그)만 받아 /edit?slug=<이름> 으로 이동한다.
// 유효 문자 검증은 팔레트에서 하지 않는다 — 과거 `가-힣` 만 허용하던 정규식이 한글
// 초성(ㄱ-ㅎ jamo)을 거부해 초성 문서를 만들 수 없었다. 입력값을 그대로 /edit 으로
// 넘기고, 빈/금지문자 슬러그는 에디터가 페이지 로드 즉시 수행하는 검증
// (normalizeSlug → 빈 슬러그/SLUG_FORBIDDEN_CHARS 차단)에 위임한다.
function newDocument(): void {
    const Swal = w.Swal;
    if (!Swal || typeof Swal.fire !== 'function') return;
    Swal.fire({
        title: ui("m_33dcddf15dc978d8"),
        input: 'text',
        inputLabel: ui("m_876c6189ce292af4"),
        inputPlaceholder: ui("m_c9370c3f2f8dde70"),
        showCancelButton: true,
        confirmButtonText: ui("m_81b8d99b4f9bdf3c"),
        cancelButtonText: ui("m_2cd0f3be8738a86c"),
    }).then((result) => {
        if (result.isConfirmed && result.value) {
            window.location.href = '/edit?slug=' + encodeURIComponent(result.value);
        }
    });
}

// 현재 조회 중인 문서의 정식 편집 대상 slug (편집 불가/비-위키 페이지면 null).
// index.ts 가 문서 렌더 시 `window.currentArticleEdit` 로 노출한다 — 리다이렉트 시 canonical
// `page.slug`(pathname 의 리다이렉트 stub 이 아님), 이미지/map 문서·권한 없음·admin_only
// 잠금이면 null. pathname 파싱 대신 페이지가 계산한 정식 대상을 그대로 재사용해, 리다이렉트
// stub 편집·잠긴 문서의 error-and-redirect 를 피한다("카테고리:" 문서는 일반 편집 가능해 포함).
function getEditTarget(): string | null {
    const e = w.currentArticleEdit;
    return e && typeof e.slug === 'string' ? e.slug : null;
}

// ───────────────────────────────────────────────────────────────────────────
// 최근 방문 문서 (localStorage) — common.ts try/catch 관례 준수
// ───────────────────────────────────────────────────────────────────────────

const RECENT_KEY = 'recentVisitedDocs';
const RECENT_MAX = 20;

interface RecentDoc {
    slug: string;
    title?: string;
}

// 최근 방문 문서는 **인증 사용자별 버킷**으로 분리 저장한다. localStorage 는 같은
// 브라우저 프로필의 모든 계정·로그아웃 상태가 공유하므로 단일 목록에 담으면, 어떤
// 사용자가 본 문서(특히 이후 비공개로 전환된 문서)의 슬러그/제목이 게스트나 다른
// 계정에게 노출될 수 있다(권한 검사 없이 팔레트에 렌더). uid 별 분리 + 로그아웃은
// 'anon' 버킷으로 격리해 서로의 기록을 보지 못하게 한다(record 시점 is_private 스킵과
// 함께 다층 방어 — record 시점에 공개였다가 나중에 비공개로 바뀐 문서도 본인 버킷에만
// 남고 타 계정·게스트에는 보이지 않는다).
function currentRecentUid(): string {
    const id = w.currentUser?.id;
    return typeof id === 'number' ? String(id) : 'anon';
}

function readRecentStore(): Record<string, RecentDoc[]> {
    try {
        const raw = localStorage.getItem(RECENT_KEY);
        if (!raw) return {};
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
        return obj as Record<string, RecentDoc[]>;
    } catch {
        return {};
    }
}

function getRecentDocs(): RecentDoc[] {
    const bucket = readRecentStore()[currentRecentUid()];
    if (!Array.isArray(bucket)) return [];
    return bucket.filter((d): d is RecentDoc => !!d && typeof d.slug === 'string');
}

function recordRecentDoc(slug: string, title?: string): void {
    if (!slug || isVirtualNamespace(slug)) return;
    try {
        const store = readRecentStore();
        const uid = currentRecentUid();
        const existing = Array.isArray(store[uid]) ? store[uid] : [];
        const docs = existing.filter((d) => d && d.slug !== slug);
        docs.unshift(title ? { slug, title } : { slug });
        store[uid] = docs.slice(0, RECENT_MAX);
        localStorage.setItem(RECENT_KEY, JSON.stringify(store));
    } catch {
        /* 프라이빗 모드/쿼터 초과 — 무시 */
    }
}

// ───────────────────────────────────────────────────────────────────────────
// 액션 카탈로그
// ───────────────────────────────────────────────────────────────────────────

interface PaletteAction {
    id: string;
    label: string;
    icon: string;
    keywords: string;
    /** 노출 가능 여부 (false 면 숨김). 없으면 항상 노출. */
    canRun?: () => boolean;
    run: () => void;
}

function isAdmin(): boolean {
    const u = w.currentUser;
    if (!u) return false;
    if (u.role === 'admin' || u.role === 'super_admin') return true;
    return !!u.permissions && u.permissions['admin:access'] === true;
}

function canEditWiki(): boolean {
    const u = w.currentUser;
    return !!u && !!u.permissions && u.permissions['wiki:edit'] === true;
}

const ACTIONS: PaletteAction[] = [
    {
        id: 'edit',
        label: ui("m_b68b9aa395e1d283"),
        icon: 'mdi mdi-pencil',
        keywords: ui("m_1d3c8bb552e44b23"),
        canRun: () => !!getEditTarget(),
        run: () => {
            const slug = getEditTarget();
            if (slug) window.location.href = '/edit?slug=' + encodeURIComponent(slug);
        },
    },
    {
        id: 'newdoc',
        label: ui("m_6c0ad4da87f4b4b3"),
        icon: 'mdi mdi-file-plus-outline',
        keywords: ui("m_4af2f5a4ab686f85"),
        canRun: canEditWiki,
        run: () => newDocument(),
    },
    {
        id: 'random',
        label: ui("m_cd86b10b359ba0f7"),
        icon: 'bi bi-shuffle',
        keywords: ui("m_eef9c6abde132084"),
        run: () => {
            if (typeof w.goRandomPage === 'function') w.goRandomPage();
            else window.location.href = '/api/w/random';
        },
    },
    {
        id: 'explore',
        label: ui("m_b8957c30d19267f3"),
        icon: 'mdi mdi-compass-outline',
        keywords: ui("m_dcfde3b8d380d541"),
        run: () => go('/explore'),
    },
    {
        id: 'home',
        label: ui("m_ffe893bace2a4aba"),
        icon: 'mdi mdi-home-outline',
        keywords: ui("m_5a269c0e2c6ac18b"),
        run: () => go('/'),
    },
    {
        id: 'admin',
        label: ui("m_87354adb1c31e43d"),
        icon: 'mdi mdi-shield-account-outline',
        keywords: ui("m_8c74baa4038b9dec"),
        canRun: isAdmin,
        run: () => go('/admin'),
    },
    {
        id: 'theme-dark',
        label: ui("m_a7a6fa8c2a56c940"),
        icon: 'mdi mdi-moon-waxing-crescent',
        keywords: ui("m_0b9ebbd426468b58"),
        run: () => w.setTheme?.('dark'),
    },
    {
        id: 'theme-light',
        label: ui("m_e44a6a58308e37db"),
        icon: 'mdi mdi-white-balance-sunny',
        keywords: ui("m_3f13602d704b1fd0"),
        run: () => w.setTheme?.('light'),
    },
    {
        id: 'theme-auto',
        label: ui("m_71d696e2079989c2"),
        icon: 'mdi mdi-circle-half-full',
        keywords: ui("m_4e65100f2af2e903"),
        run: () => w.setTheme?.('auto'),
    },
    {
        id: 'settings',
        label: ui("m_c2952a5ffcc34883"),
        icon: 'mdi mdi-cog-outline',
        keywords: ui("m_4550d1947c5097d8"),
        run: () => w.openSettingsModal?.(),
    },
    {
        id: 'syntax-cheatsheet',
        label: ui("m_f6eeae9b0f5d9dbb"),
        icon: 'mdi mdi-book-search-outline',
        keywords: ui("m_2ce5a8b1a915598d"),
        // 에디터 페이지에서만 노출 (edit-cheatsheet 번들이 진입점을 정의).
        canRun: () => typeof w.openSyntaxCheatsheet === 'function',
        run: () => w.openSyntaxCheatsheet?.(),
    },
    {
        id: 'help',
        label: ui("m_61935cdc25a7b5c8"),
        icon: 'mdi mdi-keyboard-outline',
        keywords: ui("m_d3af477e12a7a4b3"),
        run: () => openHelpModal(),
    },
];

function visibleActions(): PaletteAction[] {
    return ACTIONS.filter((a) => !a.canRun || a.canRun());
}

function matchAction(a: PaletteAction, term: string): boolean {
    if (!term) return true;
    const t = term.toLowerCase();
    return a.label.toLowerCase().includes(t) || a.keywords.toLowerCase().includes(t);
}

// ───────────────────────────────────────────────────────────────────────────
// 팔레트 UI
// ───────────────────────────────────────────────────────────────────────────

interface PaletteItem {
    icon: string;
    label: string; // 이미 이스케이프된 HTML
    sublabel?: string; // 이미 이스케이프된 HTML
    run: () => void;
}

interface PaletteSection {
    title: string | null;
    items?: PaletteItem[];
    loading?: boolean;
}

let overlayEl: HTMLDivElement | null = null;
let inputEl: HTMLInputElement | null = null;
let listEl: HTMLUListElement | null = null;
let triggerEl: Element | null = null;

let selectable: PaletteItem[] = [];
let activeIdx = -1;

// 검색 상태
let curQuery = '';
let curSuggestions: RecentDoc[] | null = null;
let loading = false;
let fetchSeq = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function isOpen(): boolean {
    return !!overlayEl && !overlayEl.hidden;
}

function ensureDom(): void {
    if (overlayEl) return;

    overlayEl = document.createElement('div');
    overlayEl.className = 'cmd-palette-overlay';
    overlayEl.id = 'cmdPalette';
    overlayEl.setAttribute('role', 'dialog');
    overlayEl.setAttribute('aria-modal', 'true');
    overlayEl.setAttribute('aria-label', ui("m_51f9a31c0ae7a10b"));
    overlayEl.hidden = true;

    overlayEl.innerHTML =
        '<div class="cmd-palette-panel" role="document">' +
        '<div class="cmd-palette-input-wrap">' +
        '<i class="mdi mdi-magnify cmd-palette-search-icon" aria-hidden="true"></i>' +
        '<input type="text" class="cmd-palette-input" id="cmdPaletteInput" autocomplete="off" ' +
        ui("m_25e2dedb7781d25c") +
        'role="combobox" aria-expanded="true" aria-controls="cmdPaletteList" aria-activedescendant="">' +
        ui("m_76e21e04481b1910") +
        '</div>' +
        ui("m_dbfc08212ac85579") +
        '<div class="cmd-palette-foot">' +
        ui("m_4f255984f7f8e45a") +
        ui("m_1596d8fae424d0ca") +
        ui("m_115518dce9b7a39f") +
        ui("m_2a9b0e7c31cc401b") +
        '</div>' +
        '</div>';

    document.body.appendChild(overlayEl);
    inputEl = overlayEl.querySelector('#cmdPaletteInput');
    listEl = overlayEl.querySelector('#cmdPaletteList');

    // 백드롭 클릭 닫기 (패널 내부 클릭은 무시)
    overlayEl.addEventListener('mousedown', (e) => {
        if (e.target === overlayEl) closePalette();
    });

    inputEl!.addEventListener('input', handleInput);
    inputEl!.addEventListener('keydown', handleInputKey);
}

function handleInput(): void {
    const q = inputEl!.value.trim();
    curQuery = q;
    const docMode = !!q && !q.startsWith('>');
    if (docMode && q.length >= 2) {
        loading = true;
        curSuggestions = null;
        if (debounceTimer) clearTimeout(debounceTimer);
        const seq = ++fetchSeq;
        debounceTimer = setTimeout(() => doFetch(q, seq), 250);
    } else {
        loading = false;
        curSuggestions = null;
        if (debounceTimer) clearTimeout(debounceTimer);
    }
    render();
}

async function doFetch(q: string, seq: number): Promise<void> {
    try {
        const res = await fetch('/api/search/suggest?q=' + encodeURIComponent(q));
        if (seq !== fetchSeq) return; // stale
        if (res.ok) {
            const data = await res.json();
            if (seq !== fetchSeq) return;
            curSuggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
        } else {
            curSuggestions = [];
        }
    } catch {
        if (seq === fetchSeq) curSuggestions = [];
    }
    if (seq !== fetchSeq) return;
    loading = false;
    render();
}

function docItem(d: RecentDoc): PaletteItem {
    const display = d.title || d.slug;
    return {
        icon: suggestionIcon(d.slug),
        label: esc(display),
        sublabel: d.title ? esc(d.slug) : undefined,
        run: () => {
            closePalette();
            go('/w/' + encodeURIComponent(d.slug));
        },
    };
}

function actionItem(a: PaletteAction): PaletteItem {
    return {
        icon: a.icon,
        label: esc(a.label),
        run: () => {
            closePalette();
            a.run();
        },
    };
}

function searchAllItem(q: string): PaletteItem {
    return {
        icon: 'mdi mdi-magnify',
        label: '<strong>“' + esc(q) + ui("m_d5fe8044502d75dd"),
        run: () => {
            closePalette();
            window.location.href = '/search?q=' + encodeURIComponent(q) + '&mode=content';
        },
    };
}

function buildSections(): PaletteSection[] {
    const q = curQuery;
    const sections: PaletteSection[] = [];

    if (!q) {
        const recents = getRecentDocs();
        if (recents.length) {
            sections.push({ title: ui("m_463dd346080e7ab3"), items: recents.slice(0, 7).map(docItem) });
        }
        sections.push({ title: ui("m_7bb3f9811758f0e9"), items: visibleActions().map(actionItem) });
        return sections;
    }

    if (q.startsWith('>')) {
        const term = q.slice(1).trim();
        const acts = visibleActions().filter((a) => matchAction(a, term));
        sections.push({ title: ui("m_1f12b8e23dfddbba"), items: acts.map(actionItem) });
        return sections;
    }

    // 문서 검색 모드: 전체 검색 행 + 매칭 명령 + 문서/카테고리 제안
    sections.push({ title: null, items: [searchAllItem(q)] });

    const acts = visibleActions().filter((a) => matchAction(a, q));
    if (acts.length) sections.push({ title: ui("m_1f12b8e23dfddbba"), items: acts.map(actionItem) });

    if (q.length >= 2) {
        if (loading || curSuggestions === null) {
            sections.push({ title: ui("m_452c7b10d57a86a7"), loading: true });
        } else {
            const docs = curSuggestions.filter((s) => !s.slug.startsWith('카테고리:'));
            const cats = curSuggestions.filter((s) => s.slug.startsWith('카테고리:'));
            if (docs.length) sections.push({ title: ui("m_452c7b10d57a86a7"), items: docs.map(docItem) });
            if (cats.length) sections.push({ title: ui("m_515559957fd3acbd"), items: cats.map(docItem) });
        }
    }
    return sections;
}

function render(): void {
    if (!listEl) return;
    const sections = buildSections();
    selectable = [];

    let html = '';
    let hasAny = false;
    for (const sec of sections) {
        if (sec.title) html += '<li class="cmd-palette-group" role="presentation">' + esc(sec.title) + '</li>';
        if (sec.loading) {
            html += '<li class="cmd-palette-loading" role="presentation">' + skeletonList(3) + '</li>';
            continue;
        }
        for (const item of sec.items || []) {
            const idx = selectable.length;
            selectable.push(item);
            hasAny = true;
            html +=
                '<li class="search-suggestion-item cmd-palette-item" role="option" id="cmd-opt-' +
                idx +
                '" data-idx="' +
                idx +
                '">' +
                '<i class="' +
                item.icon +
                ui("m_5a30b6ad61d39bd0") +
                '<span class="cmd-palette-label">' +
                item.label +
                '</span>' +
                (item.sublabel ? ' <small class="text-muted">' + item.sublabel + '</small>' : '') +
                '</li>';
        }
    }

    if (!hasAny && !sections.some((s) => s.loading)) {
        html =
            '<li class="cmd-palette-empty" role="presentation">' +
            emptyState({ icon: 'bi bi-search', title: ui("m_1ba045c3573b1251"), text: ui("m_a706654a5b134832"), compact: true }) +
            '</li>';
    }

    listEl.innerHTML = html;

    // 클릭 바인딩
    listEl.querySelectorAll<HTMLLIElement>('.cmd-palette-item').forEach((el) => {
        el.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const idx = Number(el.dataset.idx);
            if (selectable[idx]) selectable[idx].run();
        });
        el.addEventListener('mousemove', () => {
            const idx = Number(el.dataset.idx);
            if (idx !== activeIdx) {
                activeIdx = idx;
                updateActive();
            }
        });
    });

    activeIdx = selectable.length ? 0 : -1;
    updateActive();
}

function updateActive(): void {
    if (!listEl || !inputEl) return;
    const items = listEl.querySelectorAll<HTMLLIElement>('.cmd-palette-item');
    items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
    if (activeIdx >= 0 && items[activeIdx]) {
        items[activeIdx].scrollIntoView({ block: 'nearest' });
        inputEl.setAttribute('aria-activedescendant', 'cmd-opt-' + activeIdx);
    } else {
        inputEl.setAttribute('aria-activedescendant', '');
    }
}

function handleInputKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (selectable.length) {
            activeIdx = Math.min(activeIdx + 1, selectable.length - 1);
            updateActive();
        }
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (selectable.length) {
            activeIdx = Math.max(activeIdx - 1, 0);
            updateActive();
        }
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIdx >= 0 && selectable[activeIdx]) {
            selectable[activeIdx].run();
        } else if (curQuery && !curQuery.startsWith('>')) {
            searchAllItem(curQuery).run();
        }
    } else if (e.key === 'Tab') {
        // 전체 검색 결과로 폴백
        e.preventDefault();
        const q = curQuery.startsWith('>') ? '' : curQuery;
        if (q) searchAllItem(q).run();
    } else if (e.key === 'Escape') {
        e.preventDefault();
        closePalette();
    }
}

function openPalette(): void {
    ensureDom();
    if (isOpen()) return;
    triggerEl = document.activeElement;
    curQuery = '';
    curSuggestions = null;
    loading = false;
    overlayEl!.hidden = false;
    document.body.classList.add('cmd-palette-open');
    inputEl!.value = '';
    render();
    // 다음 프레임에 포커스 (hidden 해제 직후 안정적으로)
    requestAnimationFrame(() => inputEl?.focus());
}

function closePalette(): void {
    if (!overlayEl || overlayEl.hidden) return;
    overlayEl.hidden = true;
    document.body.classList.remove('cmd-palette-open');
    if (debounceTimer) clearTimeout(debounceTimer);
    fetchSeq++; // 진행 중 fetch 무효화
    // 트리거 요소로 포커스 복귀
    if (triggerEl instanceof HTMLElement && document.contains(triggerEl)) {
        triggerEl.focus();
    }
    triggerEl = null;
}

function togglePalette(): void {
    if (isOpen()) closePalette();
    else openPalette();
}

// ───────────────────────────────────────────────────────────────────────────
// 단축키 도움말 모달
// ───────────────────────────────────────────────────────────────────────────

const SHORTCUTS: Array<{ keys: string[]; desc: string }> = [
    { keys: ['Ctrl/⌘', 'K'], desc: ui("m_d86de434ba64df92") },
    { keys: ['/'], desc: ui("m_e1cfad4ae66a5af3") },
    { keys: ['g', 'h'], desc: ui("m_64a9bf4fc5ecfc98") },
    { keys: ['g', 'e'], desc: ui("m_0a7a8e73f4902844") },
    { keys: ['g', 'r'], desc: ui("m_cd86b10b359ba0f7") },
    { keys: ['e'], desc: ui("m_efaf8a0202b89829") },
    { keys: ['?'], desc: ui("m_33d377b6c9c76b81") },
];

let helpEl: HTMLDivElement | null = null;

function helpOpen(): boolean {
    return !!helpEl && !helpEl.hidden;
}

function openHelpModal(): void {
    if (!helpEl) {
        helpEl = document.createElement('div');
        helpEl.className = 'cmd-help-overlay';
        helpEl.setAttribute('role', 'dialog');
        helpEl.setAttribute('aria-modal', 'true');
        helpEl.setAttribute('aria-label', ui("m_89ce481a4b23d2a4"));
        helpEl.hidden = true;

        const rows = SHORTCUTS.map(
            (s) =>
                '<tr><td class="cmd-help-keys">' +
                s.keys.map((k) => '<kbd>' + esc(k) + '</kbd>').join(' ') +
                '</td><td>' +
                esc(s.desc) +
                '</td></tr>'
        ).join('');

        helpEl.innerHTML =
            '<div class="cmd-help-panel" role="document">' +
            '<div class="cmd-help-header">' +
            ui("m_ee24f945b92412f6") +
            ui("m_f17dc0280ef14b6d") +
            '</div>' +
            '<table class="cmd-help-table"><tbody>' +
            rows +
            '</tbody></table>' +
            '</div>';

        document.body.appendChild(helpEl);
        helpEl.addEventListener('mousedown', (e) => {
            if (e.target === helpEl) closeHelpModal();
        });
        helpEl.querySelector('.cmd-help-close')!.addEventListener('click', () => closeHelpModal());
    }
    helpEl.hidden = false;
    document.body.classList.add('cmd-palette-open');
}

function closeHelpModal(): void {
    if (helpEl) helpEl.hidden = true;
    if (!isOpen()) document.body.classList.remove('cmd-palette-open');
}

// ───────────────────────────────────────────────────────────────────────────
// 전역 키보드 핸들러
// ───────────────────────────────────────────────────────────────────────────

function isEditableTarget(el: EventTarget | null): boolean {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    if (el.closest('.cm-editor')) return true;
    return false;
}

// Bootstrap 모달·SweetAlert2 등 애플리케이션 다이얼로그가 열려 있는지.
// 단일/시퀀스 키가 모달 위에서 발화하면(예: 모달 버튼 포커스 중 `e` → 에디터 이동,
// 확인창 미해결 채로 `g h` 이탈) 흐름을 깨므로, 이 경우 단축키를 비활성화한다.
function isAppDialogOpen(): boolean {
    if (document.querySelector('.modal.show')) return true;
    if (document.body.classList.contains('modal-open')) return true;
    if (document.querySelector('.swal2-container')) return true;
    return false;
}

// 한 글자(g·/·e·?) 단축키 사용 여부 — WCAG 2.1.4(문자 키 단축키)는 끄기/리매핑/포커스
// 한정 중 하나를 요구한다. 개인 설정 모달의 "키보드 단축키" 토글이 localStorage 에 저장하며
// (common.ts `KBD_SHORTCUTS_KEY`), 음성 입력 등 보조기술의 오발화를 끌 수 있게 한다.
// 수식 키 기반 Cmd/Ctrl+K 는 2.1.4 예외이므로 이 설정과 무관하게 항상 동작한다.
function singleKeyShortcutsEnabled(): boolean {
    try {
        return localStorage.getItem('keyboardShortcutsEnabled') !== 'off';
    } catch {
        return true;
    }
}

let leaderActive = false;
let leaderTimer: ReturnType<typeof setTimeout> | null = null;

function clearLeader(): void {
    leaderActive = false;
    if (leaderTimer) clearTimeout(leaderTimer);
    leaderTimer = null;
}

function handleGlobalKey(e: KeyboardEvent): void {
    // Cmd/Ctrl+K — 입력/에디터 포커스 중에도 항상 동작
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (helpOpen()) closeHelpModal();
        togglePalette();
        return;
    }

    // 모달/팔레트가 열려 있으면 자체 핸들러에 위임 (도움말 Esc 만 처리)
    if (helpOpen()) {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeHelpModal();
        }
        return;
    }
    if (isOpen()) return;

    // 이하 단일/시퀀스 키: 수식 키·IME 조합·입력/에디터 포커스 시 비활성
    if (e.isComposing) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isEditableTarget(e.target)) {
        clearLeader();
        return;
    }
    // 다른 애플리케이션 다이얼로그(Bootstrap 모달·SweetAlert)가 열려 있으면 단축키 비활성
    if (isAppDialogOpen()) {
        clearLeader();
        return;
    }
    // 사용자가 한 글자 단축키를 끈 경우 비활성 (WCAG 2.1.4 — Cmd/Ctrl+K 는 위에서 이미 처리)
    if (!singleKeyShortcutsEnabled()) {
        clearLeader();
        return;
    }

    if (leaderActive) {
        clearLeader();
        if (e.key === 'h') {
            e.preventDefault();
            go('/');
        } else if (e.key === 'e') {
            e.preventDefault();
            go('/explore');
        } else if (e.key === 'r') {
            e.preventDefault();
            if (typeof w.goRandomPage === 'function') w.goRandomPage();
        }
        return;
    }

    if (e.key === 'g') {
        leaderActive = true;
        leaderTimer = setTimeout(clearLeader, 1200);
        return;
    }
    if (e.key === '/') {
        const search = document.getElementById('searchInput') as HTMLInputElement | null;
        if (search) {
            e.preventDefault();
            search.focus();
        }
        return;
    }
    if (e.key === 'e') {
        const slug = getEditTarget();
        if (slug) {
            e.preventDefault();
            window.location.href = '/edit?slug=' + encodeURIComponent(slug);
        }
        return;
    }
    if (e.key === '?') {
        e.preventDefault();
        openHelpModal();
        return;
    }
}

// ───────────────────────────────────────────────────────────────────────────
// 초기화 / 전역 노출
// ───────────────────────────────────────────────────────────────────────────

let initialized = false;

export function initCommandPalette(): void {
    if (initialized) return;
    initialized = true;
    document.addEventListener('keydown', handleGlobalKey);
    (window as GlobalBridge & { openCommandPalette?: () => void; recordRecentDoc?: typeof recordRecentDoc }).openCommandPalette =
        openPalette;
    (window as GlobalBridge & { recordRecentDoc?: typeof recordRecentDoc }).recordRecentDoc = recordRecentDoc;
}
