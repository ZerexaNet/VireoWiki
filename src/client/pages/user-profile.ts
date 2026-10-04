// @ts-nocheck — user-profile.html 인라인 스크립트 이관(동작 보존). common.ts 와 동일 사유로 타입검사 비활성.
//
// 이관 규칙:
//  - common.ts 가 window.* 로 노출하는 공통 전역(loadConfig / currentUser /
//    loadNotificationCount / escapeHtml / appConfig)은 모듈 스코프에서 bare 식별자로
//    해석되지 않으므로 모두 window.* 로 접근한다.
//  - CDN 전역(Swal)은 그대로 둔다.
//  - HTML on* 속성에서 호출되는, 이 블록에서 정의된 함수(adminBanUser /
//    adminChangeRole / goToContributionsPage)는 파일 끝에서 window.* 로 노출한다.

import { ui, getLocale } from '../../../packages/wiki-shared/src/i18n/client';
let profileUser = null;
let contributionsPage = 1;
let contributionsTotal = 0;
let contributionsRequestSeq = 0;
const PAGE_SIZE = 20;

// URL에서 유저 ID 추출
function getUserIdFromUrl() {
    const match = window.location.pathname.match(/^\/profile\/(\d+)$/);
    return match ? parseInt(match[1]) : null;
}

document.addEventListener('DOMContentLoaded', async () => {
    await window.loadConfig();
    const userId = getUserIdFromUrl();
    if (!userId) {
        document.getElementById('profileHeader').innerHTML =
            ui("m_1dbb06603c3f640a");
        return;
    }

    try {
        // 동시에 checkAuth와 fetchProfile 호출
        const [authRes, res] = await Promise.all([
            fetch('/api/me').catch(() => null),
            fetch(`/api/users/${userId}/profile`)
        ]);

        if (authRes && authRes.ok) {
            window.currentUser = await authRes.json();
            document.querySelectorAll('#navLogin').forEach(el => el.classList.add('d-none'));
            document.querySelectorAll('#navUser').forEach(el => el.classList.remove('d-none'));
            document.querySelectorAll('#userAvatar').forEach(el => el.src = window.currentUser.picture || '');
            document.querySelectorAll('#userName').forEach(el => el.textContent = window.currentUser.name);

            if (window.currentUser.role === 'admin' || window.currentUser.role === 'super_admin') {
                document.querySelectorAll('#navAdminConsole, #navAdminDivider').forEach(el => el.classList.remove('d-none'));
            }

            // 알림 버튼 표시
            document.querySelectorAll('#notificationBtnWrapper').forEach(el => el.classList.remove('d-none'));
            window.loadNotificationCount();
        }

        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || ui("m_5e480fde00b98d8b"));
        }
        profileUser = await res.json();
        renderProfile();
        loadContributions();
    } catch (e) {
        document.getElementById('profileHeader').innerHTML =
            `<div class="text-center text-muted py-3">${window.escapeHtml(e.message)}</div>`;
    }
});

async function renderProfile() {
    const header = document.getElementById('profileHeader');

    const joinDate = profileUser.created_at
        ? new Date(profileUser.created_at * 1000).toLocaleDateString(getLocale(), {
            year: 'numeric', month: 'long', day: 'numeric'
        })
        : ui("m_1ac13841ba2ea68b");

    const avatarHtml = profileUser.picture
        ? ui("m_ca7edd9b33f4259e", [profileUser.picture])
        : `<div class="profile-avatar-placeholder">${window.escapeHtml(profileUser.name.charAt(0))}</div>`;

    // 쪽지 보내기 버튼 표시 여부
    let sendMsgBtn = '';
    if (window.currentUser && window.currentUser.id !== profileUser.id) {
        if (window.currentUser.role === 'banned') {
            // 차단 사용자: 소명(이의제기) 채널로 관리자에게만 쪽지 발송 가능.
            // 공개 프로필은 role 을 숨기므로 안전한 is_admin 플래그로 관리자 여부를 판단한다.
            if (profileUser.is_admin) {
                sendMsgBtn = ui("m_ceb1572e3656864c", [profileUser.id, window.escapeHtml(profileUser.name)]);
            }
        } else {
            try {
                const dmRes = await fetch('/api/settings/dm');
                const dmData = dmRes.ok ? await dmRes.json() : { allow_direct_message: 0 };
                const canBypassDm = ['admin', 'super_admin', 'discussion_manager'].includes(window.currentUser.role);

                if (dmData.allow_direct_message === 1 || canBypassDm) {
                    if (profileUser.role === 'deleted') {
                        sendMsgBtn = ui("m_bbea705fd7043e15");
                    } else {
                        sendMsgBtn = ui("m_31940b1a15c1746b", [profileUser.id, window.escapeHtml(profileUser.name)]);
                    }
                }
            } catch (e) { }
        }
    }

    header.innerHTML = ui("m_593c6c3e3a530a79", [avatarHtml, window.escapeHtml(profileUser.name), joinDate, sendMsgBtn]);

    document.title = ui("m_d6ff3dc0f8832748", [profileUser.name, window.appConfig.wikiName]);
    renderAdminControls();
}

function renderAdminControls() {
    if (!window.currentUser) return;
    const isAdmin = window.currentUser.role === 'admin' || window.currentUser.role === 'super_admin';
    if (!isAdmin) return;

    const section = document.getElementById('adminControlsSection');
    const content = document.getElementById('adminControlsContent');
    section.style.display = '';

    const isSuperAdmin = window.currentUser.role === 'super_admin';
    const targetIsSuperAdmin = profileUser.role === 'super_admin';
    const isBanned = profileUser.banned_until && profileUser.banned_until * 1000 > Date.now();

    let html = '<div class="d-flex flex-wrap align-items-center gap-3">';

    // 차단 버튼
    const targetIsAdmin = profileUser.role === 'admin';
    if (targetIsSuperAdmin) {
        // super_admin은 제어 불가
        html += ui("m_3f12acfd4e196e1e");
    } else if (!isSuperAdmin && targetIsAdmin) {
        // 일반 관리자는 다른 관리자를 차단할 수 없음
        html += ui("m_4289645737356723");
    } else {
        const banLabel = isBanned
            ? ui("m_70893e3a01dea663")
            : ui("m_d4d5dd0f4e88cfdf");
        const banClass = isBanned ? 'btn btn-outline-secondary' : 'btn btn-outline-danger';
        html += `<button class="${banClass}" onclick="adminBanUser()">${banLabel}</button>`;

        if (isBanned) {
            const until = new Date(profileUser.banned_until * 1000).toLocaleDateString(getLocale());
            html += ui("m_0bd20e10ce10219e", [until]);
        }
    }

    // 역할 변경 (super_admin 뷰어이고 대상이 super_admin이 아닌 경우)
    if (isSuperAdmin && !targetIsSuperAdmin) {
        html += ui("m_34c1cc53cb025244", [profileUser.role === 'user' ? 'selected' : '', profileUser.role === 'discussion_manager' ? 'selected' : '', profileUser.role === 'admin' ? 'selected' : '']);
    }

    html += '</div>';
    content.innerHTML = html;
}

async function adminBanUser() {
    const isBanned = profileUser.banned_until && profileUser.banned_until * 1000 > Date.now();
    const { value: days } = await Swal.fire({
        titleText: ui("m_f4e3ec810bc2950d", [profileUser.name]),
        input: 'number',
        inputLabel: ui("m_b5cff10605f8765f"),
        inputValue: isBanned ? 0 : 7,
        inputAttributes: { min: 0 },
        showCancelButton: true,
        cancelButtonText: ui("m_2cd0f3be8738a86c"),
        confirmButtonText: ui("m_63c73c4730f4473e"),
    });
    if (days === undefined) return;
    const res = await fetch(`/api/admin/users/${profileUser.id}/ban`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: Number(days) }),
    });
    const data = await res.json();
    if (res.ok) {
        profileUser.banned_until = data.banned_until;
        renderAdminControls();
    } else {
        Swal.fire(ui("m_0bc1fb72ae1be5c5"), data.error || ui("m_ce49766856ea5ccc"), 'error');
    }
}

async function adminChangeRole(role) {
    const res = await fetch(`/api/admin/users/${profileUser.id}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
    });
    const data = await res.json();
    if (res.ok) {
        profileUser.role = role;
        renderAdminControls();
        Swal.fire({ icon: 'success', title: ui("m_4b785e68bbaeafb2"), toast: true, position: 'top-end', timer: 1500, showConfirmButton: false });
    } else {
        Swal.fire(ui("m_0bc1fb72ae1be5c5"), data.error || ui("m_b8462c884b380729"), 'error');
    }
}

async function loadContributions(page = 1) {
    const userId = getUserIdFromUrl();
    const listEl = document.getElementById('contributionsList');
    const paginationEl = document.getElementById('contributionsPagination');
    const isFirstLoad = contributionsTotal === 0 && page === 1;
    if (!isFirstLoad) {
        listEl.innerHTML = window.uiSkeletonList(5);
    }

    const seq = ++contributionsRequestSeq;
    const offset = (page - 1) * PAGE_SIZE;
    try {
        const res = await fetch(`/api/users/${userId}/contributions?offset=${offset}&limit=${PAGE_SIZE}`);
        if (seq !== contributionsRequestSeq) return;
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (seq !== contributionsRequestSeq) return;
        const contributions = data.contributions || [];
        const total = data.total || 0;

        contributionsTotal = total;

        // 통계 표시
        const statsSection = document.getElementById('statsSection');
        statsSection.style.display = '';
        document.getElementById('statCards').innerHTML = ui("m_e15101c3bcd95685", [contributionsTotal]);

        // 기여 목록
        const section = document.getElementById('contributionsSection');
        section.style.display = '';

        if (total === 0) {
            contributionsPage = 1;
            listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-inbox', title: ui("m_2758a88ab03cb3f7") });
            paginationEl.innerHTML = '';
            return;
        }

        // 요청한 페이지가 범위를 벗어났으면 마지막 페이지로 보정해 재요청
        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (contributions.length === 0 && page > totalPages) {
            loadContributions(totalPages);
            return;
        }

        contributionsPage = page;
        listEl.innerHTML = contributions.map(renderContribution).join('');
        renderContributionsPagination();

    } catch (e) {
        if (seq !== contributionsRequestSeq) return;
        listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: ui("m_ebaf4022cf1aed6d"), text: ui("m_5ddbb7be6b11cc08") });
        paginationEl.innerHTML = '';
    }
}

function goToContributionsPage(page) {
    const totalPages = Math.max(1, Math.ceil(contributionsTotal / PAGE_SIZE));
    const target = Math.min(Math.max(1, page), totalPages);
    if (target === contributionsPage) return;
    loadContributions(target);
    document.getElementById('contributionsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function getContributionsPageNumbers(current, total) {
    const pages = [];
    if (total <= 7) {
        for (let i = 1; i <= total; i++) pages.push(i);
        return pages;
    }
    pages.push(1);
    if (current > 3) pages.push('...');
    const start = Math.max(2, current - 1);
    const end = Math.min(total - 1, current + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    if (current < total - 2) pages.push('...');
    pages.push(total);
    return pages;
}

function renderContributionsPagination() {
    const container = document.getElementById('contributionsPagination');
    const totalPages = Math.max(1, Math.ceil(contributionsTotal / PAGE_SIZE));
    if (totalPages <= 1) {
        container.innerHTML = '';
        return;
    }
    const pages = getContributionsPageNumbers(contributionsPage, totalPages);
    const isFirst = contributionsPage === 1;
    const isLast = contributionsPage === totalPages;

    let html = '<ul class="pagination pagination-sm justify-content-center mb-0 flex-wrap">';
    html += ui("m_398351989ec50691", [isFirst ? 'disabled' : '', isFirst ? 'disabled' : '']);
    html += ui("m_6c0fb654ae359b4f", [isFirst ? 'disabled' : '', contributionsPage - 1, isFirst ? 'disabled' : '']);
    for (const p of pages) {
        if (p === '...') {
            html += '<li class="page-item disabled"><span class="page-link">…</span></li>';
        } else {
            const active = p === contributionsPage ? 'active' : '';
            html += `<li class="page-item ${active}"><button type="button" class="page-link" onclick="goToContributionsPage(${p})">${p}</button></li>`;
        }
    }
    html += ui("m_c8b6761d4b749cdb", [isLast ? 'disabled' : '', contributionsPage + 1, isLast ? 'disabled' : '']);
    html += ui("m_e18398471f8e2d1a", [isLast ? 'disabled' : '', totalPages, isLast ? 'disabled' : '']);
    html += '</ul>';
    container.innerHTML = html;
}

function renderContribution(c) {
    const date = new Date(c.created_at * 1000).toLocaleString(getLocale());
    const summaryHtml = c.summary
        ? `<span class="summary">- ${window.escapeHtml(c.summary)}</span>`
        : ui("m_dd1ad9208422091e");
    return `
        <div class="contribution-item">
            <div>
                <a href="/w/${encodeURIComponent(c.slug)}">${window.escapeHtml(c.slug)}</a>
                ${summaryHtml}
            </div>
            <span class="meta">${date}</span>
        </div>
    `;
}

// HTML on* 속성에서 호출되므로 window 로 노출
window.adminBanUser = adminBanUser;
window.adminChangeRole = adminChangeRole;
window.goToContributionsPage = goToContributionsPage;
