// @ts-nocheck — revisions.html 인라인 스크립트 이관(동작 보존). common.ts 와 동일 사유로 타입검사 비활성.
//
// 이관 규칙:
//  - common.ts / render.ts / diff.ts 가 window.* 로 노출하는 공통 전역
//    (loadConfig / checkAuth / escapeHtml / renderUserRoleIcon /
//    initRoleIconPopovers / renderWikiContent / loadTrending /
//    loadRecentChanges / appConfig / currentUser / showDiffModal)은 모듈
//    스코프에서 bare 식별자로 해석되지 않으므로 window.* 로 접근한다.
//  - HTML onclick 속성에서 호출되는 함수(toggleRawView / backToRevisions /
//    viewRevision / confirmAndShowDiff / confirmRevert /
//    confirmDeleteRevision / goToRevPage)는 파일 끝에서 window.* 로 노출한다.

// ── 전역 상태 ──
import { ui, getLocale } from '../../../packages/wiki-shared/src/i18n/client';
let currentSlug = null;
let isPageDeleted = false;
const REV_PAGE_SIZE = 10;
let currentRevPage = 1;
let totalRevPages = 0;
let currentRevisionRawContent = '';
let currentRevisionSlug = '';
let isRawView = false;
let isExtensionData = false;
// 응답에서 받은 관리자 가시성 플래그. 일반 사용자에게는 서버가 삭제된 행을
// 애초에 보내지 않으므로 클라이언트는 따로 RBAC 판단을 하지 않는다.
let isAdminView = false;
let canHardDelete = false;
let lastRevisionId = null;

// 편집 요약 어디에 있든 [+N줄 -M줄] / [+N줄] / [-M줄] 토큰을 초록/빨강으로 색칠.
// 토큰 사이의 일반 텍스트는 escapeHtml 로 안전하게 인코딩하고, 토큰 자체는
// \d/+/-/줄/공백/[] 만으로 구성되어 있어 그대로 합성해도 안전하다.
// [MCP] 접두(admin-mcp.ts 가 부여)는 플러그 아이콘으로 치환해 사람 편집과 구분.
function renderRevisionSummary(raw) {
  if (!raw) return ui("m_b576a13957871acf");
  let body = raw;
  let mcpIcon = '';
  const mcpMatch = body.match(/^\s*\[MCP\]\s*/);
  if (mcpMatch) {
    mcpIcon = ui("m_2fecb165bb5e2c79");
    body = body.slice(mcpMatch[0].length);
  }
  // 가상 리비전 요약 접두([권한]/[이동])는 아이콘으로 치환해 비-본문 변경임을 구분.
  const permMatch = body.match(/^\s*\[권한\]\s*/);
  if (permMatch) {
    mcpIcon += ui("m_12cd2366a144c4bc");
    body = body.slice(permMatch[0].length);
  }
  const moveMatch = body.match(/^\s*\[이동\]\s*/);
  if (moveMatch) {
    mcpIcon += ui("m_5f8cd507c35be5e2");
    body = body.slice(moveMatch[0].length);
  }
  const tokenRe = /\[(?:\+\d+줄(?: -\d+줄)?|-\d+줄)\]/g;
  let html = '';
  let last = 0;
  let m;
  while ((m = tokenRe.exec(body)) !== null) {
    html += window.escapeHtml(body.slice(last, m.index));
    html += m[0]
      .replace(/\+(\d+)줄/, ui("m_25f0d827e03ff670"))
      .replace(/-(\d+)줄/, ui("m_75cb099b9144f625"));
    last = m.index + m[0].length;
  }
  html += window.escapeHtml(body.slice(last));
  return mcpIcon + html;
}

// ── URL에서 slug 추출 ──
function extractSlug() {
  const path = window.location.pathname;
  if (!path.startsWith('/w/')) return null;
  try { return decodeURIComponent(path.substring(3)); } catch { return path.substring(3); }
}

// ── 초기화 ──
document.addEventListener('DOMContentLoaded', async () => {
  await window.loadConfig();
  await window.checkAuth();
  currentSlug = extractSlug();
  if (currentSlug) {
    await showRevisions(currentSlug);
    // URL의 ?diff=<revId> 파라미터가 있으면 즉시 diff 모달 표시
    const diffParam = new URLSearchParams(window.location.search).get('diff');
    const diffRevId = diffParam ? Number(diffParam) : NaN;
    if (Number.isInteger(diffRevId) && diffRevId > 0) {
      showDiff(currentSlug, diffRevId);
    }
  } else {
    document.getElementById('loading').classList.add('d-none');
    Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_5fc9b515e116cb41"), 'error');
  }
  window.loadTrending();
  window.loadRecentChanges();
});

// ── 리비전 목록 ──
async function showRevisions(slug, page = 1) {
  try {
    const isFirstLoad = totalRevPages === 0 && currentRevPage === 1;
    if (isFirstLoad) {
      document.getElementById('loading').classList.remove('d-none');
      document.getElementById('revisionsPage').classList.add('d-none');
    }

    const offset = (page - 1) * REV_PAGE_SIZE;
    const res = await fetch(`/api/w/${encodeURIComponent(slug)}/revisions?offset=${offset}&limit=${REV_PAGE_SIZE}`);
    if (!res.ok) throw new Error(ui("m_75631a179257570c"));

    const data = await res.json();
    isAdminView = !!data.is_admin_view;
    canHardDelete = !!data.can_hard_delete;
    lastRevisionId = (typeof data.last_revision_id === 'number') ? data.last_revision_id : null;

    if (isFirstLoad) {
      const pageRes = await fetch(`/api/w/${encodeURIComponent(slug)}`);
      const pageData = pageRes.ok ? await pageRes.json() : null;
      isPageDeleted = !!pageData?.deleted_at;

      document.getElementById('revPageTitle').textContent = pageData?.slug || slug;
      document.getElementById('revBackLink').href = `/w/${encodeURIComponent(slug)}`;

      document.title = ui("m_9c6fedbdcbd93d71", [pageData?.slug || slug, window.appConfig.wikiName]);
    }

    currentRevPage = page;
    totalRevPages = Math.max(1, Math.ceil((data.total || 0) / REV_PAGE_SIZE));

    // 리비전이 삭제되어 범위를 벗어난 페이지를 요청한 경우 마지막 페이지로 이동
    if (data.revisions.length === 0 && data.total > 0) {
      showRevisions(slug, totalRevPages);
      return;
    }

    const listEl = document.getElementById('revisionsList');
    const enabledExts = (window.appConfig && window.appConfig.enabledExtensions) || [];
    const isExtSlug = enabledExts.some(ext => slug.startsWith(ext + ':'));
    const itemsHtml = data.revisions.map((rev, idx) => {
      const isVirtual = !!rev.is_virtual;
      // "현재 버전"은 본문 최신 리비전(last_revision_id) 기준. 가상 리비전이 목록 맨 위에
      // 올 수 있어 위치(idx) 기반 판정은 어긋나므로 last_revision_id 로 식별한다.
      // (last_revision_id 가 없을 때만 첫 행을 폴백으로 사용.)
      const isLatest = lastRevisionId != null
        ? rev.id === lastRevisionId
        : (page === 1 && idx === 0 && !isVirtual);
      const date = new Date(rev.created_at * 1000).toLocaleString(getLocale());

      // 가상 리비전: 본문 없는 비-본문 변경(ACL/비공개/주소 이동) 기록.
      // 열람·비교·되돌리기·삭제가 모두 불가하므로 액션 버튼 없이 요약만 표시한다.
      if (isVirtual) {
        const authorHtml = rev.author_id
          ? `<a href="${rev.author_role === 'deleted' ? '/404' : '/profile/' + rev.author_id}" class="revision-author badge bg-light text-dark border text-decoration-none">${window.escapeHtml(rev.author_name || ui("m_1ac13841ba2ea68b"))}${window.renderUserRoleIcon(rev.author_role)}</a>`
          : `<span class="revision-author badge bg-light text-dark border">${window.escapeHtml(rev.author_name || ui("m_1ac13841ba2ea68b"))}${window.renderUserRoleIcon(rev.author_role)}</span>`;
        return ui("m_8417a8327be8a0b2", [date, authorHtml, renderRevisionSummary(rev.summary)]);
      }
      // 삭제 상태: 비관리자 응답에는 삭제된 행 자체가 오지 않으므로 아래 분기는 관리자 한정.
      const isDeleted = !!rev.deleted_at;
      const isPurged = !!rev.purged_at;
      // fully_purged: 서버가 계산한 "R2 + 메타 정리까지 완전히 끝남" 플래그.
      // purged_at 만 있고 r2_key 또는 content 가 남아있는 부분 실패 상태에서는 false 가 되어
      // 영구 삭제 버튼을 다시 노출해 멱등 재시도를 허용한다.
      const isFullyPurged = !!rev.fully_purged;
      const isLastRev = lastRevisionId != null && rev.id === lastRevisionId;
      const deletedBadge = isPurged
        ? ui("m_5a3266c7401f9c07")
        : (isDeleted
          ? ui("m_59996aa9da2fcee4")
          : '');
      // 관리자에게만 보이는 통합 삭제 버튼.
      //  - 일반 admin: !isDeleted 일 때만 노출 → 클릭 시 소프트 삭제 확인만.
      //  - super_admin: !isFullyPurged 일 때 노출 → 클릭 시 모달 내부의 체크박스로 영구 삭제 여부를 선택.
      //  - 최신 리비전(last_revision_id)은 일관성 보호를 위해 모두 차단.
      const canDeleteThisRow = isAdminView && !isLastRev && (canHardDelete ? !isFullyPurged : !isDeleted);
      const isPartialPurge = isPurged && !isFullyPurged;
      const deleteBtnLabel = isPartialPurge ? ui("m_530ec947a64b994f") : ui("m_2f9daa828907b93f");
      const deleteBtnDangerClass = (canHardDelete && (isDeleted || isPartialPurge)) ? ' text-danger' : '';
      const deleteBtnTitle = isPartialPurge
        ? ui("m_9c7b5cbed1608f79")
        : (isDeleted
          ? (canHardDelete ? ui("m_2e551aad272bfe89") : '')
          : (canHardDelete ? ui("m_abfdb6f736d91271") : ui("m_aa3d7dbed5907267")));
      const deleteActions = canDeleteThisRow ? `
        <button class="btn btn-rev-action btn-rev-delete${deleteBtnDangerClass}" data-slug="${window.escapeHtml(slug)}" data-id="${rev.id}" data-page-version="${rev.page_version ?? ''}" data-is-deleted="${isDeleted ? '1' : '0'}" data-is-partial="${isPartialPurge ? '1' : '0'}" onclick="confirmDeleteRevision(this.dataset.slug, +this.dataset.id, this.dataset.pageVersion, this.dataset.isDeleted === '1', this.dataset.isPartial === '1')" title="${window.escapeHtml(deleteBtnTitle)}">
          <i class="bi bi-trash"></i> ${deleteBtnLabel}
        </button>` : '';
      const viewBtn = isPurged
        ? ui("m_14b625d6b5e536af")
        : ui("m_cc28b79029d81593", [window.escapeHtml(slug), rev.id, rev.page_version ?? '']);
      return ui("m_20d4643331204a2d", [isLatest ? ' is-current' : '', isDeleted ? ' is-deleted' : '', isDeleted ? ' style="opacity: 0.65;"' : '', date, rev.author_id ? `<a href="${rev.author_role === 'deleted' ? '/404' : '/profile/' + rev.author_id}" class="revision-author badge bg-light text-dark border text-decoration-none">${window.escapeHtml(rev.author_name || ui("m_1ac13841ba2ea68b"))}${window.renderUserRoleIcon(rev.author_role)}</a>` : `<span class="revision-author badge bg-light text-dark border">${window.escapeHtml(rev.author_name || ui("m_1ac13841ba2ea68b"))}${window.renderUserRoleIcon(rev.author_role)}</span>`, isLatest ? ui("m_25db76446465c291") : '', deletedBadge, renderRevisionSummary(rev.summary), viewBtn, window.escapeHtml(slug), rev.id, isExtSlug, window.escapeHtml(slug), rev.id, rev.page_version ?? '', isPageDeleted ? ui("m_79595cf49718118a") : (isPurged ? ui("m_cc27f871f0b91b41") : (isDeleted ? ui("m_be3b5b4c8d0028be") : '')), deleteActions]);
    }).join('');

    listEl.innerHTML = itemsHtml || window.uiEmptyState({ icon: 'bi bi-clock-history', title: ui("m_4277bb42bcd386b3") });

    renderRevisionsPagination();

    document.getElementById('loading').classList.add('d-none');
    document.getElementById('revisionsPage').classList.remove('d-none');
    window.initRoleIconPopovers(listEl);

  } catch (err) {
    console.error(err);
    document.getElementById('loading').classList.add('d-none');
    Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_3285dcf09c69c118"), 'error');
  }
}

// ── 페이지네이션 렌더링 ──
function renderRevisionsPagination() {
  const nav = document.getElementById('revisionsPagination');
  const ul = document.getElementById('revisionsPaginationList');

  if (totalRevPages <= 1) {
    nav.classList.add('d-none');
    ul.innerHTML = '';
    return;
  }

  nav.classList.remove('d-none');

  const pages = new Set([1, totalRevPages]);
  for (let i = Math.max(2, currentRevPage - 2); i <= Math.min(totalRevPages - 1, currentRevPage + 2); i++) {
    pages.add(i);
  }
  const sortedPages = [...pages].sort((a, b) => a - b);

  let html = ui("m_8be14893d1a02f0c", [currentRevPage === 1 ? 'disabled' : '', currentRevPage === 1 ? 'tabindex="-1" aria-disabled="true"' : '', currentRevPage - 1]);

  let prev = 0;
  for (const p of sortedPages) {
    if (prev && p - prev > 1) {
      html += `<li class="page-item disabled"><span class="page-link">…</span></li>`;
    }
    html += `<li class="page-item ${p === currentRevPage ? 'active' : ''}">
      <a class="page-link" href="#" ${p === currentRevPage ? 'aria-current="page"' : ''} onclick="event.preventDefault(); goToRevPage(${p})">${p}</a>
    </li>`;
    prev = p;
  }

  html += ui("m_7435828d7975a663", [currentRevPage === totalRevPages ? 'disabled' : '', currentRevPage === totalRevPages ? 'tabindex="-1" aria-disabled="true"' : '', currentRevPage + 1]);

  ul.innerHTML = html;
}

// ── 페이지 이동 ──
function goToRevPage(page) {
  if (page < 1 || page > totalRevPages || page === currentRevPage) return;
  if (!currentSlug) return;
  showRevisions(currentSlug, page);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── 리비전 보기 ──
async function viewRevision(slug, revId, pageVersion) {
  try {
    const res = await fetch(`/api/w/${encodeURIComponent(slug)}/revisions/${revId}`);
    if (!res.ok) throw new Error(ui("m_75631a179257570c"));
    const rev = await res.json();

    currentRevisionRawContent = rev.content || '';
    currentRevisionSlug = slug;
    isRawView = false;

    const versionLabel = (pageVersion !== '' && pageVersion != null) ? `v${pageVersion}` : `#${revId}`;
    let revDate = '';
    if (rev.created_at) {
      const d = new Date(rev.created_at * 1000);
      revDate = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    }
    document.getElementById('revisionViewLabel').textContent = revDate
      ? ui("m_10d8c31eec746ea2", [revDate, versionLabel])
      : ui("m_c67c60204c72929f", [versionLabel]);
    document.getElementById('revisionViewTitle').textContent = document.getElementById('revPageTitle').textContent || slug;
    document.getElementById('revisionViewContent').innerHTML = '';

    // 익스텐션 데이터 문서는 렌더링 비활성화
    const decodedSlugForExt = decodeURIComponent(slug);
    const enabledExts = (window.appConfig && window.appConfig.enabledExtensions) || [];
    const extPrefix = enabledExts.find(ext => decodedSlugForExt.startsWith(ext + ':'));
    isExtensionData = !!extPrefix;

    const rawBtn = document.getElementById('rawViewBtn');
    if (rawBtn) {
      rawBtn.style.display = isExtensionData ? 'none' : '';
      rawBtn.innerHTML = ui("m_2f755050b2d93e2a");
      rawBtn.classList.remove('btn-secondary');
      rawBtn.classList.add('btn-outline-secondary');
    }

    if (extPrefix) {
      document.getElementById('revisionViewContent').innerHTML = ui("m_ddee5a9983add2f7", [window.escapeHtml(extPrefix), window.escapeHtml(rev.content || '')]);
    } else {
      await window.renderWikiContent(rev.content || '', slug, 'revisionViewContent');
    }

    document.getElementById('revisionsPage').classList.add('d-none');
    document.getElementById('revisionViewPage').classList.remove('d-none');
    window.scrollTo({ top: 0, behavior: 'instant' });
  } catch (err) {
    Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
  }
}

function backToRevisions() {
  document.getElementById('revisionViewPage').classList.add('d-none');
  document.getElementById('revisionsPage').classList.remove('d-none');
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// ── Raw 보기 토글 ──
async function toggleRawView() {
  if (isExtensionData) return;
  isRawView = !isRawView;
  const contentEl = document.getElementById('revisionViewContent');
  const rawBtn = document.getElementById('rawViewBtn');
  if (isRawView) {
    contentEl.innerHTML = `<pre class="wiki-ext-raw-pre">${window.escapeHtml(currentRevisionRawContent)}</pre>`;
    rawBtn.innerHTML = ui("m_a7d43339f973d3a9");
    rawBtn.classList.remove('btn-outline-secondary');
    rawBtn.classList.add('btn-secondary');
  } else {
    contentEl.innerHTML = '';
    await window.renderWikiContent(currentRevisionRawContent, currentRevisionSlug, 'revisionViewContent');
    rawBtn.innerHTML = ui("m_2f755050b2d93e2a");
    rawBtn.classList.remove('btn-secondary');
    rawBtn.classList.add('btn-outline-secondary');
  }
}

// ── 리비전 Diff 보기 ──
// 익스텐션(R2-only) 슬러그는 본문이 대용량 데이터이므로 diff 실행 전 경고를 표시한다.
async function confirmAndShowDiff(slug, revId, requireConfirm) {
  if (requireConfirm) {
    const result = await Swal.fire({
      icon: 'warning',
      title: ui("m_7252784bdc29188c"),
      text: ui("m_538efa2ab274d60f"),
      showCancelButton: true,
      confirmButtonText: ui("m_b35001374ea98a40"),
      cancelButtonText: ui("m_2cd0f3be8738a86c"),
    });
    if (!result.isConfirmed) return;
  }
  showDiff(slug, revId);
}

// diff 토글 / LCS / rich diff / raw diff 함수들은 src/client/diff.ts 로 옮겨
// ESM 모듈로 빌드된다 (public/dist/diff.js). 이 파일은 window 에 동일 이름들을
// 매달아 두므로 아래 showDiff 가 그대로 호출할 수 있다. mypage 의 MCP 편집 승인
// 모달도 같은 모듈을 재사용한다.

async function showDiff(slug, revId) {
  try {
    const res = await fetch(`/api/w/${encodeURIComponent(slug)}/revisions/${revId}/diff`);
    if (!res.ok) throw new Error(ui("m_87437c094c143c8d"));
    const data = await res.json();

    const oldLabel = data.old_revision_id
      ? (data.old_page_version != null ? `v${data.old_page_version}` : `#${data.old_revision_id}`)
      : ui("m_2c5539adbf825ee1");
    const newLabel = data.new_page_version != null ? `v${data.new_page_version}` : `#${data.new_revision_id}`;

    // 익스텐션 데이터 슬러그(예: freq:foo) 는 본문이 마크다운이 아니라
    // 구조화된 데이터 payload 이므로 위키 렌더 결과는 의미 없는 출력이
    // 되어 실제 데이터 변경을 가린다. viewRevision 의 동일 검사를
    // 재사용하여 Raw 비교만 노출.
    //
    // 주의: 호출자(extractSlug / data-slug)가 이미 decode 한 슬러그를
    // 넘긴다. 여기서 또 decodeURIComponent 하면 제목에 리터럴 % 가 포함된
    // 경우 (예: "100% guide") URIError 로 실패하므로 그대로 사용.
    const enabledExts = (window.appConfig && window.appConfig.enabledExtensions) || [];
    const isExtensionDataDiff = enabledExts.some((ext) => slug.startsWith(ext + ':'));

    await window.showDiffModal({
      title: ui("m_b41a35f15207ce89", [oldLabel, newLabel]),
      oldText: data.old_content || '',
      newText: data.new_content || '',
      slug,
      forceRaw: isExtensionDataDiff,
      swalOptions: { confirmButtonText: ui("m_3fd47edce45b3603") },
    });
  } catch (err) {
    Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
  }
}

// ── 리비전 삭제 (소프트/하드 통합) ──
// 일반 admin: 본 함수 호출 시점에 모달은 단순 소프트 삭제 확인.
// super_admin: 모달 내부에 "본문도 영구 삭제" 체크박스. 체크 여부에 따라 hard/soft 분기.
//   - 이미 소프트 삭제된 행이면 체크박스로 영구 삭제까지 진행하도록 안내 (체크 안 하면 no-op).
//   - 부분 실패(isPartial) 상태면 체크박스를 선택+잠금하여 영구 삭제 재시도만 허용.
async function confirmDeleteRevision(slug, revId, pageVersion, isAlreadySoft, isPartial) {
  const versionLabel = (pageVersion !== '' && pageVersion != null) ? `v${pageVersion}` : `#${revId}`;

  // 일반 admin: 체크박스 없는 간단 소프트 삭제 확인.
  if (!canHardDelete) {
    const result = await Swal.fire({
      title: ui("m_7d8260058fe422ef"),
      text: ui("m_65828fbcc4245176", [versionLabel]),
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: ui("m_2f9daa828907b93f"),
      cancelButtonText: ui("m_2cd0f3be8738a86c"),
    });
    if (!result.isConfirmed) return;
    await sendDeleteRequest(slug, revId, /*hard*/ false);
    return;
  }

  // super_admin: 영구 삭제 체크박스 포함 모달.
  const checkboxDefault = isPartial || isAlreadySoft;
  const checkboxDisabled = isPartial; // 재시도 경로에서는 강제로 영구 삭제만 허용.
  const titleText = isPartial
    ? ui("m_1143ee108cac84cf")
    : (isAlreadySoft ? ui("m_cb77b522c19dc9dd") : ui("m_c6a774ece1e50ac1"));
  const explanation = isPartial
    ? ui("m_cb3bf62049f4192e", [window.escapeHtml(versionLabel)])
    : (isAlreadySoft
      ? ui("m_e8a424dc07a20f51", [window.escapeHtml(versionLabel)])
      : ui("m_3f9fe32f92fc75a5", [window.escapeHtml(versionLabel)]));

  const result = await Swal.fire({
    title: titleText,
    icon: 'warning',
    html: ui("m_26f0a091ed320540", [explanation, checkboxDefault ? 'checked' : '', checkboxDisabled ? 'disabled' : '']),
    showCancelButton: true,
    confirmButtonText: ui("m_2f9daa828907b93f"),
    cancelButtonText: ui("m_2cd0f3be8738a86c"),
    preConfirm: () => {
      const cb = document.getElementById('hardDeleteCheck');
      return { hard: !!(cb && cb.checked) };
    },
  });
  if (!result.isConfirmed) return;
  const hard = !!(result.value && result.value.hard);

  if (!hard && isAlreadySoft) {
    // 이미 소프트 삭제된 상태이고 체크박스 미선택 → 의도된 no-op.
    return;
  }
  await sendDeleteRequest(slug, revId, hard);
}

// 실제 삭제 API 호출 + 결과 처리. hard=true → DELETE, false → POST /delete.
async function sendDeleteRequest(slug, revId, hard) {
  try {
    const url = hard
      ? `/api/w/${encodeURIComponent(slug)}/revisions/${revId}`
      : `/api/w/${encodeURIComponent(slug)}/revisions/${revId}/delete`;
    const method = hard ? 'DELETE' : 'POST';
    const res = await fetch(url, { method });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ui("m_5ecf5b24e4da4a1b"));
    const message = hard ? ui("m_049824d2b61335cf") : ui("m_5be274f64b8150aa");
    await Swal.fire({ icon: 'success', title: message, toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
    showRevisions(slug, currentRevPage);
  } catch (err) {
    Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
  }
}

// ── 되돌리기 확인 ──
async function confirmRevert(slug, revId, pageVersion) {
  if (!window.currentUser) {
    Swal.fire(ui("m_6eb1b64e260a2dd3"), ui("m_dc17614c67ea2f96"), 'info');
    return;
  }

  const versionLabel = (pageVersion !== '' && pageVersion != null) ? `v${pageVersion}` : `#${revId}`;
  const result = await Swal.fire({
    title: ui("m_e5bc8d0f4f3faad1"),
    text: ui("m_e9ca8fb1341f434a", [versionLabel]),
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: ui("m_8771e3682df14b36"),
    cancelButtonText: ui("m_2cd0f3be8738a86c")
  });

  if (result.isConfirmed) {
    try {
      const res = await fetch(`/api/w/${encodeURIComponent(slug)}/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision_id: revId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ui("m_b1f4f14b8a91dba1"));

      Swal.fire(ui("m_053461ce86d26572"), ui("m_76f59c47a3a322dd"), 'success').then(() => {
        window.location.href = `/w/${encodeURIComponent(slug)}`;
      });
    } catch (err) {
      Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
    }
  }
}

// HTML onclick 속성에서 호출되므로 window 로 노출한다.
window.toggleRawView = toggleRawView;
window.backToRevisions = backToRevisions;
window.viewRevision = viewRevision;
window.confirmAndShowDiff = confirmAndShowDiff;
window.confirmRevert = confirmRevert;
window.confirmDeleteRevision = confirmDeleteRevision;
window.goToRevPage = goToRevPage;
