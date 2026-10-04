// @ts-nocheck — tickets.html 인라인 스크립트 이관(동작 보존). common.ts 와 동일 사유로 타입검사 비활성.
//
// 이관 규칙:
//  - common.ts / render.ts / discussion-edit.ts 가 window.* 로 노출하는 공통 전역
//    (loadConfig / checkAuth / currentUser / appConfig / escapeHtml /
//    renderWikiContent / renderUserRoleIcon / initRoleIconPopovers /
//    loadNotificationCount / createMiniEditor)은 모듈 스코프에서 bare 식별자로
//    해석되지 않으므로 모두 window.* 로 접근한다.
//  - CDN 전역(Swal)은 그대로 둔다.
//  - HTML 의 onclick 속성에서 호출되는 함수(showNewTicketForm / filterTickets /
//    applyTypeFilter / loadMoreTickets / submitNewTicket / changeTicketStatus /
//    deleteTicket / deleteComment / startReply / submitComment / cancelReply)는
//    파일 끝에서 window.* 로 노출한다.

    // ── 전역 상태 ──
    import { ui, getLocale } from '../../../packages/wiki-shared/src/i18n/client';
let currentTicketId = null;
    let currentStatusFilter = '';
    let currentTypeFilter = '';
    let currentPage = 1;
    let currentMentionUsers = {};
    // 현재 티켓 참여자(멘션 자동완성 후보). 본인 제외.
    let currentMentionParticipants = [];
    let allTickets = [];

    // 미니 에디터 핸들 (본문/댓글 두 인스턴스)
    let newTicketEditor = null;
    let commentEditor = null;

    /** 미니 에디터 모듈 로드 대기 */
    async function waitForMiniEditor() {
      for (let i = 0; i < 60 && !window.createMiniEditor; i++) {
        await new Promise(r => setTimeout(r, 50));
      }
      return window.createMiniEditor;
    }

    /** 댓글 본문(=한 row)을 컨테이너에 위키 문법으로 렌더. 트랜스클루전/익스텐션/헤딩번호 비활성.
     *  render.js / 그 CDN 의존성이 로드되지 않은 환경에서는 plain-text(+개행)로 폴백해
     *  본문이 사라지지 않도록 한다. */
    async function renderCommentBody(content, containerId) {
      if (!window.renderWikiContent) {
        const el = document.getElementById(containerId);
        if (el) el.innerHTML = window.escapeHtml(content || '').replace(/\n/g, '<br>');
        return;
      }
      await window.renderWikiContent(content || '', null, containerId, {
        skipTransclusion: true,
        skipExtensions: true,
        skipHeadingNumbers: true,
        mentions: currentMentionUsers,
      });
    }

    const typeLabels = {
      general: ui("m_de907d10df98b498"),
      document: ui("m_452c7b10d57a86a7"),
      discussion: ui("m_3cef912ce8819fff"),
      account: ui("m_311bb313fdeca6aa")
    };

    const typeBadgeClasses = {
      general: 'bg-primary',
      document: 'bg-info',
      discussion: 'bg-warning text-dark',
      account: 'bg-dark'
    };

    // ── URL 파싱 ──
    function parseUrl() {
      const path = window.location.pathname;
      // /tickets/:id
      let m = path.match(/^\/tickets\/([0-9]+)$/);
      if (m) return { ticketId: Number(m[1]) };
      // /tickets
      if (path === '/tickets') return { ticketId: null };
      return null;
    }

    // ── 초기화 ──
    document.addEventListener('DOMContentLoaded', async () => {
      await window.loadConfig();
      await window.checkAuth();

      if (!window.currentUser) {
        document.getElementById('loading').classList.add('d-none');
        Swal.fire(ui("m_6eb1b64e260a2dd3"), ui("m_dbaf3b099102c841"), 'info').then(() => {
          window.location.href = '/';
        });
        return;
      }

      const parsed = parseUrl();
      if (!parsed) {
        document.getElementById('loading').classList.add('d-none');
        Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_e0a12b740b1aedad"), 'error');
        return;
      }

      if (parsed.ticketId) {
        showTicketDetail(parsed.ticketId);
      } else {
        showTicketList();
      }
    });

    // ── 유틸리티 ──
    function getRelativeTime(unixTs) {
      const now = Math.floor(Date.now() / 1000);
      const diff = now - unixTs;
      if (diff < 60) return ui("m_de6785d99e028971");
      if (diff < 3600) return ui("m_2f10882d8db32301", [Math.floor(diff / 60)]);
      if (diff < 86400) return ui("m_13d9a4afbbd1b91f", [Math.floor(diff / 3600)]);
      if (diff < 604800) return ui("m_dd30752bcdb324d3", [Math.floor(diff / 86400)]);
      return new Date(unixTs * 1000).toLocaleDateString(getLocale());
    }

    function hideAllPages() {
      document.getElementById('loading').classList.add('d-none');
      document.getElementById('ticketListPage').classList.add('d-none');
      document.getElementById('ticketDetailPage').classList.add('d-none');
    }

    function isAdmin() {
      return window.currentUser && ['admin', 'super_admin'].includes(window.currentUser.role);
    }

    function isManagerOrAbove() {
      return window.currentUser && ['discussion_manager', 'admin', 'super_admin'].includes(window.currentUser.role);
    }

    // ══════════════════════════════════════════
    // ── 티켓 목록 ──
    // ══════════════════════════════════════════
    async function showTicketList() {
      currentPage = 1;
      allTickets = [];

      // 새 문의 버튼 표시 (차단 사용자도 소명용 계정 문의를 작성할 수 있도록 노출)
      if (window.currentUser) {
        document.getElementById('newTicketBtn').classList.remove('d-none');
      }

      // 관리자에게만 유형 필터 표시
      if (isManagerOrAbove()) {
        document.getElementById('typeFilter').classList.remove('d-none');
      }

      await loadTickets(false);

      hideAllPages();
      document.getElementById('newTicketForm').classList.add('d-none');
      document.getElementById('ticketListPage').classList.remove('d-none');
      document.title = ui("m_1866992c52eb8579", [window.appConfig.wikiName]);
    }

    async function loadTickets(append) {
      try {
        let url = `/api/tickets?page=${currentPage}`;
        if (currentStatusFilter) url += `&status=${currentStatusFilter}`;
        if (currentTypeFilter) url += `&type=${currentTypeFilter}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error(ui("m_b257f900207ec26d"));
        const data = await res.json();

        if (append) {
          allTickets = allTickets.concat(data.tickets);
        } else {
          allTickets = data.tickets;
        }

        renderTicketList();

        // 페이지네이션
        const paginationEl = document.getElementById('ticketPagination');
        if (data.hasMore) {
          paginationEl.classList.remove('d-none');
        } else {
          paginationEl.classList.add('d-none');
        }

      } catch (err) {
        console.error(err);
        Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
      }
    }

    function renderTicketList() {
      const listEl = document.getElementById('ticketsList');
      if (!allTickets || allTickets.length === 0) {
        listEl.innerHTML = window.uiEmptyState({ icon: 'bi bi-ticket-perforated', title: ui("m_cea9945ef5953a8d") });
        return;
      }

      listEl.innerHTML = allTickets.map(t => {
        const statusBadge = t.status === 'open'
          ? ui("m_9580dffa5369affc")
          : ui("m_e2d4b1508e527978");
        const typeBadge = `<span class="badge ${typeBadgeClasses[t.type] || 'bg-primary'}">${typeLabels[t.type] || t.type}</span>`;
        const date = getRelativeTime(t.created_at);
        const deletedBadge = t.deleted_at ? ui("m_843692c38e7b788c") : '';

        return ui("m_89534d5a6bfce955", [t.id, statusBadge, typeBadge, deletedBadge, t.id, window.escapeHtml(t.title), window.escapeHtml(t.user_name || ui("m_1ac13841ba2ea68b")), window.renderUserRoleIcon(t.user_role), date, t.comment_count || 0]);
      }).join('');
      window.initRoleIconPopovers(listEl);
    }

    function filterTickets(btn, filterType, value) {
      if (filterType === 'status') {
        btn.closest('.btn-group').querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentStatusFilter = value;
      }
      currentPage = 1;
      allTickets = [];
      loadTickets(false);
    }

    function applyTypeFilter() {
      currentTypeFilter = document.getElementById('typeFilter').value;
      currentPage = 1;
      allTickets = [];
      loadTickets(false);
    }

    function loadMoreTickets() {
      currentPage++;
      loadTickets(true);
    }

    // ── 새 티켓 작성 ──
    async function showNewTicketForm() {
      if (!window.currentUser) {
        Swal.fire(ui("m_6eb1b64e260a2dd3"), ui("m_60e4d8abb7c5c4a3"), 'info');
        return;
      }
      document.getElementById('newTicketForm').classList.remove('d-none');
      document.getElementById('newTicketTitle').value = '';

      // 차단 사용자는 소명(이의제기) 채널로 '계정' 유형만 작성 가능 — 유형 선택을 고정한다.
      const typeSelect = document.getElementById('newTicketType');
      const isBanned = window.currentUser && window.currentUser.role === 'banned';
      const bannedHint = document.getElementById('newTicketBannedHint');
      if (isBanned) {
        typeSelect.value = 'account';
        typeSelect.disabled = true;
        if (bannedHint) bannedHint.classList.remove('d-none');
      } else {
        typeSelect.value = 'general';
        typeSelect.disabled = false;
        if (bannedHint) bannedHint.classList.add('d-none');
      }
      // fallback textarea 도 빈 상태로
      document.getElementById('newTicketContentFallback').value = '';

      // 미니 에디터 lazy-init. 로드 실패 시 fallback textarea 가 보이는 상태로 둠.
      const create = await waitForMiniEditor();
      if (create) {
        const rootEl = document.getElementById('newTicketContent');
        const fallback = document.getElementById('newTicketContentFallback');
        if (!newTicketEditor) {
          try {
            // CM6 로드를 기다리는 동안 사용자가 fallback 에 입력했을 수 있으므로
            // 그 텍스트를 에디터로 옮긴 뒤 fallback 을 숨긴다 (데이터 손실 방지).
            const carryOver = fallback.value;
            newTicketEditor = await create(rootEl, {
              initialValue: carryOver,
              placeholder: ui("m_52a053ce0e3303b0"),
            });
            fallback.classList.add('d-none');
            fallback.value = '';
          } catch (e) {
            console.error('mini editor init failed', e);
            // fallback textarea 가 그대로 보임 — 입력 차단되지 않음
          }
        } else {
          newTicketEditor.setValue('');
        }
      }
      document.getElementById('newTicketTitle').focus();
    }

    /** 미니 에디터 본문, 없으면 fallback textarea 값을 반환 */
    function getNewTicketContent() {
      if (newTicketEditor) return newTicketEditor.getValue();
      return document.getElementById('newTicketContentFallback').value;
    }

    async function submitNewTicket() {
      const title = document.getElementById('newTicketTitle').value.trim();
      const content = getNewTicketContent().trim();
      const type = document.getElementById('newTicketType').value;

      if (!title) { Swal.fire(ui("m_f56c6c82203b33f6"), ui("m_121ab217667e95a2"), 'warning'); return; }
      if (!content) { Swal.fire(ui("m_f56c6c82203b33f6"), ui("m_67645a3be732fd7d"), 'warning'); return; }

      try {
        const res = await fetch('/api/tickets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, content, type })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ui("m_0b5f9634cd06ca6b"));

        Swal.fire(ui("m_053461ce86d26572"), ui("m_ad2ccc6b1b3052a6"), 'success').then(() => {
          window.location.href = `/tickets/${data.id}`;
        });
      } catch (err) {
        Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
      }
    }

    // ══════════════════════════════════════════
    // ── 티켓 상세 ──
    // ══════════════════════════════════════════
    async function showTicketDetail(ticketId) {
      currentTicketId = ticketId;

      try {
        const res = await fetch(`/api/tickets/${ticketId}`);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || ui("m_bdbd94b98af94d96"));
        }
        const data = await res.json();
        const ticket = data.ticket;
        const comments = data.comments;
        currentMentionUsers = data.mention_users || {};

        // 멘션 자동완성 후보: 티켓 작성자 + 댓글 작성자(중복 제거, 본인 제외, 밴/삭제 제외)
        {
          const seen = new Map();
          const addP = (id, name, picture, role) => {
            if (!id || !name) return;
            if (role === 'banned' || role === 'deleted') return;
            if (window.currentUser && id === window.currentUser.id) return;
            if (!seen.has(id)) seen.set(id, { id, name, picture: picture || null });
          };
          addP(ticket.user_id, ticket.user_name, ticket.user_picture, ticket.user_role);
          for (const c of comments) addP(c.author_id, c.author_name, c.author_picture, c.author_role);
          currentMentionParticipants = Array.from(seen.values());
        }

        // 제목
        document.getElementById('ticketTitle').innerHTML =
          `<i class="bi bi-ticket-detailed"></i> #${ticket.id} ${window.escapeHtml(ticket.title)}`;

        // 메타 정보
        const statusBadge = ticket.status === 'open'
          ? ui("m_9580dffa5369affc")
          : ui("m_e2d4b1508e527978");
        const typeBadge = `<span class="badge ${typeBadgeClasses[ticket.type] || 'bg-primary'}">${typeLabels[ticket.type] || ticket.type}</span>`;
        const date = new Date(ticket.created_at * 1000).toLocaleString(getLocale());
        const deletedBadge = ticket.deleted_at ? ui("m_843692c38e7b788c") : '';

        document.getElementById('ticketMeta').innerHTML = ui("m_54759ef1a345b86b", [statusBadge, typeBadge, deletedBadge, window.escapeHtml(ticket.user_name || ui("m_1ac13841ba2ea68b")), window.renderUserRoleIcon(ticket.user_role), date]);
        window.initRoleIconPopovers(document.getElementById('ticketMeta'));

        // 액션 버튼들
        let actionsHtml = '';
        if (window.currentUser) {
          const isAuthor = ticket.user_id === window.currentUser.id;
          const userIsAdmin = isAdmin();
          const isSuperAdmin = window.currentUser.role === 'super_admin';

          if (isAuthor || userIsAdmin) {
            if (ticket.status === 'open') {
              actionsHtml += ui("m_dd2528a0f01ceed8", [ticketId]);
            } else {
              actionsHtml += ui("m_aa71249b21df11aa", [ticketId]);
            }
          }

          if (userIsAdmin && !ticket.deleted_at) {
            actionsHtml += ui("m_2e04391a97ad5042", [ticketId]);
          }

          if (isSuperAdmin) {
            actionsHtml += ui("m_04ed61484dcc0f47", [ticketId]);
          }
        }
        document.getElementById('ticketActions').innerHTML = actionsHtml;

        // 댓글 렌더링
        const commentsEl = document.getElementById('commentsList');
        commentsEl.innerHTML = comments.map(c => renderComment(c, ticket)).join('');
        window.initRoleIconPopovers(commentsEl);

        // 각 댓글 본문에 위키 문법 렌더링 (삭제된 댓글 제외)
        for (const c of comments) {
          if (!c.deleted_at) {
            renderCommentBody(c.content, `ticket-body-${c.id}`);
          }
        }

        // 댓글 폼 표시 여부
        // 차단 사용자는 본인 '계정(소명)' 티켓에 한해 댓글 작성 가능
        const commentFormEl = document.getElementById('commentForm');
        const isBannedUser = window.currentUser && window.currentUser.role === 'banned';
        const bannedCanWrite = window.currentUser && ticket.user_id === window.currentUser.id && ticket.type === 'account';
        if (ticket.status === 'closed' || ticket.deleted_at || !window.currentUser || (isBannedUser && !bannedCanWrite)) {
          commentFormEl.classList.add('d-none');
        } else {
          commentFormEl.classList.remove('d-none');
          // 미니 에디터 lazy-init
          ensureCommentEditor();
        }
        cancelReply();

        hideAllPages();
        document.getElementById('ticketDetailPage').classList.remove('d-none');
        document.title = ui("m_5146d051b6b731b8", [ticket.id, ticket.title, window.appConfig.wikiName]);

        // 해당 티켓 관련 알림 일괄 읽음 처리
        if (window.currentUser) {
          const notifLink = `/tickets/${ticketId}`;
          fetch('/api/notifications/read/by-link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ link: notifLink })
          }).then(res => {
            if (res.ok) window.loadNotificationCount();
          }).catch(() => { });
        }

      } catch (err) {
        console.error(err);
        hideAllPages();
        Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
      }
    }

    function renderComment(c, ticket) {
      const isDeleted = !!c.deleted_at;
      const date = new Date(c.created_at * 1000).toLocaleString(getLocale());

      // 역할 아이콘
      const authorRoleIcon = window.renderUserRoleIcon(c.author_role);

      let quoteHtml = '';
      if (c.parent_id && c.quoted_content) {
        quoteHtml = `
          <div class="discussion-quote">
            <div class="discussion-quote-author"><i class="bi bi-reply"></i> ${window.escapeHtml(c.quoted_author_name || ui("m_1ac13841ba2ea68b"))}:</div>
            <div class="discussion-quote-text">${window.escapeHtml(c.quoted_content || '')}</div>
          </div>
        `;
      }

      // 본문은 위키 렌더링이 비동기이므로 빈 컨테이너만 박아두고 호출자가 별도 렌더.
      let contentHtml;
      if (isDeleted) {
        contentHtml = ui("m_d15600fe57d00775");
      } else {
        contentHtml = '';
      }

      let commentActions = '';
      // 차단 사용자는 본인 '계정(소명)' 티켓에 한해 답글 작성 가능
      const canReplyComment = window.currentUser &&
        (window.currentUser.role !== 'banned' ||
          (ticket.user_id === window.currentUser.id && ticket.type === 'account'));
      if (!isDeleted && canReplyComment && ticket.status === 'open' && !ticket.deleted_at) {
        commentActions += ui("m_572402f7759511c7", [c.id, window.escapeHtml(c.author_name || ui("m_1ac13841ba2ea68b")), window.escapeHtml((c.content || '').substring(0, 100))]);
      }
      if (!isDeleted && window.currentUser) {
        const userIsAdmin = isAdmin();
        const isSuperAdmin = window.currentUser.role === 'super_admin';
        if (userIsAdmin) {
          commentActions += `<button class="btn btn-sm btn-link text-danger" onclick="deleteComment(${c.id}, false)">
            <i class="bi bi-trash"></i>
          </button>`;
        }
        if (isSuperAdmin) {
          commentActions += `<button class="btn btn-sm btn-link text-danger" onclick="deleteComment(${c.id}, true)">
            <i class="bi bi-trash-fill"></i>
          </button>`;
        }
      }

      return `
        <div class="discussion-comment ${isDeleted ? 'discussion-comment-deleted' : ''}" id="comment-${c.id}">
          <div class="discussion-comment-header">
            <span class="discussion-comment-author">
              ${c.author_picture ? `<img src="${c.author_picture}" class="discussion-comment-avatar" alt="" loading="lazy">` : ''}
              ${window.escapeHtml(c.author_name || ui("m_1ac13841ba2ea68b"))}${authorRoleIcon}
            </span>
            <span class="discussion-comment-date text-muted small">${date}</span>
          </div>
          ${quoteHtml}
          <div class="discussion-comment-body wiki-content" id="ticket-body-${c.id}">${contentHtml}</div>
          <div class="discussion-comment-actions">${commentActions}</div>
        </div>
      `;
    }

    // ── 답글 ──
    function startReply(parentId, authorName, preview) {
      document.getElementById('replyParentId').value = parentId;
      const quoteEl = document.getElementById('replyQuote');
      quoteEl.innerHTML = ui("m_84df5ba53c2aae6f", [window.escapeHtml(authorName), window.escapeHtml(preview), preview.length >= 100 ? '...' : '']);
      quoteEl.classList.remove('d-none');
      document.getElementById('cancelReplyBtn').classList.remove('d-none');
      if (commentEditor) {
        commentEditor.focus();
      } else {
        document.getElementById('commentContentFallback').focus();
      }
      document.getElementById('commentForm').scrollIntoView({ behavior: 'smooth' });
    }

    /** 댓글 본문: 미니 에디터가 마운트되었으면 그 값, 아니면 fallback textarea 값 */
    function getCommentContent() {
      if (commentEditor) return commentEditor.getValue();
      return document.getElementById('commentContentFallback').value;
    }
    function clearCommentContent() {
      if (commentEditor) commentEditor.setValue('');
      const fb = document.getElementById('commentContentFallback');
      if (fb) fb.value = '';
    }

    /** 댓글 폼 미니 에디터 lazy-init — 티켓 상세 진입 시 한 번.
     *  이미 초기화되어 있으면 본문만 비운다. 로드/마운트 실패 시 fallback textarea 사용. */
    async function ensureCommentEditor() {
      if (commentEditor) {
        commentEditor.setValue('');
        return;
      }
      const fb = document.getElementById('commentContentFallback');
      if (fb) fb.value = '';

      const create = await waitForMiniEditor();
      if (!create) return;
      const rootEl = document.getElementById('commentContent');
      if (!rootEl) return;
      try {
        // CM6 로드 중 사용자가 fallback 에 입력했을 수 있으므로 그 값을 에디터로 이관.
        const carryOver = fb ? fb.value : '';
        commentEditor = await create(rootEl, {
          initialValue: carryOver,
          placeholder: ui("m_2b00c5e5001419da"),
          getMentionCandidates: () => currentMentionParticipants,
        });
        if (fb) { fb.classList.add('d-none'); fb.value = ''; }
      } catch (e) {
        console.error('mini editor init failed', e);
      }
    }

    function cancelReply() {
      document.getElementById('replyParentId').value = '';
      document.getElementById('replyQuote').classList.add('d-none');
      document.getElementById('cancelReplyBtn').classList.add('d-none');
    }

    async function submitComment() {
      const content = getCommentContent().trim();
      const parentId = document.getElementById('replyParentId').value;

      if (!content) { Swal.fire(ui("m_f56c6c82203b33f6"), ui("m_fb5329841caa622f"), 'warning'); return; }

      try {
        const body = { content };
        if (parentId) body.parent_id = Number(parentId);

        const res = await fetch(`/api/tickets/${currentTicketId}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ui("m_ccf19617f6bcd97c"));

        clearCommentContent();
        cancelReply();
        showTicketDetail(currentTicketId);
      } catch (err) {
        Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
      }
    }

    // ── 티켓 상태 변경 ──
    async function changeTicketStatus(ticketId, status) {
      const label = status === 'closed' ? ui("m_3fd47edce45b3603") : ui("m_f18368c5975d3952");
      const result = await Swal.fire({
        title: ui("m_2cf0a89e778a05e9", [label]),
        text: ui("m_0595e20c83cbcbe0", [label]),
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: label,
        cancelButtonText: ui("m_2cd0f3be8738a86c")
      });

      if (!result.isConfirmed) return;

      try {
        const res = await fetch(`/api/tickets/${ticketId}/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ui("m_3d5ef5f99249355c"));

        showTicketDetail(ticketId);
      } catch (err) {
        Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
      }
    }

    // ── 티켓 삭제 ──
    async function deleteTicket(ticketId, hard) {
      const label = hard ? ui("m_5397333d5562291a") : ui("m_2f9daa828907b93f");
      const result = await Swal.fire({
        title: ui("m_2cf0a89e778a05e9", [label]),
        text: hard ? ui("m_db90d465089098d6") : ui("m_b7fa5351ba888cb8"),
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: label,
        cancelButtonText: ui("m_2cd0f3be8738a86c")
      });

      if (!result.isConfirmed) return;

      try {
        const url = hard
          ? `/api/tickets/${ticketId}/hard`
          : `/api/tickets/${ticketId}`;
        const res = await fetch(url, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ui("m_c228558cf257fc49"));

        Swal.fire(ui("m_077a6d37719a0e21"), ui("m_2d3eef885bbbb868"), 'success').then(() => {
          window.location.href = '/tickets';
        });
      } catch (err) {
        Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
      }
    }

    // ── 댓글 삭제 ──
    async function deleteComment(commentId, hard) {
      const label = hard ? ui("m_41d62abcf8fafc00") : ui("m_2f9daa828907b93f");
      const result = await Swal.fire({
        title: ui("m_ce7bd71253be4191", [label]),
        text: hard ? ui("m_8b1416695c6437b4") : ui("m_1482b30a82762df1"),
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: label,
        cancelButtonText: ui("m_2cd0f3be8738a86c")
      });

      if (!result.isConfirmed) return;

      try {
        const url = hard
          ? `/api/tickets/comment/${commentId}/hard`
          : `/api/tickets/comment/${commentId}`;
        const res = await fetch(url, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ui("m_c228558cf257fc49"));

        showTicketDetail(currentTicketId);
      } catch (err) {
        Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
      }
    }

// ── HTML on* 속성에서 호출되므로 window 로 노출한다. ──
window.showNewTicketForm = showNewTicketForm;
window.filterTickets = filterTickets;
window.applyTypeFilter = applyTypeFilter;
window.loadMoreTickets = loadMoreTickets;
window.submitNewTicket = submitNewTicket;
window.changeTicketStatus = changeTicketStatus;
window.deleteTicket = deleteTicket;
window.deleteComment = deleteComment;
window.startReply = startReply;
window.submitComment = submitComment;
window.cancelReply = cancelReply;
