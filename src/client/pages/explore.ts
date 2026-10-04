// @ts-nocheck — explore.html 포털 부트스트랩. common.ts 가 window.* 로 노출하는 공통 전역
// (loadConfig / checkAuth / loadTrending / loadRecentChanges / getRelativeTime / escapeHtml /
//  uiSkeletonList / uiEmptyState / goRandomPage)을 사용한다. any 형태 fetch 응답이라 타입 검사를 끈다.

// ── 문서 활동(최근 수정 내역 / 모든 문서 목록) 상태 — 기존 recent-changes 페이지에서 통합 ──
import { ui, getLocale } from '../../../packages/wiki-shared/src/i18n/client';
const PAGE_SIZE = 10;
let currentRecentPage = 1;
let totalRecentPages = 0;
let recentRevisionsAbortController = null;

const ALL_PAGES_SIZE = 20;
let allPagesLoaded = false; // '모든 문서 목록' 탭 최초 로드 여부
let currentSort = 'slug_asc';
let currentAllPage = 1;
let totalAllPages = 0;
let allPagesAbortController = null;

document.addEventListener('DOMContentLoaded', async () => {
  await window.loadConfig();
  await window.checkAuth();
  if (['admin', 'super_admin'].includes(window.currentUser?.role)) {
    document.getElementById('patrolFilterLabel').classList.remove('d-none');
    document.getElementById('unpatrolledOnly').addEventListener('change', () => loadRecentRevisions(1));
    document.getElementById('revisionsList').addEventListener('click', patrolRevision);
  }

  // 사이드바 트렌딩 / 최근 변경 (자동 호출 아님 — 페이지가 직접 호출)
  window.loadTrending();
  window.loadRecentChanges();

  loadSummary();
  loadPendingEdits();

  // 문서 활동: 최근 수정 내역은 즉시, 모든 문서 목록은 탭 최초 진입 시 로드
  loadRecentRevisions();
  document.getElementById('tab-allpages').addEventListener('shown.bs.tab', () => {
    if (!allPagesLoaded) {
      loadAllPages();
      allPagesLoaded = true;
    }
  });
});

const esc = (s) => window.escapeHtml(String(s ?? ''));
const wikiHref = (slug) => '/w/' + encodeURIComponent(slug);

// ── 포털 집계 로드 ──
async function loadSummary() {
  const orphansEl = document.getElementById('orphansList');
  const wantedEl = document.getElementById('wantedList');
  const discEl = document.getElementById('recentDiscussionsList');
  orphansEl.innerHTML = window.uiSkeletonList(5);
  wantedEl.innerHTML = window.uiSkeletonList(5);
  discEl.innerHTML = window.uiSkeletonList(5);

  try {
    const res = await fetch('/api/explore/summary');
    if (!res.ok) throw new Error(ui("m_de0eb575bed307f0"));
    const data = await res.json();

    renderStats(data.stats || {});
    renderOrphans(orphansEl, data.orphans || []);
    renderWanted(wantedEl, data.wanted || []);
    renderDiscussions(discEl, data.recent_discussions || []);
  } catch (e) {
    console.error('探索数据加载失败：', e);
    const err = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: ui("m_d1d044826a45ef65") });
    orphansEl.innerHTML = err;
    wantedEl.innerHTML = err;
    discEl.innerHTML = err;
  }
}

// ── 통계 배지 ──
function renderStats(stats) {
  const el = document.getElementById('exploreStats');
  const n = (v) => Number(v || 0).toLocaleString(getLocale());
  const badge = (icon, color, label, value) =>
    `<span class="badge bg-${color} bg-opacity-10 text-${color} border px-3 py-2" style="font-size: 0.9rem;">
       <i class="bi ${icon}"></i> ${label} <strong>${n(value)}</strong></span>`;
  el.innerHTML = [
    badge('bi-file-earmark-text', 'primary', ui("m_452c7b10d57a86a7"), stats.page_count),
    badge('bi-people', 'success', ui("m_0d0e1a86b3aa7877"), stats.user_count),
    badge('bi-pencil-square', 'info', ui("m_051836569928a9f9"), stats.revision_count),
    badge('bi-image', 'secondary', ui("m_fa33e10009759859"), stats.media_count),
    badge('bi-person-up', 'warning', ui("m_d83a4ae92ee35421"), stats.active_editors_30d),
  ].join('');
}

// ── 고아 문서 ──
function renderOrphans(el, items) {
  if (!items.length) {
    el.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-check2-circle', title: ui("m_4b5d12f9faf3d1db") });
    return;
  }
  el.innerHTML = items.map(it => `
    <a href="${wikiHref(it.slug)}" class="d-flex align-items-center justify-content-between text-decoration-none text-body px-2 py-2 border-bottom explore-row">
      <span class="text-truncate me-2">${esc(it.title || it.slug)}</span>
      <span class="text-muted small flex-shrink-0">${window.getRelativeTime(it.updated_at)}</span>
    </a>`).join('');
}

// ── 미작성 문서 (빨간 링크) ──
function renderWanted(el, items) {
  if (!items.length) {
    el.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-check2-circle', title: ui("m_af65e4f04d01eb81") });
    return;
  }
  el.innerHTML = items.map(it => ui("m_e095dc68c73af754", [wikiHref(it.slug), esc(it.slug), Number(it.ref_count || 0).toLocaleString(getLocale())])).join('');
}

// ── 최근 토론 활동 ──
function renderDiscussions(el, items) {
  if (!items.length) {
    el.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-chat-left', title: ui("m_bf97ecf1fd60c99b") });
    return;
  }
  el.innerHTML = items.map(it => `
    <a href="${wikiHref(it.page_slug)}?mode=discussions&id=${it.discussion_id}" class="d-block text-decoration-none text-body px-2 py-2 border-bottom explore-row">
      <div class="d-flex align-items-center justify-content-between">
        <span class="text-truncate me-2 fw-medium">${esc(it.page_slug)}</span>
        <span class="text-muted small flex-shrink-0">${window.getRelativeTime(it.created_at)}</span>
      </div>
      <div class="small text-muted text-truncate">${esc(it.discussion_title)} · ${esc(it.author_name || ui("m_1ac13841ba2ea68b"))}</div>
    </a>`).join('');
}

// ── 검토 대기 편집 요청 목록 (검토 가능한 사용자에게만 노출) ──
// 서버가 검토 권한자에게 actionable 한(본인 작성 제외·ACL 통과) 요청만 내려주므로(자연 게이팅)
// 별도 권한 체크 없이 목록을 그대로 렌더한다. 검토는 각 문서 열람 페이지에서 진행한다.
async function loadPendingEdits() {
  try {
    const res = await fetch('/api/pending-edits');
    if (!res.ok) return; // 비로그인(401)/비검토자 등 → 섹션 숨김 유지
    const data = await res.json();
    const subs = Array.isArray(data.submissions) ? data.submissions : [];
    if (!subs.length) return; // 검토 대기 없음 → 섹션 숨김 유지

    document.getElementById('pendingEditsCount').textContent = subs.length.toLocaleString(getLocale());
    document.getElementById('pendingEditsList').innerHTML = subs.map(renderPendingEditRow).join('');
    document.getElementById('pendingEditsSection').classList.remove('d-none');
  } catch (e) {
    // 무시 — 섹션 숨김 유지
  }
}

function renderPendingEditRow(it) {
  // updated_at 은 ISO 문자열 → getRelativeTime 은 unix 초를 받으므로 변환한다.
  const unix = Math.floor(new Date(it.updated_at).getTime() / 1000);
  const when = Number.isFinite(unix) ? window.getRelativeTime(unix) : '';
  const actionBadge = it.action === 'create'
    ? ui("m_be1e30363041209b")
    : ui("m_9b9b10704163d765");
  const conflict = it.has_conflict
    ? ui("m_33c54070d7d8ecbb")
    : '';
  const meta = ui("m_4f5151dbe61f6c75", [esc(it.author_name || ui("m_1ac13841ba2ea68b")), it.summary ? ' · ' + esc(it.summary) : '']);
  return `
    <a href="${wikiHref(it.slug)}" class="d-block text-decoration-none text-body px-2 py-2 border-bottom explore-row">
      <div class="d-flex align-items-center justify-content-between gap-2">
        <span class="text-truncate me-2 fw-medium">${esc(it.slug)}</span>
        <span class="d-flex align-items-center gap-1 flex-shrink-0">
          ${actionBadge}${conflict}
          <span class="text-muted small">${when}</span>
        </span>
      </div>
      <div class="small text-muted text-truncate">${meta}</div>
    </a>`;
}

// ──────────────────────────────────────────────────────────────────────────
// 문서 활동 (기존 /recent-changes 페이지 통합): 최근 수정 내역 + 모든 문서 목록
// recent-changes.ts 의 로직을 그대로 가져오되, 포털은 전용 #loading/#mainContent 게이트가
// 없으므로 각 탭이 자체 스켈레톤만 사용한다. 통계 배지는 explore 통계로 통일됐다.
// ──────────────────────────────────────────────────────────────────────────

// ── 최근 수정 내역 로드 ──
async function loadRecentRevisions(page = 1) {
  if (recentRevisionsAbortController) {
    recentRevisionsAbortController.abort();
    recentRevisionsAbortController = null;
  }
  recentRevisionsAbortController = new AbortController();
  const signal = recentRevisionsAbortController.signal;

  const listEl = document.getElementById('revisionsList');
  try {
    listEl.innerHTML = window.uiSkeletonList(8);
    document.getElementById('recentRevisionsPagination').classList.add('d-none');

    const offset = (page - 1) * PAGE_SIZE;
    const unpatrolled = document.getElementById('unpatrolledOnly')?.checked && ['admin', 'super_admin'].includes(window.currentUser?.role);
    const res = await fetch(`/api/w/recent-revisions?offset=${offset}&limit=${PAGE_SIZE}${unpatrolled ? '&unpatrolled=1' : ''}`, { signal });
    if (!res.ok) throw new Error(ui("m_baaebc5af7766e90"));

    const data = await res.json();
    currentRecentPage = page;
    totalRecentPages = Math.max(1, Math.ceil((data.total || 0) / PAGE_SIZE));

    if (data.revisions.length === 0 && data.total > 0 && page > totalRecentPages) {
      loadRecentRevisions(totalRecentPages);
      return;
    }

    const itemsHtml = data.revisions.map(rev => {
      const date = new Date(rev.created_at * 1000).toLocaleString(getLocale());
      const timeAgo = window.getRelativeTime(rev.created_at);
      const versionLabel = rev.page_version != null ? `v${rev.page_version}` : `#${rev.id}`;

      return ui("m_67e25d7893673436", [window.escapeHtml(date), timeAgo, encodeURIComponent(rev.slug), window.escapeHtml(rev.slug), window.escapeHtml(rev.slug), rev.author_id ? `<a href="/profile/${rev.author_id}" class="revision-author badge bg-light text-dark border text-decoration-none" style="white-space: nowrap;">${window.escapeHtml(rev.author_name || ui("m_1ac13841ba2ea68b"))}${window.renderUserRoleIcon(rev.author_role)}</a>` : `<span class="revision-author badge bg-light text-dark border" style="white-space: nowrap;">${window.escapeHtml(rev.author_name || ui("m_1ac13841ba2ea68b"))}${window.renderUserRoleIcon(rev.author_role)}</span>`, window.escapeHtml(rev.summary || ui("m_b576a13957871acf")), versionLabel, ['admin', 'super_admin'].includes(window.currentUser?.role) ?
              (rev.patrolled_at ? ui("m_75f7ca0ed6df405a") :
              ui("m_9ff9d47a358012ee", [rev.id, window.escapeHtml(rev.slug), rev.author_id === window.currentUser.id ? ui("m_10434df2fdcb893a") : ''])) : '', encodeURIComponent(rev.slug)]);
    }).join('');

    listEl.innerHTML = itemsHtml;

    if (data.revisions.length === 0) {
      listEl.innerHTML = window.uiEmptyState({ icon: 'bi bi-inbox', title: ui("m_742ddaa38e71f95f"), text: ui("m_ff9eb48d91acd452") });
    }

    renderRecentRevisionsPagination();
    window.initRoleIconPopovers(listEl);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_6cba850e1617ad60"), 'error');
  }
}

async function patrolRevision(event) {
  const button = event.target.closest('button.patrol-revision');
  if (!button || button.disabled) return;
  button.disabled = true;
  try {
    const res = await fetch(`/api/w/${encodeURIComponent(button.dataset.slug)}/revisions/${button.dataset.revisionId}/patrol`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).error || ui("m_9f96d1f89b8d769d"));
    await loadRecentRevisions(currentRecentPage);
  } catch (error) {
    button.disabled = false;
    window.Swal.fire(ui("m_9f96d1f89b8d769d"), error.message, 'error');
  }
}

// ── 최근 수정 내역 페이지네이션 렌더링 ──
function renderRecentRevisionsPagination() {
  const nav = document.getElementById('recentRevisionsPagination');
  const ul = document.getElementById('recentRevisionsPaginationList');

  if (totalRecentPages <= 1) {
    nav.classList.add('d-none');
    ul.innerHTML = '';
    return;
  }

  nav.classList.remove('d-none');

  const pages = new Set([1, totalRecentPages]);
  for (let i = Math.max(2, currentRecentPage - 2); i <= Math.min(totalRecentPages - 1, currentRecentPage + 2); i++) {
    pages.add(i);
  }
  const sortedPages = [...pages].sort((a, b) => a - b);

  let html = ui("m_cb821349c65b43f8", [currentRecentPage === 1 ? 'disabled' : '', currentRecentPage === 1 ? 'tabindex="-1" aria-disabled="true"' : '', currentRecentPage - 1]);

  let prev = 0;
  for (const p of sortedPages) {
    if (prev && p - prev > 1) {
      html += `<li class="page-item disabled"><span class="page-link">…</span></li>`;
    }
    html += `<li class="page-item ${p === currentRecentPage ? 'active' : ''}">
      <a class="page-link" href="#" ${p === currentRecentPage ? 'aria-current="page"' : ''} onclick="event.preventDefault(); goToRecentPage(${p})">${p}</a>
    </li>`;
    prev = p;
  }

  html += ui("m_8f3c3623e2665cd2", [currentRecentPage === totalRecentPages ? 'disabled' : '', currentRecentPage === totalRecentPages ? 'tabindex="-1" aria-disabled="true"' : '', currentRecentPage + 1]);

  ul.innerHTML = html;
}

// ── 페이지 이동 (최근 수정 내역) ──
function goToRecentPage(page) {
  if (page < 1 || page > totalRecentPages) return;
  loadRecentRevisions(page);
  document.getElementById('pane-recent').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── 모든 문서 목록 로드 ──
async function loadAllPages(page = 1) {
  if (allPagesAbortController) {
    allPagesAbortController.abort();
    allPagesAbortController = null;
  }
  allPagesAbortController = new AbortController();
  const signal = allPagesAbortController.signal;

  try {
    const listEl = document.getElementById('allPagesList');
    const offset = (page - 1) * ALL_PAGES_SIZE;

    listEl.innerHTML = window.uiSkeletonList(8);
    document.getElementById('allPagesPagination').classList.add('d-none');

    const res = await fetch(`/api/w/all-pages?offset=${offset}&limit=${ALL_PAGES_SIZE}&sort=${currentSort}`, { signal });
    if (!res.ok) throw new Error(ui("m_09d77311b9c4a2f0"));

    const data = await res.json();
    currentAllPage = page;
    totalAllPages = Math.ceil(data.total / ALL_PAGES_SIZE);

    const showCategory = currentSort.startsWith('category');
    const showChars = currentSort.startsWith('chars');

    if (data.pages.length === 0) {
      if (data.total > 0) {
        loadAllPages(totalAllPages);
        return;
      }
      listEl.innerHTML = window.uiEmptyState({ icon: 'bi bi-inbox', title: ui("m_517ee39c282012b5"), text: ui("m_33cecb018bdc5163") });
      return;
    }

    listEl.innerHTML = data.pages.map(pageItem => {
      const createdDate = new Date(pageItem.created_at * 1000).toLocaleDateString(getLocale());
      const updatedDate = new Date(pageItem.updated_at * 1000).toLocaleDateString(getLocale());
      const categoryBadge = pageItem.category
        ? `<span class="badge bg-secondary bg-opacity-10 text-secondary border">${window.escapeHtml(pageItem.category)}</span>`
        : ui("m_0733e8ad76af239f");

      return ui("m_992ae1142c720658", [showCategory ? categoryBadge : '', encodeURIComponent(pageItem.slug), window.escapeHtml(pageItem.slug), window.escapeHtml(pageItem.slug), !showCategory ? categoryBadge : '', showChars ? ui("m_1bc8b774d178ed80", [Number(pageItem.characters || 0).toLocaleString(getLocale())]) : '', createdDate, updatedDate]);
    }).join('');

    renderAllPagesPagination();
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_6b301628568971e6"), 'error');
  }
}

// ── 페이지네이션 렌더링 (모든 문서 목록) ──
function renderAllPagesPagination() {
  const nav = document.getElementById('allPagesPagination');
  const ul = document.getElementById('allPagesPaginationList');

  if (totalAllPages <= 1) {
    nav.classList.add('d-none');
    return;
  }

  nav.classList.remove('d-none');

  const pages = new Set([1, totalAllPages]);
  for (let i = Math.max(2, currentAllPage - 2); i <= Math.min(totalAllPages - 1, currentAllPage + 2); i++) {
    pages.add(i);
  }
  const sortedPages = [...pages].sort((a, b) => a - b);

  let html = ui("m_f4a79e31438c90ca", [currentAllPage === 1 ? 'disabled' : '', currentAllPage === 1 ? 'tabindex="-1" aria-disabled="true"' : '', currentAllPage - 1]);

  let prev = 0;
  for (const p of sortedPages) {
    if (prev && p - prev > 1) {
      html += `<li class="page-item disabled"><span class="page-link">…</span></li>`;
    }
    html += `<li class="page-item ${p === currentAllPage ? 'active' : ''}">
      <a class="page-link" href="#" ${p === currentAllPage ? 'aria-current="page"' : ''} onclick="event.preventDefault(); goToAllPage(${p})">${p}</a>
    </li>`;
    prev = p;
  }

  html += ui("m_de1bfae7a3a20278", [currentAllPage === totalAllPages ? 'disabled' : '', currentAllPage === totalAllPages ? 'tabindex="-1" aria-disabled="true"' : '', currentAllPage + 1]);

  ul.innerHTML = html;
}

// ── 페이지 이동 (모든 문서 목록) ──
function goToAllPage(page) {
  if (page < 1 || page > totalAllPages) return;
  loadAllPages(page);
  document.getElementById('pane-allpages').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── 정렬 변경 ──
function changeSort() {
  currentSort = document.getElementById('allPagesSortSelect').value;
  loadAllPages(1);
}

// HTML onclick/onchange 속성에서 호출되므로 window 로 노출한다.
window.goToRecentPage = goToRecentPage;
window.goToAllPage = goToAllPage;
window.changeSort = changeSort;
