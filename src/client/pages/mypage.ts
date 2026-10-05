// @ts-nocheck — mypage.html 인라인 스크립트 이관(동작 보존). common.ts 와 동일 사유로 타입검사 비활성.
//
// 이관 규칙:
//  - 이 블록 안에서 function/let/const/var/매개변수로 선언되지 않은 bare 식별자 중
//    CDN/표준 전역(Swal 등)이 아닌 것은 common.ts/render.ts/diff.ts 가 window.* 로
//    노출한 공통 전역이다. 모듈 스코프에서는 bare 로 해석되지 않으므로 window.* 로 접근한다.
//    (loadConfig / checkAuth / currentUser / escapeHtml / showDiffModal / isSafeUrl /
//     loadNotificationCount / viewMessage)
//    특히 `typeof loadNotificationCount === 'function'` 은 모듈 스코프에서 'undefined' 가
//    되므로 `typeof window.loadNotificationCount` 로 바꾼다.
//  - 단, innerHTML 로 생성되는 onclick="viewMessage(...)" 같은 핸들러 문자열은 클릭 시
//    전역 스코프에서 실행되므로 viewMessage(common.ts 전역)는 문자열 안에서 bare 로 둔다.
//  - HTML(정적 + innerHTML)의 on* 속성에서 호출되는, 이 블록에서 정의한 함수
//    (updateName / loadMoreMessages / loadMoreSentMessages / loadMoreMyDiscussions /
//     revokeAllSessions / revokeAllMcpClients / deleteAccount / refreshProfilePicture /
//     deleteDirectMessage / revokeSession / viewSentMessage)는 파일 끝에서 window.* 로 노출한다.

        import { ui, getLocale } from '../../../packages/wiki-shared/src/i18n/client';
document.addEventListener('DOMContentLoaded', async () => {
            await Promise.all([window.loadConfig(), window.checkAuth()]);
            if (!window.currentUser) {
                window.location.href = '/login';
                return;
            }
            renderProfile();
            loadContributions();
            loadWatches();
            loadNotificationsArchive();
            loadMessages();
            loadSentMessages();
            loadMyDiscussions();
            loadMyTickets();
            loadSessions();
            loadMcpClients();
            loadMcpApiKey();
            loadMcpTools();
            loadMcpSubmissions();
            checkNameChangeStatus();
            showPictureUpdateResult();

            // URL hash #mcp-submissions 가 있으면 섹션이 렌더된 뒤 스크롤.
            // 제출안이 없으면 섹션은 끝까지 hidden 으로 남으므로 무한 retry 가 되지 않게 횟수를 제한한다.
            // 약 30 회 × 150ms = 4.5초 — loadMcpSubmissions 의 fetch 가 정상 종료될 시간으로 충분.
            const hashScrollTargets = {
                '#mcp-submissions': 'mcpSubmissionsSection',
                '#notifications': 'notificationsArchiveSection',
            };
            const scrollSectionId = hashScrollTargets[window.location.hash];
            if (scrollSectionId) {
                let scrollRetries = 30;
                const tryScroll = () => {
                    const el = document.getElementById(scrollSectionId);
                    if (el && el.style.display !== 'none') {
                        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        return;
                    }
                    if (--scrollRetries > 0) setTimeout(tryScroll, 150);
                };
                setTimeout(tryScroll, 200);
            }
        });

        function showPictureUpdateResult() {
            const params = new URLSearchParams(window.location.search);
            const updated = params.get('picture_updated');
            const error = params.get('picture_error');
            if (!updated && !error) return;

            // 쿼리 제거 (새로고침 시 다시 뜨는 것 방지)
            const cleanUrl = window.location.pathname + window.location.hash;
            window.history.replaceState({}, '', cleanUrl);

            if (updated === '1') {
                Swal.fire({
                    icon: 'success',
                    title: ui("m_27527e27078055d3"),
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 1500,
                });
                return;
            }

            const errorMessages = {
                provider_not_enabled: ui("m_e1ba9897a57875e1"),
                provider_not_supported: ui("m_cb2c8eb9d217e614"),
                session_mismatch: ui("m_92f4c2c45c2cecf5"),
                account_mismatch: ui("m_da6631fb6e9f5b28"),
                invalid_state: ui("m_c4587d89237f1f7c"),
                user_not_found: ui("m_f273cf8123a33e79"),
                private: ui("m_1e80a9a0d34e0f17"),
            };
            Swal.fire({
                icon: 'error',
                title: ui("m_0c2d48014638d633"),
                text: errorMessages[error] || ui("m_7079d853cfb9f20e"),
            });
        }

        async function refreshProfilePicture() {
            const result = await Swal.fire({
                title: ui("m_8b2608ed69d8ea5b"),
                html: ui("m_62fa0a0e12f24b6f"),
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: ui("m_a996ac181108fe08"),
                cancelButtonText: ui("m_2cd0f3be8738a86c"),
            });
            if (!result.isConfirmed) return;
            window.location.href = '/auth/refresh-picture';
        }

        function renderProfile() {
            const header = document.getElementById('profileHeader');

            let roleBadge = '';
            switch (window.currentUser.role) {
                case 'super_admin':
                    roleBadge = ui("m_a127fef3c25093f2");
                    break;
                case 'admin':
                    roleBadge = ui("m_b4ee5ef4979b6492");
                    break;
                case 'banned':
                    roleBadge = ui("m_c7f888070d8663a4");
                    break;
                default:
                    roleBadge = ui("m_ecaa68da4df83496");
            }

            const joinDate = window.currentUser.created_at
                ? new Date(window.currentUser.created_at * 1000).toLocaleDateString(getLocale(), {
                    year: 'numeric', month: 'long', day: 'numeric'
                })
                : ui("m_1ac13841ba2ea68b");

            const avatarInner = window.currentUser.picture
                ? ui("m_ca7edd9b33f4259e", [window.currentUser.picture])
                : `<div class="profile-avatar-placeholder">${window.escapeHtml(window.currentUser.name.charAt(0))}</div>`;

            // 사진 비공개 상태에서는 공급자 사진 갱신 버튼을 숨긴다(갱신이 서버에서 거부됨).
            const refreshBtn = window.currentUser.picture_private
                ? ''
                : ui("m_f6e3ee80760f5dce");

            const avatarHtml = `
                <div class="profile-avatar-wrap">
                    ${avatarInner}
                    ${refreshBtn}
                </div>
            `;

            header.innerHTML = ui("m_2e19d5cf4fe6fa84", [avatarHtml, window.escapeHtml(window.currentUser.name), roleBadge, window.escapeHtml(window.currentUser.email), joinDate]);

            // 설정 섹션 표시
            document.getElementById('nameInput').value = window.currentUser.name;
            const privToggle = document.getElementById('picturePrivateToggle');
            if (privToggle) privToggle.checked = !!window.currentUser.picture_private;
            // MCP 편집 즉시반영 설정은 wiki:edit 권한자(=MCP 편집 도구 사용 가능)에게만 노출한다.
            const canEditWiki = !!(window.currentUser.permissions && window.currentUser.permissions['wiki:edit']);
            const instantApplyWrap = document.getElementById('mcpInstantApplySetting');
            const instantApplyToggle = document.getElementById('mcpInstantApplyToggle');
            if (instantApplyWrap) instantApplyWrap.style.display = canEditWiki ? '' : 'none';
            if (instantApplyToggle) instantApplyToggle.checked = !!window.currentUser.mcp_instant_apply;
            document.getElementById('settingsSection').style.display = '';
        }

        async function togglePicturePrivacy(el) {
            const makePrivate = !!el.checked;
            el.disabled = true;
            try {
                const res = await fetch('/api/me/picture-privacy', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ private: makePrivate })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || ui("m_b8462c884b380729"));

                window.currentUser.picture_private = data.private ? 1 : 0;
                window.currentUser.picture = data.picture;
                renderProfile();

                Swal.fire({
                    icon: 'success',
                    title: makePrivate ? ui("m_5770c3cfa9135fc2") : ui("m_9a28db229cbd2a2b"),
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 1800,
                });
            } catch (err) {
                el.checked = !makePrivate; // 롤백
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
            } finally {
                el.disabled = false;
            }
        }

        async function toggleMcpInstantApply(el) {
            const enabled = !!el.checked;
            el.disabled = true;
            try {
                const res = await fetch('/api/me/mcp-instant-apply', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || ui("m_b8462c884b380729"));

                window.currentUser.mcp_instant_apply = data.enabled ? 1 : 0;
                // 즉시반영 설정에 따라 apply_edit 노출이 바뀌므로 도구 목록을 다시 불러온다.
                loadMcpTools();

                Swal.fire({
                    icon: 'success',
                    title: enabled ? ui("m_a07962ab43adb597") : ui("m_d539c329fef1d5bf"),
                    text: enabled ? ui("m_d6bd8f8ee6686b2f") : '',
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 2200,
                });
            } catch (err) {
                el.checked = !enabled; // 롤백
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
            } finally {
                el.disabled = false;
            }
        }

        async function loadContributions() {
            try {
                const res = await fetch('/api/me/contributions');
                if (!res.ok) throw new Error();
                const data = await res.json();
                const contributions = data.contributions || [];

                // 통계 표시
                const statsSection = document.getElementById('statsSection');
                statsSection.style.display = '';
                document.getElementById('statCards').innerHTML = ui("m_21032b76eecc4919", [contributions.length]);

                // 기여 목록
                const section = document.getElementById('contributionsSection');
                section.style.display = '';
                const listEl = document.getElementById('contributionsList');

                if (contributions.length === 0) {
                    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-pencil-square', title: ui("m_e0a4e07542721ef4") });
                    return;
                }

                listEl.innerHTML = contributions.map(c => {
                    const date = new Date(c.updated_at * 1000).toLocaleDateString(getLocale());
                    const categoryBadge = c.category
                        ? `<span class="badge bg-secondary ms-1">${window.escapeHtml(c.category)}</span>`
                        : '';
                    return `
                        <div class="contribution-item">
                            <div>
                                <a href="/w/${encodeURIComponent(c.slug)}">${window.escapeHtml(c.slug)}</a>
                                ${categoryBadge}
                            </div>
                            <span class="meta">${date}</span>
                        </div>
                    `;
                }).join('');

            } catch (e) {
                document.getElementById('contributionsList').innerHTML =
                    window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: ui("m_ebaf4022cf1aed6d") });
            }
        }

        // ─── 주시 목록 ───────────────────────────────────────────────────
        async function loadWatches() {
            const pagesSection = document.getElementById('watchedPagesSection');
            const catsSection = document.getElementById('watchedCategoriesSection');
            const pagesList = document.getElementById('watchedPagesList');
            const catsList = document.getElementById('watchedCategoriesList');
            try {
                const res = await fetch('/api/me/watches');
                if (!res.ok) throw new Error();
                const data = await res.json();
                pagesSection.style.display = '';
                catsSection.style.display = '';
                renderWatchedPages(data.pages || []);
                renderWatchedCategories(data.categories || []);
            } catch (e) {
                pagesSection.style.display = '';
                catsSection.style.display = '';
                pagesList.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: ui("m_ebaf4022cf1aed6d") });
                catsList.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: ui("m_ebaf4022cf1aed6d") });
                document.getElementById('watchedPagesCount').textContent = '0';
                document.getElementById('watchedCategoriesCount').textContent = '0';
            }
        }

        function renderWatchedPages(items) {
            const listEl = document.getElementById('watchedPagesList');
            document.getElementById('watchedPagesCount').textContent = String(items.length);

            if (items.length === 0) {
                listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-eye', title: ui("m_38faa1c32a2667e2") });
                return;
            }

            // 슬러그는 사용자 입력이므로 따옴표 등이 포함될 수 있다. 인라인 onclick 핸들러에
            // 문자열로 직접 보간하면 XSS 가 가능하므로 data-* 속성 + addEventListener 패턴을 사용한다.
            listEl.innerHTML = items.map(p => {
                const slug = p.slug;
                const scope = p.scope === 'subtree' ? 'subtree' : 'this';
                const scopeLabel = scope === 'subtree' ? ui("m_3440317c4c2a5ed6") : ui("m_b53a2c7425d91690");
                const scopeBadgeColor = scope === 'subtree' ? 'bg-info text-dark' : 'bg-light text-dark border';
                const otherScope = scope === 'subtree' ? 'this' : 'subtree';
                const switchLabel = scope === 'subtree' ? ui("m_b53a2c7425d91690") : ui("m_3440317c4c2a5ed6");
                const categoryBadge = p.category
                    ? `<span class="badge bg-secondary ms-1">${window.escapeHtml(p.category)}</span>`
                    : '';
                return ui("m_e81f2b4849927a47", [encodeURIComponent(slug), window.escapeHtml(slug), scopeBadgeColor, scopeLabel, categoryBadge, window.escapeHtml(slug), otherScope, switchLabel, window.escapeHtml(slug), scope]);
            }).join('');

            listEl.querySelectorAll('button[data-watch-action]').forEach(btn => {
                btn.addEventListener('click', onWatchedPageAction);
            });
        }

        function renderWatchedCategories(items) {
            const listEl = document.getElementById('watchedCategoriesList');
            document.getElementById('watchedCategoriesCount').textContent = String(items.length);

            if (items.length === 0) {
                listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-folder', title: ui("m_53844de98b375b14") });
                return;
            }

            // 카테고리명도 사용자 입력이므로 동일하게 data-* 속성 패턴을 사용.
            listEl.innerHTML = items.map(c => {
                const cat = c.category;
                const count = Number(c.page_count) || 0;
                return ui("m_06fa2caf0ba9dd0b", [encodeURIComponent(cat), window.escapeHtml(cat), count, window.escapeHtml(cat)]);
            }).join('');

            listEl.querySelectorAll('button[data-watch-action]').forEach(btn => {
                btn.addEventListener('click', onWatchedCategoryAction);
            });
        }

        async function onWatchedPageAction(ev) {
            const btn = ev.currentTarget;
            const action = btn.dataset.watchAction;
            const slug = btn.dataset.slug;
            if (!slug) return;
            if (action === 'change-scope') {
                await changeWatchScope(btn, slug, btn.dataset.targetScope || 'this');
            } else if (action === 'unwatch-page') {
                await unwatchPage(btn, slug, btn.dataset.currentScope || 'this');
            }
        }

        async function onWatchedCategoryAction(ev) {
            const btn = ev.currentTarget;
            if (btn.dataset.watchAction !== 'unwatch-category') return;
            const category = btn.dataset.category;
            if (!category) return;
            await unwatchCategory(btn, category);
        }

        async function changeWatchScope(btn, slug, newScope) {
            btn.disabled = true;
            try {
                const res = await fetch(`/api/w/${encodeURIComponent(slug)}/watch`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ scope: newScope, action: 'set' }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || ui("m_3f8d0f59a303ce72"));
                }
                await loadWatches();
            } catch (err) {
                btn.disabled = false;
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
            }
        }

        async function unwatchPage(btn, slug, currentScope) {
            btn.disabled = true;
            try {
                const res = await fetch(`/api/w/${encodeURIComponent(slug)}/watch`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ scope: currentScope, action: 'toggle' }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || ui("m_4b589d20c184e3ee"));
                }
                await loadWatches();
            } catch (err) {
                btn.disabled = false;
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
            }
        }

        async function unwatchCategory(btn, category) {
            btn.disabled = true;
            try {
                const res = await fetch(`/api/w/category/${encodeURIComponent(category)}/watch`, {
                    method: 'POST',
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || ui("m_713e20aee3f5675b"));
                }
                await loadWatches();
            } catch (err) {
                btn.disabled = false;
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
            }
        }

        // ─── MCP 편집 승인 대기 ──────────────────────────────────────────
        async function loadMcpSubmissions() {
            const listEl = document.getElementById('mcpSubmissionsList');
            const section = document.getElementById('mcpSubmissionsSection');
            const countBadge = document.getElementById('mcpSubmissionsCount');
            try {
                const res = await fetch('/api/mcp-submissions');
                if (!res.ok) throw new Error();
                const data = await res.json();
                const submissions = data.submissions || [];

                // 대기 중인 제출안이 없으면 섹션 자체를 노출하지 않는다 — mypage 가 불필요하게 길어지지 않도록.
                if (submissions.length === 0) {
                    section.style.display = 'none';
                    return;
                }
                section.style.display = '';
                countBadge.textContent = String(submissions.length);

                listEl.innerHTML = '';
                for (const s of submissions) {
                    listEl.appendChild(buildMcpSubmissionItem(s));
                }
            } catch (e) {
                section.style.display = '';
                listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: ui("m_ebaf4022cf1aed6d") });
            }
        }

        function buildMcpSubmissionItem(s) {
            const wrap = document.createElement('div');
            wrap.className = 'mcp-submission-item' + (s.has_conflict ? ' has-conflict' : '');

            const head = document.createElement('div');
            head.className = 'mcp-sub-head';
            const slugLink = document.createElement('a');
            slugLink.className = 'mcp-sub-slug';
            slugLink.href = '/w/' + encodeURIComponent(s.slug);
            slugLink.textContent = s.slug;
            const actionBadge = document.createElement('span');
            actionBadge.className = 'badge ' + (s.action === 'create' ? 'bg-success' : 'bg-info text-dark');
            actionBadge.textContent = s.action === 'create' ? ui("m_113ce17492d363d2") : ui("m_051836569928a9f9");
            head.appendChild(slugLink);
            head.appendChild(actionBadge);
            if (s.has_conflict) {
                const conflictBadge = document.createElement('span');
                conflictBadge.className = 'badge bg-danger';
                conflictBadge.textContent = s.conflict_reason === 'slug_taken' ? ui("m_0f16f08ba66b3989")
                    : s.conflict_reason === 'slug_soft_deleted' ? ui("m_f1f9331cfbe8cf01")
                    : s.conflict_reason === 'page_missing' ? ui("m_b82ac026ddfc7c58")
                    : ui("m_b4ad5e963ae1e64d");
                head.appendChild(conflictBadge);
            }
            wrap.appendChild(head);

            if (s.submitted_summary) {
                const summary = document.createElement('div');
                summary.className = 'mcp-sub-summary';
                summary.textContent = s.submitted_summary;
                wrap.appendChild(summary);
            }

            const meta = document.createElement('div');
            meta.className = 'mcp-sub-meta';
            const ts = s.submitted_at ? new Date(s.submitted_at).toLocaleString(getLocale()) : '';
            meta.textContent = ui("m_3fd1d3d9c3c591d5", [ts, s.content_length]);
            wrap.appendChild(meta);

            const actions = document.createElement('div');
            actions.className = 'mcp-sub-actions';
            const reviewBtn = document.createElement('button');
            reviewBtn.className = 'btn btn-sm btn-wiki';
            reviewBtn.innerHTML = ui("m_56334feebefd2537");
            reviewBtn.addEventListener('click', () => openMcpSubmissionReview(s.id));
            actions.appendChild(reviewBtn);

            // 에디터에서 직접 편집/저장. 충돌이 없으면 제출안 본문이 적재된 채로 일반 편집,
            // concurrent_modification 충돌은 3-way merge UI 로 진입한다.
            // page_missing / slug_taken / slug_soft_deleted 는 에디터에서 처리할 수 없으므로 노출하지 않는다.
            // (slug_taken 은 create 액션 한정 — update 액션에서는 발생하지 않으므로 같이 가려도 무방하다.)
            const canEditInEditor = !s.has_conflict || s.conflict_reason === 'concurrent_modification';
            if (canEditInEditor) {
                const editBtn = document.createElement('button');
                editBtn.className = s.conflict_reason === 'concurrent_modification'
                    ? 'btn btn-sm btn-wiki'
                    : 'btn btn-sm btn-wiki-outline';
                editBtn.innerHTML = s.conflict_reason === 'concurrent_modification'
                    ? ui("m_0873e5ce68261ba4")
                    : ui("m_8882a651a6d49663");
                editBtn.title = ui("m_a93f1bed839b31cb");
                editBtn.addEventListener('click', () => openMcpSubmissionInEditor(s.id, s.slug));
                actions.appendChild(editBtn);
            }

            const rejectBtn = document.createElement('button');
            rejectBtn.className = 'btn btn-sm btn-wiki btn-wiki-danger';
            rejectBtn.innerHTML = ui("m_cfb90109c73a9311");
            rejectBtn.addEventListener('click', () => rejectMcpSubmission(s.id, s.slug));
            actions.appendChild(rejectBtn);

            wrap.appendChild(actions);
            return wrap;
        }

        async function openMcpSubmissionReview(id) {
            let detail;
            try {
                const res = await fetch('/api/mcp-submissions/' + encodeURIComponent(id));
                if (!res.ok) {
                    const errBody = await res.json().catch(() => ({}));
                    Swal.fire(ui("m_0bc1fb72ae1be5c5"), errBody.error || ui("m_42301e79a8372937"), 'error');
                    return;
                }
                detail = await res.json();
            } catch {
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_0dd9df5c73a87e5c"), 'error');
                return;
            }

            // 동시 편집 충돌(concurrent_modification, action=update) 은 에디터에서 3-way merge UI 로
            // 직접 해결할 수 있다 — 그 외 충돌(슬러그 점거/소프트삭제/페이지 사라짐) 은 에디터에서 다룰 수 없다.
            const canMergeInEditor = detail.has_conflict
                && detail.action === 'update'
                && detail.conflict_reason === 'concurrent_modification';
            const conflictBanner = detail.has_conflict
                ? `<div class="alert alert-danger py-2 mb-2 text-start"><i class="mdi mdi-alert"></i> ${
                    detail.conflict_reason === 'slug_taken' ? ui("m_d3c771fe1631cf1b")
                    : detail.conflict_reason === 'slug_soft_deleted' ? ui("m_e8ed0feee864094d")
                    : detail.conflict_reason === 'page_missing' ? ui("m_67fcb7d30055dcde")
                    : ui("m_8a1cc747cadace6e")
                  }</div>`
                : '';
            const ts = detail.submitted_at ? new Date(detail.submitted_at).toLocaleString(getLocale()) : '';
            const summaryDefault = detail.submitted_summary || '';

            // 슬러그가 익스텐션 데이터 네임스페이스(예: freq:foo) 면 렌더링 비교가 무의미.
            // revisions.html 의 showDiff 와 동일한 정책을 적용한다.
            const enabledExts = (window.appConfig && window.appConfig.enabledExtensions) || [];
            const isExtensionDataDiff = enabledExts.some((ext) => detail.slug.startsWith(ext + ':'));

            const extraTopHtml = ui("m_ac1576c5439edba3", [conflictBanner, window.escapeHtml(detail.slug), detail.action === 'create' ? ui("m_113ce17492d363d2") : ui("m_051836569928a9f9"), window.escapeHtml(ts), detail.lines_added, detail.lines_removed, window.escapeHtml(summaryDefault)]);

            const result = await window.showDiffModal({
                title: ui("m_5813fcb389c06a44"),
                oldText: detail.current_content || '',
                newText: detail.proposed_content || '',
                slug: detail.slug,
                forceRaw: isExtensionDataDiff,
                width: '1100px',
                extraTopHtml,
                swalOptions: {
                    showCancelButton: true,
                    showDenyButton: true,
                    // 동시 편집 충돌인 경우 그대로 승인하면 다른 사용자 변경을 덮어쓰므로,
                    // 승인 버튼을 「에디터에서 해결」로 바꿔 3-way merge 화면으로 유도한다.
                    confirmButtonText: canMergeInEditor
                        ? ui("m_0873e5ce68261ba4")
                        : ui("m_9b032ce01b0808b9"),
                    denyButtonText: ui("m_cfb90109c73a9311"),
                    cancelButtonText: ui("m_3fd47edce45b3603"),
                    confirmButtonColor: canMergeInEditor ? '#F59E0B' : '#10B981',
                    denyButtonColor: '#EF4444',
                    preConfirm: () => {
                        const input = document.getElementById('mcpApproveSummary');
                        return { summary: input ? input.value : '' };
                    },
                },
            });

            if (result.isConfirmed) {
                if (canMergeInEditor) {
                    openMcpSubmissionInEditor(id, detail.slug);
                } else {
                    await approveMcpSubmission(id, result.value && result.value.summary);
                }
            } else if (result.isDenied) {
                await rejectMcpSubmission(id, detail.slug);
            }
        }

        function openMcpSubmissionInEditor(id, slug) {
            // edit.html 에서 ?mcp_submission= 을 보면 제출안 본문을 에디터에 적재한다.
            // concurrent_modification 충돌이면 base/ours/theirs 3-way merge 모달까지 자동으로 띄우고,
            // 충돌이 없으면 그대로 일반 편집/저장 흐름이다 (src/client/edit/main.ts).
            const url = '/edit?slug=' + encodeURIComponent(slug) + '&mcp_submission=' + encodeURIComponent(id);
            window.location.href = url;
        }

        async function approveMcpSubmission(id, summary) {
            try {
                const res = await fetch('/api/mcp-submissions/' + encodeURIComponent(id) + '/approve', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ summary }),
                });
                const data = await res.json();
                if (!res.ok) {
                    const msg = data.error === 'conflict'
                        ? ui("m_6d593e06013994c1")
                        : (data.message || data.error || ui("m_005c43cba2f22464"));
                    Swal.fire(ui("m_005c43cba2f22464"), msg, 'error');
                    return;
                }
                await Swal.fire({
                    icon: 'success',
                    title: ui("m_0b9b1dc8130ee7de"),
                    text: ui("m_ab36cd5ee239f175", [data.revision_id, data.lines_added ?? 0, data.lines_removed ?? 0]),
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 2500,
                });
                loadMcpSubmissions();
            } catch {
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_0dd9df5c73a87e5c"), 'error');
            }
        }

        async function rejectMcpSubmission(id, slug) {
            const confirmRes = await Swal.fire({
                icon: 'warning',
                title: ui("m_bbc536913a14a61f"),
                text: ui("m_264ea9502c77e770", [slug]),
                showCancelButton: true,
                confirmButtonText: ui("m_e3ecc00b93afe368"),
                cancelButtonText: ui("m_2cd0f3be8738a86c"),
                confirmButtonColor: '#EF4444',
            });
            if (!confirmRes.isConfirmed) return;
            try {
                const res = await fetch('/api/mcp-submissions/' + encodeURIComponent(id) + '/reject', { method: 'POST' });
                if (!res.ok) {
                    const errBody = await res.json().catch(() => ({}));
                    Swal.fire(ui("m_f391645de813e345"), errBody.error || ui("m_917ad64954223a05"), 'error');
                    return;
                }
                loadMcpSubmissions();
            } catch {
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_0dd9df5c73a87e5c"), 'error');
            }
        }

        // (편집 요청 검토 UI 는 문서 열람 페이지로 이전됨 — index.ts 의 편집 버튼 배지/드롭다운 참조)

        async function updateName() {
            const name = document.getElementById('nameInput').value.trim();
            if (!name) {
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_b6c1c96c52ea9de7"), 'warning');
                return;
            }
            if (name.length > 20) {
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_404a4c8ee516dfa1"), 'warning');
                return;
            }

            try {
                const res = await fetch('/api/me/profile', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || ui("m_b8462c884b380729"));

                window.currentUser.name = data.name;
                renderProfile();
                checkNameChangeStatus();

                Swal.fire({
                    icon: 'success',
                    title: ui("m_055bf1362f032041"),
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 1500
                });
            } catch (err) {
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
            }
        }

        async function checkNameChangeStatus() {
            try {
                const res = await fetch('/api/me/namechange-status');
                if (!res.ok) return;
                const data = await res.json();

                const btn = document.getElementById('nameChangeBtn');
                const input = document.getElementById('nameInput');
                const statusEl = document.getElementById('nameChangeStatus');
                const hintEl = document.getElementById('nameChangeHint');

                if (!data.allowed) {
                    btn.disabled = true;
                    input.disabled = true;

                    if (data.reason === 'disabled') {
                        statusEl.innerHTML = ui("m_c5be42bbabe606e9");
                        hintEl.style.display = 'none';
                    } else if (data.reason === 'cooldown') {
                        statusEl.innerHTML = `<div class="alert alert-warning py-2 mb-0"><i class="mdi mdi-clock-outline"></i> ${window.escapeHtml(data.message)}</div>`;
                    }
                    statusEl.style.display = '';
                } else {
                    btn.disabled = false;
                    input.disabled = false;
                    statusEl.style.display = 'none';
                    hintEl.style.display = '';

                    if (data.reason === 'first_change') {
                        hintEl.textContent = ui("m_469d5cd4d84d77a3");
                    } else {
                        hintEl.textContent = ui("m_8b0b4eb495c40277");
                    }
                }
            } catch (e) {
                // 조회 실패 시 기본 상태 유지
            }
        }

        let currentMessageOffset = 0;
        const MESSAGE_LIMIT = 10;

        async function loadMessages(isLoadMore = false) {
            if (!isLoadMore) {
                currentMessageOffset = 0;
            }

            try {
                const res = await fetch(`/api/messages?offset=${currentMessageOffset}&limit=${MESSAGE_LIMIT}`);
                if (!res.ok) throw new Error();
                const data = await res.json();
                const messages = data.messages || [];

                const section = document.getElementById('messagesSection');
                section.style.display = '';
                const listEl = document.getElementById('messagesList');
                const loadMoreBtn = document.getElementById('loadMoreMessagesBtn');

                if (!isLoadMore && messages.length === 0) {
                    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'mdi mdi-inbox-outline', title: ui("m_1a7e1616e9df4ae3") });
                    loadMoreBtn.classList.add('d-none');
                    return;
                }

                if (!isLoadMore) {
                    listEl.innerHTML = '';
                }

                listEl.insertAdjacentHTML('beforeend', messages.map(m => {
                    const date = new Date(m.created_at * 1000).toLocaleString(getLocale());
                    // title 형식으로 조금 잘라서 보여주기
                    const preview = m.content.length > 50 ? window.escapeHtml(m.content.substring(0, 50)) + '...' : window.escapeHtml(m.content);
                    const senderName = m.sender_name || ui("m_1ac13841ba2ea68b");

                    return ui("m_c89bc3f1b9ffced1", [m.id, window.escapeHtml(senderName), preview, date, m.id]);
                }).join(''));

                currentMessageOffset += messages.length;

                if (data.has_more) {
                    loadMoreBtn.classList.remove('d-none');
                } else {
                    loadMoreBtn.classList.add('d-none');
                }

            } catch (e) {
                if (!isLoadMore) {
                    document.getElementById('messagesList').innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: ui("m_33efeadc734eb293") });
                }
            }
        }

        async function loadMoreMessages() {
            const btn = document.getElementById('loadMoreMessagesBtn');
            btn.disabled = true;
            btn.innerHTML = window.uiInlineLoading();
            await loadMessages(true);
            btn.disabled = false;
            btn.innerHTML = ui("m_35180a50cfb0bb39");
        }

        // ── 알림 보관함 (마이페이지) ──
        const NOTIF_ARCHIVE_LIMIT = 20;
        let currentNotifArchiveOffset = 0;
        let notifArchiveDelegated = false;

        const NOTIF_ICON_MAP = {
            'discussion_comment': 'mdi mdi-comment-text-outline',
            'banned': 'mdi mdi-block-helper',
            'message': 'mdi mdi-email-outline',
            'ticket_created': 'mdi mdi-ticket-outline',
            'ticket_comment': 'mdi mdi-ticket-confirmation-outline',
            'pending_edit': 'mdi mdi-clock-edit-outline',
            'pending_edit_result': 'mdi mdi-pencil-outline',
        };

        async function loadNotificationsArchive(isLoadMore = false) {
            if (!isLoadMore) currentNotifArchiveOffset = 0;
            const section = document.getElementById('notificationsArchiveSection');
            const listEl = document.getElementById('notificationsArchiveList');
            const loadMoreBtn = document.getElementById('loadMoreNotifArchiveBtn');
            const unreadBadge = document.getElementById('notifArchiveUnreadBadge');
            if (!section || !listEl) return;

            try {
                const res = await fetch(`/api/notifications?offset=${currentNotifArchiveOffset}&limit=${NOTIF_ARCHIVE_LIMIT}`);
                if (!res.ok) throw new Error();
                const data = await res.json();
                const notifs = data.notifications || [];
                section.style.display = '';

                if (!isLoadMore && notifs.length === 0) {
                    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'mdi mdi-inbox-outline', title: ui("m_7ec6dc05f7203e73") });
                    loadMoreBtn?.classList.add('d-none');
                    if (unreadBadge) unreadBadge.classList.add('d-none');
                    return;
                }

                if (!isLoadMore) listEl.innerHTML = '';

                listEl.insertAdjacentHTML('beforeend', notifs.map(n => {
                    const icon = NOTIF_ICON_MAP[n.type] || 'mdi mdi-bell';
                    const date = new Date(n.created_at * 1000).toLocaleString(getLocale());
                    const unreadCls = n.read_at ? '' : ' unread';
                    return ui("m_a9497d89783fa535", [unreadCls, window.escapeHtml(String(n.id)), window.escapeHtml(n.type), window.escapeHtml(String(n.ref_id || '')), window.escapeHtml(n.link || ''), icon, window.escapeHtml(n.content), date, window.escapeHtml(String(n.id))]);
                }).join(''));

                currentNotifArchiveOffset += notifs.length;
                if (data.has_more) loadMoreBtn?.classList.remove('d-none');
                else loadMoreBtn?.classList.add('d-none');

                // 안 읽은 알림 배지 동기화
                if (unreadBadge) {
                    try {
                        const cntRes = await fetch('/api/notifications/count');
                        const cntData = cntRes.ok ? await cntRes.json() : { count: 0 };
                        const cnt = Number(cntData.count) || 0;
                        if (cnt > 0) {
                            unreadBadge.textContent = cnt > 99 ? '99+' : String(cnt);
                            unreadBadge.classList.remove('d-none');
                        } else {
                            unreadBadge.classList.add('d-none');
                        }
                    } catch (_) { /* 무시 */ }
                }

                if (!notifArchiveDelegated) {
                    notifArchiveDelegated = true;
                    listEl.addEventListener('click', (e) => {
                        const delBtn = e.target.closest('[data-notif-delete]');
                        if (delBtn) {
                            e.stopPropagation();
                            deleteNotificationArchiveItem(parseInt(delBtn.dataset.notifDelete, 10));
                            return;
                        }
                        const item = e.target.closest('[data-notif-id]');
                        if (item) openNotificationArchiveItem(item);
                    });
                }
            } catch (e) {
                section.style.display = '';
                if (!isLoadMore) {
                    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: ui("m_56e9d4367bc59f2e") });
                }
            }
        }

        function openNotificationArchiveItem(item) {
            const id = parseInt(item.dataset.notifId, 10);
            const type = item.dataset.notifType;
            const refId = item.dataset.notifRef ? parseInt(item.dataset.notifRef, 10) : null;
            const link = item.dataset.notifLink || null;

            // 읽음 처리 (백그라운드)
            if (item.classList.contains('unread')) {
                fetch(`/api/notifications/${id}/read`, { method: 'POST' }).then(() => {
                    item.classList.remove('unread');
                    if (typeof window.loadNotificationCount === 'function') window.loadNotificationCount();
                    syncNotifArchiveUnreadBadge();
                }).catch(() => { /* 무시 */ });
            }

            if (type === 'message' && refId) {
                window.viewMessage(refId);
            } else if (link && link !== 'null' && window.isSafeUrl(link)) {
                window.location.href = link;
            }
        }

        async function syncNotifArchiveUnreadBadge() {
            const unreadBadge = document.getElementById('notifArchiveUnreadBadge');
            if (!unreadBadge) return;
            try {
                const res = await fetch('/api/notifications/count');
                const data = res.ok ? await res.json() : { count: 0 };
                const cnt = Number(data.count) || 0;
                if (cnt > 0) {
                    unreadBadge.textContent = cnt > 99 ? '99+' : String(cnt);
                    unreadBadge.classList.remove('d-none');
                } else {
                    unreadBadge.classList.add('d-none');
                }
            } catch (_) { /* 무시 */ }
        }

        async function loadMoreNotificationsArchive() {
            const btn = document.getElementById('loadMoreNotifArchiveBtn');
            if (btn) { btn.disabled = true; btn.innerHTML = window.uiInlineLoading(); }
            await loadNotificationsArchive(true);
            if (btn) { btn.disabled = false; btn.innerHTML = ui("m_35180a50cfb0bb39"); }
        }

        async function deleteNotificationArchiveItem(id) {
            const numId = parseInt(id, 10);
            if (isNaN(numId)) return;
            try {
                const res = await fetch(`/api/notifications/${numId}`, { method: 'DELETE' });
                if (!res.ok) throw new Error();
                await loadNotificationsArchive();
                if (typeof window.loadNotificationCount === 'function') window.loadNotificationCount();
            } catch (e) {
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_b9dfeed9394b41c2"), 'error');
            }
        }

        async function markAllNotificationsReadArchive() {
            try {
                const res = await fetch('/api/notifications/read-all', { method: 'POST' });
                if (!res.ok) throw new Error();
                await loadNotificationsArchive();
                if (typeof window.loadNotificationCount === 'function') window.loadNotificationCount();
            } catch (e) {
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_f8abee26e0bf27ae"), 'error');
            }
        }

        async function deleteAllNotificationsArchive() {
            const result = await Swal.fire({
                title: ui("m_22abbed26f07b173"),
                text: ui("m_565173fe1c3d528e"),
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#dc3545',
                confirmButtonText: ui("m_9b2ccbb48e31d52a"),
                cancelButtonText: ui("m_2cd0f3be8738a86c"),
            });
            if (!result.isConfirmed) return;
            try {
                const res = await fetch('/api/notifications', { method: 'DELETE' });
                if (!res.ok) throw new Error();
                await loadNotificationsArchive();
                if (typeof window.loadNotificationCount === 'function') window.loadNotificationCount();
            } catch (e) {
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_b9dfeed9394b41c2"), 'error');
            }
        }

        async function deleteAccount() {
            const result = await Swal.fire({
                title: ui("m_2147f510237d8c4c"),
                html: ui("m_8db08afcb1258696"),
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#cf222e',
                confirmButtonText: ui("m_958ece350af5369a"),
                cancelButtonText: ui("m_2cd0f3be8738a86c"),
                input: 'text',
                inputPlaceholder: ui("m_72acf585a2071c4a"),
                inputValidator: (value) => {
                    if (value !== ui("m_958ece350af5369a")) {
                        return ui("m_ecb7473079d9fd5c");
                    }
                }
            });

            if (result.isConfirmed) {
                try {
                    const res = await fetch('/api/me/account', { method: 'DELETE' });
                    if (!res.ok) {
                        const data = await res.json();
                        throw new Error(data.error || ui("m_bd8278edb6ef160b"));
                    }
                    await Swal.fire({
                        icon: 'success',
                        title: ui("m_c3598be33bfa98e2"),
                        showConfirmButton: false,
                        timer: 2000
                    });
                    window.location.href = '/';
                } catch (err) {
                    Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
                }
            }
        }

        function summarizeUserAgent(ua) {
            if (!ua) return { label: ui("m_e30cf08f01887d26"), icon: 'mdi-help-circle-outline' };
            const s = ua;

            let os = ui("m_3142225dcaaaeeaf");
            if (/Windows NT 10\.0/.test(s)) os = 'Windows 10/11';
            else if (/Windows NT/.test(s)) os = 'Windows';
            else if (/Android/.test(s)) os = 'Android';
            else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
            else if (/Mac OS X/.test(s)) os = 'macOS';
            else if (/Linux/.test(s)) os = 'Linux';

            let browser = ui("m_9641023ed5efef93");
            if (/Edg\//.test(s)) browser = 'Edge';
            else if (/OPR\//.test(s)) browser = 'Opera';
            else if (/Chrome\//.test(s) && !/Chromium/.test(s)) browser = 'Chrome';
            else if (/Firefox\//.test(s)) browser = 'Firefox';
            else if (/Safari\//.test(s) && !/Chrome\//.test(s)) browser = 'Safari';

            let icon = 'mdi-monitor';
            if (/Mobile|Android|iPhone|iPod/.test(s)) icon = 'mdi-cellphone';
            else if (/iPad|Tablet/.test(s)) icon = 'mdi-tablet';

            return { label: `${browser} · ${os}`, icon };
        }

        async function loadSessions() {
            const section = document.getElementById('sessionsSection');
            const listEl = document.getElementById('sessionsList');
            try {
                const res = await fetch('/api/me/sessions');
                if (!res.ok) throw new Error();
                const data = await res.json();
                const sessions = data.sessions || [];

                section.style.display = '';

                if (sessions.length === 0) {
                    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-shield-lock', title: ui("m_b186ecaf2c743610") });
                    return;
                }

                const hasOthers = sessions.some(s => !s.current);
                document.getElementById('revokeAllSessionsBtn').disabled = !hasOthers;

                listEl.innerHTML = sessions.map(s => {
                    const info = summarizeUserAgent(s.user_agent);
                    const created = s.created_at
                        ? new Date(s.created_at * 1000).toLocaleString(getLocale())
                        : ui("m_1ac13841ba2ea68b");
                    const expires = s.expires_at
                        ? new Date(s.expires_at * 1000).toLocaleString(getLocale())
                        : ui("m_1ac13841ba2ea68b");
                    const currentBadge = s.current
                        ? ui("m_29fdb31b1e452aa6")
                        : '';
                    const action = s.current
                        ? ui("m_c2118b28d5065c33")
                        : ui("m_83f84bccf8d92120", [encodeURIComponent(s.id)]);
                    const uaRaw = s.user_agent
                        ? `<div class="session-ua-raw">${window.escapeHtml(s.user_agent)}</div>`
                        : ui("m_9dfd8a5de2861a42");

                    return ui("m_202deb88e53c152b", [s.current ? 'current' : '', info.icon, window.escapeHtml(info.label), currentBadge, uaRaw, created, expires, action]);
                }).join('');
            } catch (e) {
                section.style.display = '';
                listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: ui("m_60b41aea9afe9c82") });
            }
        }

        async function revokeSession(encodedId) {
            const id = decodeURIComponent(encodedId);
            const result = await Swal.fire({
                title: ui("m_8ec2cbebcc9cc4f6"),
                text: ui("m_1de7a3190bf39881"),
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#cf222e',
                confirmButtonText: ui("m_086bb5335d174a9a"),
                cancelButtonText: ui("m_2cd0f3be8738a86c"),
            });
            if (!result.isConfirmed) return;

            try {
                const res = await fetch(`/api/me/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || ui("m_ad5dc76c902c2b3f"));

                Swal.fire({ icon: 'success', title: ui("m_13fd3a417559e343"), toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
                loadSessions();
            } catch (err) {
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
            }
        }

        async function revokeAllSessions() {
            const result = await Swal.fire({
                title: ui("m_6149b21806576267"),
                text: ui("m_2ed8bd42b9302cc0"),
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#cf222e',
                confirmButtonText: ui("m_25f4a04d23374c3e"),
                cancelButtonText: ui("m_2cd0f3be8738a86c"),
            });
            if (!result.isConfirmed) return;

            try {
                const res = await fetch('/api/me/sessions', { method: 'DELETE' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || ui("m_ad5dc76c902c2b3f"));

                Swal.fire({
                    icon: 'success',
                    title: ui("m_94349b07c0c4fa72", [data.count || 0]),
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 1500,
                });
                loadSessions();
            } catch (err) {
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
            }
        }

        function formatMcpTime(epochSec) {
            if (!epochSec) return ui("m_1ac13841ba2ea68b");
            return new Date(epochSec * 1000).toLocaleString(getLocale());
        }

        function formatMcpRelative(epochSec) {
            if (!epochSec) return ui("m_72ea3d64ace5bc94");
            const diff = Math.floor(Date.now() / 1000) - epochSec;
            if (diff < 60) return ui("m_de6785d99e028971");
            if (diff < 3600) return ui("m_2f10882d8db32301", [Math.floor(diff / 60)]);
            if (diff < 86400) return ui("m_13d9a4afbbd1b91f", [Math.floor(diff / 3600)]);
            if (diff < 86400 * 30) return ui("m_dd30752bcdb324d3", [Math.floor(diff / 86400)]);
            return new Date(epochSec * 1000).toLocaleDateString(getLocale());
        }

        async function loadMcpClients() {
            const section = document.getElementById('wikiMcpSection');
            const listEl = document.getElementById('mcpClientsList');
            if (!section || !listEl) return;

            const tokenContainer = document.getElementById('mcpApiKeyContainer');
            if (tokenContainer && !document.getElementById('personalApiTokenLink')) {
                const link = document.createElement('a'); link.id = 'personalApiTokenLink';
                link.href = '/tokens'; link.className = 'btn btn-outline-wiki mb-3';
                link.textContent = ui('tokens.title'); tokenContainer.before(link);
            }
            // 위키 MCP 엔드포인트 URL 및 API 키 JSON 스니펫 세팅 (origin + /api/mcp)
            const wikiEndpointEl = document.getElementById('wikiMcpEndpointUrl');
            if (wikiEndpointEl) wikiEndpointEl.textContent = window.location.origin + '/api/mcp';

            const jsonSnippetEl = document.getElementById('mcpApiKeyJsonSnippet');
            if (jsonSnippetEl) {
                const endpoint = window.location.origin + '/api/mcp';
                jsonSnippetEl.textContent = JSON.stringify({
                    mcpServers: {
                        cloudwiki: {
                            url: endpoint,
                            headers: {
                                Authorization: "Bearer YOUR_API_KEY"
                            }
                        }
                    }
                }, null, 2);
            }

            try {
                const res = await fetch('/api/me/mcp-clients');
                if (!res.ok) throw new Error();
                const data = await res.json();
                const clients = data.clients || [];

                section.style.display = '';

                if (clients.length === 0) {
                    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-plug', title: ui("m_aecc81aff22fb659") });
                    document.getElementById('revokeAllMcpClientsBtn').disabled = true;
                    return;
                }

                const hasActive = clients.some(c => c.status === 'active');
                document.getElementById('revokeAllMcpClientsBtn').disabled = !hasActive;

                listEl.innerHTML = clients.map(client => {
                    const isActive = client.status === 'active';
                    const statusBadge = isActive
                        ? ui("m_06fa809366390ebd")
                        : ui("m_28fcfd44062c4b23");
                    const clientLabel = client.client_name
                        ? window.escapeHtml(client.client_name)
                        : ui("m_6890bda750171370");
                    const clientIdShort = window.escapeHtml((client.client_id || '').slice(0, 12)) + '…';
                    const scopeList = Array.isArray(client.scopes) && client.scopes.length
                        ? client.scopes
                        : ['mcp'];
                    const scopeLabel = scopeList.map(s => window.escapeHtml(s)).join(', ');
                    const lastUsed = client.last_used_at ? formatMcpRelative(client.last_used_at) : ui("m_f54a75428c8c17df");
                    const revokedAt = client.last_revoked_at ? formatMcpTime(client.last_revoked_at) : null;

                    const action = isActive
                        ? ui("m_5bc4519c664e15cc", [window.escapeHtml(client.client_id)])
                        : '';

                    const lastLine = revokedAt
                        ? ui("m_120954a7eb16049f", [window.escapeHtml(revokedAt)])
                        : '';

                    return ui("m_f9807363ea95980a", [isActive ? '' : 'opacity-75', clientLabel, statusBadge, clientIdShort, scopeLabel, window.escapeHtml(lastUsed), lastLine, action]);
                }).join('');

                listEl.querySelectorAll('button[data-revoke-client-id]').forEach(btn => {
                    btn.addEventListener('click', () => {
                        revokeMcpClient(btn.getAttribute('data-revoke-client-id') || '');
                    });
                });
            } catch (e) {
                section.style.display = '';
                listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: ui("m_246750384dc87eb1") });
            }
        }

        function copyWikiMcpEndpoint() {
            const url = (document.getElementById('wikiMcpEndpointUrl') as HTMLElement)?.textContent || '';
            navigator.clipboard.writeText(url).then(() => {
                Swal.fire({ icon: 'success', title: ui("m_9693e1eb3edb1291"), toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
            }).catch(() => {
                Swal.fire({ icon: 'error', title: ui("m_0642e2d15469a319"), toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
            });
        }

        function copyMcpApiKeyJsonSnippet() {
            const text = (document.getElementById('mcpApiKeyJsonSnippet') as HTMLElement)?.textContent || '';
            navigator.clipboard.writeText(text).then(() => {
                Swal.fire({ icon: 'success', title: ui("m_9693e1eb3edb1291"), toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
            }).catch(() => {
                Swal.fire({ icon: 'error', title: ui("m_0642e2d15469a319"), toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
            });
        }

        async function revokeMcpClient(clientId) {
            if (!clientId) return;
            const result = await Swal.fire({
                title: ui("m_532eaa910b0a036e"),
                text: ui("m_8acf0d63f4ee22b7"),
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#cf222e',
                confirmButtonText: ui("m_085132af55f23f84"),
                cancelButtonText: ui("m_2cd0f3be8738a86c"),
            });
            if (!result.isConfirmed) return;

            try {
                const res = await fetch(`/api/me/mcp-clients/${encodeURIComponent(clientId)}`, { method: 'DELETE' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || ui("m_421f1d9fd7c7d721"));

                Swal.fire({ icon: 'success', title: ui("m_b4afd2a1e5683593"), toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
                loadMcpClients();
            } catch (err) {
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
            }
        }

        async function revokeAllMcpClients() {
            const result = await Swal.fire({
                title: ui("m_67a27833741f508b"),
                text: ui("m_d50dcdc0f072e26d"),
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#cf222e',
                confirmButtonText: ui("m_f3a7c846a6aa057d"),
                cancelButtonText: ui("m_2cd0f3be8738a86c"),
            });
            if (!result.isConfirmed) return;

            try {
                const res = await fetch('/api/me/mcp-clients', { method: 'DELETE' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || ui("m_421f1d9fd7c7d721"));

                Swal.fire({
                    icon: 'success',
                    title: ui("m_141c46cf1ef286aa", [data.count || 0]),
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 1500,
                });
                loadMcpClients();
            } catch (err) {
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
            }
        }

        async function loadMcpApiKey() {
            const section = document.getElementById('wikiMcpSection');
            const container = document.getElementById('mcpApiKeyContainer');
            const deleteBtn = document.getElementById('deleteMcpApiKeyBtn');
            if (!container || !deleteBtn) return;

            try {
                const res = await fetch('/api/me/mcp-api-key');
                if (!res.ok) throw new Error();
                const data = await res.json();
                const apiKey = data.apiKey;

                if (section) section.style.display = '';

                if (!apiKey) {
                    container.innerHTML = ui("m_0ac2f0a3bf1b8405");
                    deleteBtn.classList.add('d-none');
                    return;
                }

                const createdDate = new Date(apiKey.created_at * 1000).toLocaleString(getLocale());
                const expiresDate = new Date(apiKey.expires_at * 1000).toLocaleString(getLocale());
                const diffDays = Math.max(0, Math.ceil((apiKey.expires_at - Date.now() / 1000) / 86400));

                container.innerHTML = ui("m_928aa141bfcd12cf", [window.escapeHtml(apiKey.masked_key), createdDate, expiresDate, diffDays <= 7 ? 'bg-danger' : 'bg-secondary', diffDays]);
                deleteBtn.classList.remove('d-none');
            } catch (e) {
                if (section) section.style.display = '';
                container.innerHTML = ui("m_bf18c1f4ba92956d");
            }
        }

        async function generateMcpApiKey() {
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            const confirmColor = isDark ? '#38BDF8' : '#2a53c4';
            const swalDidOpen = isDark ? (popup: HTMLElement) => {
                const btn = popup.querySelector('.swal2-confirm') as HTMLButtonElement | null;
                if (btn) btn.style.color = '#000000';
            } : undefined;

            const result = await Swal.fire({
                title: ui("m_538bad51ad98c047"),
                text: ui("m_f0fbbf11a8dc2a99"),
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: confirmColor,
                confirmButtonText: ui("m_fc0aec8efc9cf743"),
                cancelButtonText: ui("m_2cd0f3be8738a86c"),
                didOpen: swalDidOpen,
            });
            if (!result.isConfirmed) return;

            try {
                const res = await fetch('/api/me/mcp-api-key', { method: 'POST' });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || ui("m_f3cf0ac2b18602e3"));
                }
                const data = await res.json();
                
                await Swal.fire({
                    title: ui("m_89413a4acf981a61"),
                    html: ui("m_53772e874af1ee0c", [window.escapeHtml(data.rawKey)]),
                    icon: 'success',
                    width: 550,
                    confirmButtonColor: confirmColor,
                    confirmButtonText: ui("m_893ad42623329e42"),
                    didOpen: swalDidOpen,
                });

                loadMcpApiKey();
            } catch (err) {
                Swal.fire({
                    icon: 'error',
                    title: ui("m_0bc1fb72ae1be5c5"),
                    text: err.message,
                    confirmButtonColor: confirmColor,
                    didOpen: swalDidOpen,
                });
            }
        }

        async function deleteMcpApiKey() {
            const result = await Swal.fire({
                title: ui("m_b56016d872713ccf"),
                text: ui("m_493258fb8b412f6b"),
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#cf222e',
                confirmButtonText: ui("m_2f9daa828907b93f"),
                cancelButtonText: ui("m_2cd0f3be8738a86c"),
            });
            if (!result.isConfirmed) return;

            try {
                const res = await fetch('/api/me/mcp-api-key', { method: 'DELETE' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || ui("m_6b80155c7299cd4e"));

                Swal.fire({
                    icon: 'success',
                    title: ui("m_7b1448a5c7c6c56d"),
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 1500
                });
                loadMcpApiKey();
            } catch (err) {
                const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
                const confirmColor = isDark ? '#38BDF8' : '#2a53c4';
                const swalDidOpen = isDark ? (popup: HTMLElement) => {
                    const btn = popup.querySelector('.swal2-confirm') as HTMLButtonElement | null;
                    if (btn) btn.style.color = '#000000';
                } : undefined;
                Swal.fire({
                    icon: 'error',
                    title: ui("m_0bc1fb72ae1be5c5"),
                    text: err.message,
                    confirmButtonColor: confirmColor,
                    didOpen: swalDidOpen,
                });
            }
        }

        // ─── MCP 도구 On/Off ───────────────────────────────────────────
        const MCP_TOOL_GROUP_LABELS = {
            shared: ui("m_1c148ed1dcc6243e"),
            user_read: ui("m_86041d952f56428c"),
            user_edit: ui("m_26f560cba82df77e"),
            instant_apply: ui("m_af33709404ad7fea"),
            admin_read: ui("m_b5b2f5ac52b90edb"),
            admin_edit: ui("m_33ec19976faab2af"),
        };
        const MCP_TOOL_GROUP_ORDER = ['shared', 'user_read', 'user_edit', 'instant_apply', 'admin_read', 'admin_edit'];

        // 저장 중 중복 제출 방지 — 단건 토글과 모두 켜기/끄기가 동시에 PUT 되면
        // 서버 CAS 가 409 로 막아주지만, UX 차원에서 선제적으로 잠근다.
        let mcpToolsSaving = false;
        function setMcpToolsSaving(saving) {
            mcpToolsSaving = saving;
            document.querySelectorAll('[data-mcp-tool-toggle]').forEach(el => { el.disabled = saving; });
            const allOn = document.getElementById('mcpToolsAllOnBtn');
            const allOff = document.getElementById('mcpToolsAllOffBtn');
            if (allOn) allOn.disabled = saving;
            if (allOff) allOff.disabled = saving;
        }

        // 렌더 시퀀스 토큰 — 즉시반영 토글의 fire-and-forget loadMcpTools 와
        // 단건/전체 PUT 렌더가 경쟁할 때 느린 응답이 최신 렌더를 덮지 못하게 한다.
        let mcpToolsSeq = 0;
        async function loadMcpTools() {
            const listEl = document.getElementById('mcpToolsList');
            if (!listEl) return;
            const mySeq = ++mcpToolsSeq;
            try {
                const res = await fetch('/api/me/mcp-tools');
                if (!res.ok) throw new Error();
                const data = await res.json();
                if (mySeq !== mcpToolsSeq) return; // stale — 최신 렌더를 덮지 않는다.
                renderMcpTools(data.tools || [], data.hidden_disabled || []);
            } catch (e) {
                if (mySeq !== mcpToolsSeq) return;
                listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: ui("m_ebaf4022cf1aed6d") });
            }
        }

        function renderMcpTools(tools, hiddenDisabled) {
            const listEl = document.getElementById('mcpToolsList');
            if (!listEl) return;
            if (!tools.length) {
                listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-plug', title: ui("m_4fe14a71cc020847") });
                return;
            }
            const grouped = new Map();
            for (const t of tools) {
                if (!grouped.has(t.group)) grouped.set(t.group, []);
                grouped.get(t.group).push(t);
            }
            let html = '';
            for (const g of MCP_TOOL_GROUP_ORDER) {
                const items = grouped.get(g);
                if (!items || !items.length) continue;
                html += `<div class="mcp-tool-group">${window.escapeHtml(MCP_TOOL_GROUP_LABELS[g] || g)} · ${items.length}</div>`;
                for (const t of items) {
                    const checked = t.enabled ? 'checked' : '';
                    const offCls = t.enabled ? '' : ' is-off';
                    html += ui("m_2b31bd535fde6c1e", [offCls, window.escapeHtml(t.name), window.escapeHtml(t.description || ''), window.escapeHtml(t.description || ''), checked, window.escapeHtml(t.name), window.escapeHtml(t.name)]);
                }
            }
            html += ui("m_90c4c19e61f4d198");
            if (hiddenDisabled && hiddenDisabled.length) {
                html += ui("m_5f7ca95661ec202e", [hiddenDisabled.length, hiddenDisabled.map(n => window.escapeHtml(n)).join('</code>, <code>')]);
            }
            listEl.innerHTML = html;
            listEl.querySelectorAll('[data-mcp-tool-toggle]').forEach(input => {
                input.addEventListener('change', () => toggleMcpTool(input));
            });
        }

        async function toggleMcpTool(input) {
            if (mcpToolsSaving) {
                input.checked = !input.checked;
                return;
            }
            const tool = input.getAttribute('data-mcp-tool-toggle') || '';
            const enabled = !!input.checked;
            setMcpToolsSaving(true);
            try {
                const res = await fetch('/api/me/mcp-tools', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tool, enabled })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || ui("m_b8462c884b380729"));
                mcpToolsSeq++; // 진행 중 loadMcpTools 가 있으면 무효화 — PUT 응답 렌더가 최신이다.
                renderMcpTools(data.tools || [], data.hidden_disabled || []);
                Swal.fire({
                    icon: 'success',
                    // Swal title 은 HTML 렌더링이므로 도구명을 이스케이프한다.
                    title: enabled ? ui("m_ebe206ebca2d2538", [window.escapeHtml(tool)]) : ui("m_ac9d1feaa6f2c2bf", [window.escapeHtml(tool)]),
                    text: ui("m_64e0cea2b5b3d497"),
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 2000,
                });
            } catch (err) {
                input.checked = !enabled;
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
            } finally {
                setMcpToolsSaving(false);
            }
        }

        async function setAllMcpTools(enabled) {
            if (mcpToolsSaving) return;
            setMcpToolsSaving(true);
            try {
                // 서버에서 역할 범위 전체를 일괄 적용한다. DOM 스냅샷을 보내지 않으므로
                // 화면에 안 보이는 도구(즉시반영 OFF 시 apply_edit 등)까지 커버되고,
                // 목록 로드 실패 시 빈 배열을 보내는 반전 버그도 없다.
                const res = await fetch('/api/me/mcp-tools', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ all: enabled })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || ui("m_b8462c884b380729"));
                mcpToolsSeq++; // 진행 중 loadMcpTools 가 있으면 무효화 — PUT 응답 렌더가 최신이다.
                renderMcpTools(data.tools || [], data.hidden_disabled || []);
                Swal.fire({
                    icon: 'success',
                    title: enabled ? ui("m_6a599d422eb8cd96") : ui("m_75014dab18ae7bd9"),
                    text: ui("m_64e0cea2b5b3d497"),
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 2000,
                });
            } catch (err) {
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), err.message, 'error');
            } finally {
                setMcpToolsSaving(false);
            }
        }

        async function deleteDirectMessage(id) {
            Swal.fire({
                title: ui("m_6667a8cd66f25800"),
                text: ui("m_1164e3f65c948f93"),
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#cf222e',
                confirmButtonText: ui("m_2f9daa828907b93f"),
                cancelButtonText: ui("m_2cd0f3be8738a86c")
            }).then(async (result) => {
                if (result.isConfirmed) {
                    try {
                        const res = await fetch(`/api/messages/${id}`, { method: 'DELETE' });
                        if (!res.ok) throw new Error();

                        Swal.fire({ icon: 'success', title: ui("m_077a6d37719a0e21"), toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
                        // 목록 리로드
                        loadMessages(false);
                        // 헤더 알림 뱃지도 갱신 가능성 있음
                        if (typeof window.loadNotificationCount === 'function') {
                            window.loadNotificationCount();
                        }
                    } catch (e) {
                        Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_abd5f58e92d55980"), 'error');
                    }
                }
            });
        }

        // ─── 보낸 쪽지함 ─────────────────────────────────────────────────
        let currentSentOffset = 0;
        const SENT_LIMIT = 10;

        async function loadSentMessages(isLoadMore = false) {
            if (!isLoadMore) currentSentOffset = 0;

            try {
                const res = await fetch(`/api/messages/sent?offset=${currentSentOffset}&limit=${SENT_LIMIT}`);
                if (!res.ok) throw new Error();
                const data = await res.json();
                const messages = data.messages || [];

                const section = document.getElementById('sentMessagesSection');
                section.style.display = '';
                const listEl = document.getElementById('sentMessagesList');
                const loadMoreBtn = document.getElementById('loadMoreSentMessagesBtn');

                if (!isLoadMore && messages.length === 0) {
                    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-send', title: ui("m_e70ce6ed3505d412") });
                    loadMoreBtn.classList.add('d-none');
                    return;
                }

                if (!isLoadMore) listEl.innerHTML = '';

                listEl.insertAdjacentHTML('beforeend', messages.map(m => {
                    const date = new Date(m.created_at * 1000).toLocaleString(getLocale());
                    const preview = m.content.length > 50 ? window.escapeHtml(m.content.substring(0, 50)) + '...' : window.escapeHtml(m.content);
                    const receiverName = m.receiver_name || ui("m_1ac13841ba2ea68b");
                    return `
                        <div class="contribution-item" style="cursor:pointer;" onclick="viewSentMessage(${m.id})">
                            <div class="flex-grow-1">
                                <span class="fw-bold"><i class="mdi mdi-account-circle text-muted"></i> → ${window.escapeHtml(receiverName)}</span>
                                <span class="text-muted ms-2">${preview}</span>
                            </div>
                            <span class="meta">${date}</span>
                        </div>
                    `;
                }).join(''));

                currentSentOffset += messages.length;
                data.has_more ? loadMoreBtn.classList.remove('d-none') : loadMoreBtn.classList.add('d-none');
            } catch (e) {
                if (!isLoadMore) {
                    document.getElementById('sentMessagesSection').style.display = '';
                    document.getElementById('sentMessagesList').innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: ui("m_ebaf4022cf1aed6d") });
                }
            }
        }

        async function loadMoreSentMessages() {
            const btn = document.getElementById('loadMoreSentMessagesBtn');
            btn.disabled = true;
            btn.innerHTML = window.uiInlineLoading();
            await loadSentMessages(true);
            btn.disabled = false;
            btn.innerHTML = ui("m_35180a50cfb0bb39");
        }

        async function viewSentMessage(messageId) {
            try {
                const res = await fetch(`/api/messages/${messageId}`);
                if (!res.ok) throw new Error();
                const msg = await res.json();

                const date = new Date(msg.created_at * 1000).toLocaleString(getLocale());
                const receiverName = msg.receiver_name || ui("m_1ac13841ba2ea68b");
                const receiverPic = msg.receiver_picture && window.isSafeUrl(msg.receiver_picture)
                    ? `<img src="${window.escapeHtml(msg.receiver_picture)}" class="rounded-circle me-2" width="28" height="28" loading="lazy">`
                    : '<i class="mdi mdi-account-circle fs-4 me-2 text-muted"></i>';

                Swal.fire({
                    title: ui("m_979faa03ef1263ac"),
                    html: ui("m_b81de0ce01802810", [receiverPic, window.escapeHtml(receiverName), date, window.escapeHtml(msg.content)]),
                    showConfirmButton: true,
                    confirmButtonText: ui("m_3fd47edce45b3603"),
                    width: 480,
                });
            } catch (e) {
                Swal.fire(ui("m_0bc1fb72ae1be5c5"), ui("m_c5c7bbba883e6f86"), 'error');
            }
        }

        // ─── 내가 쓴 토론 목록 ───────────────────────────────────────────
        let currentDiscussionsOffset = 0;
        const DISCUSSIONS_LIMIT = 10;

        async function loadMyDiscussions(isLoadMore = false) {
            if (!isLoadMore) currentDiscussionsOffset = 0;

            try {
                const res = await fetch(`/api/me/discussions?offset=${currentDiscussionsOffset}&limit=${DISCUSSIONS_LIMIT}`);
                if (!res.ok) throw new Error();
                const data = await res.json();
                const discussions = data.discussions || [];

                const section = document.getElementById('myDiscussionsSection');
                section.style.display = '';
                const listEl = document.getElementById('myDiscussionsList');
                const loadMoreBtn = document.getElementById('loadMoreDiscussionsBtn');

                if (!isLoadMore && discussions.length === 0) {
                    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-chat-left-text', title: ui("m_fb8fff7a33b98612") });
                    loadMoreBtn.classList.add('d-none');
                    return;
                }

                if (!isLoadMore) listEl.innerHTML = '';

                listEl.insertAdjacentHTML('beforeend', discussions.map(d => {
                    const date = new Date(d.updated_at * 1000).toLocaleDateString(getLocale());
                    const statusBadge = d.status === 'open'
                        ? ui("m_ce98a29d178f27ea")
                        : ui("m_f0a1f93064d8493b");
                    const discUrl = d.page_slug
                        ? `/w/${encodeURIComponent(d.page_slug)}?mode=discussions&id=${encodeURIComponent(d.id)}`
                        : null;
                    const titleEl = discUrl
                        ? `<a href="${discUrl}">${window.escapeHtml(d.title)}</a>`
                        : `<span>${window.escapeHtml(d.title)}</span>`;
                    const pageLink = d.page_slug
                        ? `<a href="/w/${encodeURIComponent(d.page_slug)}" class="badge bg-light text-dark border text-decoration-none ms-1">${window.escapeHtml(d.page_slug)}</a>`
                        : '';
                    return ui("m_5c03c21fd037173c", [titleEl, statusBadge, pageLink, d.comment_count || 0, date]);
                }).join(''));

                currentDiscussionsOffset += discussions.length;
                data.has_more ? loadMoreBtn.classList.remove('d-none') : loadMoreBtn.classList.add('d-none');
            } catch (e) {
                if (!isLoadMore) {
                    document.getElementById('myDiscussionsSection').style.display = '';
                    document.getElementById('myDiscussionsList').innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: ui("m_ebaf4022cf1aed6d") });
                }
            }
        }

        async function loadMoreMyDiscussions() {
            const btn = document.getElementById('loadMoreDiscussionsBtn');
            btn.disabled = true;
            btn.innerHTML = window.uiInlineLoading();
            await loadMyDiscussions(true);
            btn.disabled = false;
            btn.innerHTML = ui("m_35180a50cfb0bb39");
        }

        // ─── 내 티켓 목록 ────────────────────────────────────────────────
        const TICKET_TYPE_LABELS = { general: ui("m_de907d10df98b498"), document: ui("m_452c7b10d57a86a7"), discussion: ui("m_3cef912ce8819fff"), account: ui("m_311bb313fdeca6aa") };

        async function loadMyTickets() {
            const section = document.getElementById('myTicketsSection');
            const listEl = document.getElementById('myTicketsList');
            try {
                const res = await fetch('/api/tickets?page=1&my=1');
                if (!res.ok) throw new Error();
                const data = await res.json();
                const tickets = (data.tickets || []).slice(0, 5);

                section.style.display = '';

                if (tickets.length === 0) {
                    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-ticket-perforated', title: ui("m_bb05b8e0fa4f2424") });
                    return;
                }

                listEl.innerHTML = tickets.map(t => {
                    const date = new Date(t.updated_at * 1000).toLocaleDateString(getLocale());
                    const typeBadge = `<span class="badge bg-secondary ms-1">${TICKET_TYPE_LABELS[t.type] || t.type}</span>`;
                    const statusBadge = t.status === 'open'
                        ? ui("m_f099c821b6c85a06")
                        : ui("m_bb7f163622726846");
                    return `
                        <div class="contribution-item">
                            <div class="flex-grow-1 text-truncate me-2">
                                <a href="/tickets/${encodeURIComponent(t.id)}">${window.escapeHtml(t.title)}</a>
                                ${typeBadge}${statusBadge}
                            </div>
                            <span class="meta flex-shrink-0">${date}</span>
                        </div>
                    `;
                }).join('');
            } catch (e) {
                section.style.display = '';
                listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: ui("m_ebaf4022cf1aed6d") });
            }
        }

// HTML(정적 + innerHTML)의 on* 속성에서 호출되므로 window 로 노출한다.
// (viewMessage 는 common.ts 전역이라 노출 대상이 아니다.)
window.updateName = updateName;
window.togglePicturePrivacy = togglePicturePrivacy;
window.toggleMcpInstantApply = toggleMcpInstantApply;
window.loadMoreMessages = loadMoreMessages;
window.loadMoreSentMessages = loadMoreSentMessages;
window.loadMoreMyDiscussions = loadMoreMyDiscussions;
window.revokeAllSessions = revokeAllSessions;
window.revokeAllMcpClients = revokeAllMcpClients;
window.deleteAccount = deleteAccount;
window.refreshProfilePicture = refreshProfilePicture;
window.deleteDirectMessage = deleteDirectMessage;
window.revokeSession = revokeSession;
window.viewSentMessage = viewSentMessage;
window.loadMoreNotificationsArchive = loadMoreNotificationsArchive;
window.markAllNotificationsReadArchive = markAllNotificationsReadArchive;
window.deleteAllNotificationsArchive = deleteAllNotificationsArchive;
window.generateMcpApiKey = generateMcpApiKey;
window.deleteMcpApiKey = deleteMcpApiKey;
window.setAllMcpTools = setAllMcpTools;
window.copyWikiMcpEndpoint = copyWikiMcpEndpoint;
window.copyMcpApiKeyJsonSnippet = copyMcpApiKeyJsonSnippet;
