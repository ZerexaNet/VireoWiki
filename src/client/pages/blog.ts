// @ts-nocheck — blog.html 인라인 스크립트 이관(동작 보존). common.ts 와 동일 사유로 타입검사 비활성.
//
// 이관 규칙:
//  - common.ts / render.ts 가 window.* 로 노출하는 공통 전역(loadConfig / currentUser /
//    loadTrending / loadRecentChanges / renderWikiContent / appConfig 등)은 모듈 스코프에서
//    bare 식별자로 해석되지 않으므로 모두 window.* 로 접근한다. (특히 `typeof loadTrending`
//    같은 가드도 `typeof window.loadTrending` 로 바꾼다.)
//  - CDN 전역(Swal)은 그대로 둔다.
//  - HTML 의 onclick 속성에서 호출되는 함수(announceBlogPost / unannounceBlogPost /
//    deleteBlogPost / shareNative / shareCopyLink / shareCopyText / shareCopyMarkdown /
//    sharePrint / shareAskClaude / shareAskChatGPT)는 파일 끝에서 window.* 로 노출한다.

import { ui, getLocale } from '../../../packages/wiki-shared/src/i18n/client';
const BLOG_LIST_LIMIT = 20;
let blogCurrentOffset = 0;
let blogTotalCount = 0;
let currentBlogPostId = null;
let currentBlogPost = null;

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(unixTs) {
  const d = new Date(unixTs * 1000);
  return d.toLocaleDateString(getLocale(), { year: 'numeric', month: 'long', day: 'numeric' });
}

function showView(id) {
  ['blogLoading', 'blogList', 'blogPost', 'blogError'].forEach(v => {
    document.getElementById(v).classList.add('d-none');
  });
  document.getElementById(id).classList.remove('d-none');
}

// ── 블로그 목록 로드 ──
async function loadBlogList(offset) {
  blogCurrentOffset = offset || 0;
  // 목록 로드는 전용 로딩 뷰 대신 카드 스켈레톤을 목록 자리에 표시해 레이아웃 점프를 줄인다.
  document.getElementById('blogPostsList').innerHTML = window.uiSkeletonCards(4);
  document.getElementById('blogPagination').innerHTML = '';
  showView('blogList');
  try {
    const res = await fetch(`/api/blog?limit=${BLOG_LIST_LIMIT}&offset=${blogCurrentOffset}`);
    if (!res.ok) throw new Error(ui("m_31173ef0f1720547"));
    const data = await res.json();
    blogTotalCount = data.total || 0;

    const listEl = document.getElementById('blogPostsList');
    if (!data.posts || data.posts.length === 0) {
      listEl.innerHTML = window.uiEmptyState({ icon: 'bi bi-journal-text', title: ui("m_0d4c50e88af7eca4"), text: ui("m_4e808334eb8abe41") });
    } else {
      listEl.innerHTML = data.posts.map(post => `
        <div class="border-bottom pb-3 mb-3 d-flex gap-3 align-items-start ${post.deleted_at ? 'opacity-50' : ''}">
          <div class="flex-grow-1 min-w-0">
            <a href="/blog/${escHtml(post.id)}" class="text-decoration-none">
              <h5 class="mb-1">${escHtml(post.title)}${post.deleted_at ? ui("m_1c831e776367775a") : ''}</h5>
            </a>
            <small class="text-muted">${formatDate(post.created_at)}</small>
          </div>
          ${post.thumbnail ? `<a href="/blog/${escHtml(post.id)}" class="flex-shrink-0">
            <img src="${escHtml(post.thumbnail)}" alt="" loading="lazy"
              style="width:120px;height:80px;object-fit:cover;border-radius:6px;display:block;">
          </a>` : ''}
        </div>
      `).join('');
    }

    // 페이지네이션
    const pagEl = document.getElementById('blogPagination');
    pagEl.innerHTML = '';
    if (blogCurrentOffset > 0) {
      const prevBtn = document.createElement('button');
      prevBtn.className = 'btn btn-secondary btn-sm';
      prevBtn.innerHTML = ui("m_85f202f2c81c4f82");
      prevBtn.onclick = () => loadBlogList(blogCurrentOffset - BLOG_LIST_LIMIT);
      pagEl.appendChild(prevBtn);
    }
    if (blogCurrentOffset + BLOG_LIST_LIMIT < blogTotalCount) {
      const nextBtn = document.createElement('button');
      nextBtn.className = 'btn btn-secondary btn-sm';
      nextBtn.innerHTML = ui("m_6e474e08543a700e");
      nextBtn.onclick = () => loadBlogList(blogCurrentOffset + BLOG_LIST_LIMIT);
      pagEl.appendChild(nextBtn);
    }

    showView('blogList');
    document.title = ui("m_1abe73e9bda9281a") + (window.appConfig?.wikiName || 'CloudWiki');
  } catch (e) {
    Swal.fire(ui("m_0bc1fb72ae1be5c5"), e.message, 'error');
    showView('blogList');
  }
}

// ── 블로그 포스트 열람 ──
async function loadBlogPost(id) {
  showView('blogLoading');
  currentBlogPostId = id;
  try {
    const res = await fetch(`/api/blog/${id}`);
    if (!res.ok) { showView('blogError'); return; }
    const post = await res.json();
    currentBlogPost = post;

    document.getElementById('blogPostTitle').textContent = post.title;
    document.getElementById('blogPostDate').textContent = formatDate(post.created_at);
    document.getElementById('blogPostEditBtn').href = `/blog-edit?id=${post.id}`;
    document.title = escHtml(post.title) + ' - ' + (window.appConfig?.wikiName || 'CloudWiki');

    // 현재 공지 발행 여부 동기화
    syncAnnounceButtons(post.id);

    // 위키 문법 렌더링
    await window.renderWikiContent(post.content || '', post.title, 'blogPostContent', { palettes: post.used_palettes || null });

    showView('blogPost');
  } catch (e) {
    showView('blogError');
  }
}

// ── 공지 발행/취소 ──
function syncAnnounceButtons(postId) {
  const list = Array.isArray(window.appConfig?.announcements) ? window.appConfig.announcements : [];
  const isCurrent = list.some(a => Number(a.postId) === Number(postId));
  const a = document.getElementById('blogPostAnnounceBtn');
  const u = document.getElementById('blogPostUnannounceBtn');
  if (!a || !u) return;
  a.classList.toggle('d-none', isCurrent);
  u.classList.toggle('d-none', !isCurrent);
}

// 공지 발행 다이얼로그 — 제목 + 아이콘 선택 지원
let announceIconClass = null;

async function announceBlogPost() {
  if (!currentBlogPostId) return;
  const defaultTitle = document.getElementById('blogPostTitle')?.textContent?.trim() || '';
  announceIconClass = null;

  const renderIconLabel = (cls) => {
    if (!cls) return ui("m_c9bc06ff14db6aec");
    return `<i class="${cls}"></i> ${cls.replace(/^(mdi mdi-|bi bi-)/, '')}`;
  };

  const result = await Swal.fire({
    title: ui("m_5056b04e6a6b824a"),
    html: ui("m_629e74af9de0752d", [escHtml(defaultTitle), renderIconLabel(null)]),
    showCancelButton: true,
    confirmButtonText: ui("m_65224c8a54f4faa4"),
    cancelButtonText: ui("m_2cd0f3be8738a86c"),
    didOpen: () => {
      const iconBtn = document.getElementById('announceIconBtn');
      const iconLabel = document.getElementById('announceIconLabel');
      const iconClearBtn = document.getElementById('announceIconClearBtn');
      if (iconBtn) iconBtn.addEventListener('click', async () => {
        if (typeof window.pickWikiIcon !== 'function') return;
        const picked = await window.pickWikiIcon();
        announceIconClass = picked;
        if (iconLabel) iconLabel.innerHTML = renderIconLabel(picked);
      });
      if (iconClearBtn) iconClearBtn.addEventListener('click', () => {
        announceIconClass = null;
        if (iconLabel) iconLabel.innerHTML = renderIconLabel(null);
      });
    },
    preConfirm: () => {
      const titleEl = document.getElementById('announceTitleInput');
      const t = (titleEl?.value || '').trim();
      if (!t) { Swal.showValidationMessage(ui("m_80a42fdc93a8b3a3")); return false; }
      if (t.length > 200) { Swal.showValidationMessage(ui("m_402dbf446ebd35a5")); return false; }
      return { title: t, icon: announceIconClass };
    },
  });
  if (!result.isConfirmed) return;

  const { title, icon } = result.value || {};
  try {
    const res = await fetch(`/api/blog/${currentBlogPostId}/announce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, icon: icon || null }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || ui("m_c0fd9a542515c058"));
    }
    Swal.fire({ icon: 'success', title: ui("m_6f7e0546eb7f12ce"), toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
    await window.loadConfig();
    syncAnnounceButtons(currentBlogPostId);
  } catch (e) {
    Swal.fire(ui("m_0bc1fb72ae1be5c5"), e.message, 'error');
  }
}

async function unannounceBlogPost() {
  try {
    const res = await fetch('/api/blog/announcement/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId: currentBlogPostId }),
    });
    if (!res.ok) throw new Error(ui("m_7b257d20332407ea"));
    Swal.fire({ icon: 'success', title: ui("m_cdbf365d344f89c5"), toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
    await window.loadConfig();
    syncAnnounceButtons(currentBlogPostId);
  } catch (e) {
    Swal.fire(ui("m_0bc1fb72ae1be5c5"), e.message, 'error');
  }
}

// ── 블로그 포스트 삭제 ──
async function deleteBlogPost() {
  if (!currentBlogPostId) return;
  const result = await Swal.fire({
    title: ui("m_53b89a297e207095"),
    text: ui("m_45caf5a50992737e"),
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: ui("m_2f9daa828907b93f"),
    cancelButtonText: ui("m_2cd0f3be8738a86c"),
    confirmButtonColor: '#d33',
  });
  if (!result.isConfirmed) return;

  try {
    const res = await fetch(`/api/blog/${currentBlogPostId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || ui("m_c228558cf257fc49"));
    }
    await Swal.fire({ icon: 'success', title: ui("m_977dfc49dbc7d8b2"), timer: 1500, showConfirmButton: false });
    window.location.href = '/blog';
  } catch (e) {
    Swal.fire(ui("m_0bc1fb72ae1be5c5"), e.message, 'error');
  }
}

// ── 블로그 포스트 영구 삭제 (super_admin 전용) ──
async function hardDeleteBlogPost() {
  if (!currentBlogPostId) return;
  const result = await Swal.fire({
    title: ui("m_f92ebe3bee085dd6"),
    html: ui("m_c4f1fd5120a38dbb"),
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: ui("m_4e01a4d26a03423b"),
    cancelButtonText: ui("m_2cd0f3be8738a86c"),
    confirmButtonColor: '#d33',
  });
  if (!result.isConfirmed) return;

  try {
    const res = await fetch(`/api/blog/${currentBlogPostId}?hard=true`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || ui("m_c83214923a9ca5d5"));
    }
    await Swal.fire({ icon: 'success', title: ui("m_4755c64e5ec3dae6"), timer: 1500, showConfirmButton: false });
    window.location.href = '/blog';
  } catch (e) {
    Swal.fire(ui("m_0bc1fb72ae1be5c5"), e.message, 'error');
  }
}

// ── 공유하기 기능 ──
function getShareTitle() {
  return currentBlogPost && currentBlogPost.title ? currentBlogPost.title : document.title;
}

async function shareNative() {
  const cleanUrl = window.location.origin + window.location.pathname;
  const wikiName = typeof window.appConfig !== 'undefined' && window.appConfig.wikiName ? window.appConfig.wikiName : 'CloudWiki';
  const postTitle = getShareTitle();
  try {
    await navigator.share({
      title: `${wikiName} - ${postTitle}`,
      text: `${wikiName} - ${postTitle}`,
      url: cleanUrl
    });
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('공유 실패:', err);
    }
  }
}

async function shareCopyLink() {
  const cleanUrl = window.location.origin + window.location.pathname;
  try {
    await navigator.clipboard.writeText(cleanUrl);
    Swal.fire({ icon: 'success', title: ui("m_92e825d2066bd126"), text: ui("m_42af8fb4ca133c97"), toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
  } catch (err) {
    console.error('복사 실패:', err);
    Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_ec6f40a9e763d7c1"), 'error');
  }
}

async function shareCopyText() {
  const content = document.getElementById('blogPostContent');
  if (!content) return;
  try {
    const postTitle = getShareTitle();
    const textWithTitle = postTitle ? postTitle + '\n' + content.innerText : content.innerText;
    await navigator.clipboard.writeText(textWithTitle);
    Swal.fire({ icon: 'success', title: ui("m_92e825d2066bd126"), text: ui("m_ca858e82212f101b"), toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
  } catch (err) {
    console.error('복사 실패:', err);
    Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_ec6f40a9e763d7c1"), 'error');
  }
}

async function shareCopyMarkdown() {
  if (!currentBlogPost || typeof currentBlogPost.content !== 'string') {
    Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_c32dfb0ed75541d5"), 'error');
    return;
  }
  try {
    let resolvedContent = currentBlogPost.content;
    if (typeof window.resolveTransclusionsForMarkdown === 'function') {
      resolvedContent = await window.resolveTransclusionsForMarkdown(
        currentBlogPost.content,
        currentBlogPost.title || ''
      );
    }
    const postTitle = getShareTitle();
    const markdownWithTitle = postTitle ? postTitle + '\n\n' + resolvedContent : resolvedContent;
    await navigator.clipboard.writeText(markdownWithTitle);
    Swal.fire({ icon: 'success', title: ui("m_92e825d2066bd126"), text: ui("m_384c7951cf63c117"), toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
  } catch (err) {
    console.error('복사 실패:', err);
    Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_ec6f40a9e763d7c1"), 'error');
  }
}

function sharePrint() {
  window.print();
}

function shareAskClaude() {
  const cleanUrl = window.location.origin + window.location.pathname;
  const prompt = ui("m_97a8fd2fa7331f34") + cleanUrl;
  window.open('https://claude.ai/new?q=' + encodeURIComponent(prompt), '_blank');
}

function shareAskChatGPT() {
  const cleanUrl = window.location.origin + window.location.pathname;
  const prompt = ui("m_97a8fd2fa7331f34") + cleanUrl;
  window.open('https://chatgpt.com/?q=' + encodeURIComponent(prompt), '_blank');
}

// ── 초기화 ──
document.addEventListener('DOMContentLoaded', async () => {
  await window.loadConfig();

  // 사이드바: 실시간 트렌딩 / 최근 변경
  if (typeof window.loadTrending === 'function') window.loadTrending();
  if (typeof window.loadRecentChanges === 'function') window.loadRecentChanges();

  // 관리자 UI 표시
  const user = window.currentUser;
  if (user && (user.role === 'admin' || user.role === 'super_admin')) {
    document.getElementById('blogAdminActions').classList.remove('d-none');
    document.getElementById('blogPostAdminActions').classList.remove('d-none');
    // 영구 삭제는 최고 관리자(super_admin) 전용 — 서버도 `*` 권한으로 재검증한다.
    if (user.role === 'super_admin') {
      document.getElementById('blogPostHardDeleteBtn')?.classList.remove('d-none');
    }
  }

  // URL 기반 라우팅
  const match = window.location.pathname.match(/^\/blog\/(\d+)$/);
  if (match) {
    await loadBlogPost(match[1]);
  } else {
    await loadBlogList(0);
  }
});

// HTML onclick 속성에서 호출되므로 window 로 노출한다.
window.announceBlogPost = announceBlogPost;
window.unannounceBlogPost = unannounceBlogPost;
window.deleteBlogPost = deleteBlogPost;
window.hardDeleteBlogPost = hardDeleteBlogPost;
window.shareNative = shareNative;
window.shareCopyLink = shareCopyLink;
window.shareCopyText = shareCopyText;
window.shareCopyMarkdown = shareCopyMarkdown;
window.sharePrint = sharePrint;
window.shareAskClaude = shareAskClaude;
window.shareAskChatGPT = shareAskChatGPT;
