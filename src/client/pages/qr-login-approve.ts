/**
 * QR 로그인 승인 페이지(/qr-login/:token) 클라이언트 — 호스트(로그인된) 기기.
 *
 * 흐름:
 *  1. URL 경로에서 token 을 읽는다.
 *  2. GET /api/qr-login/info 로 로그인될 계정(본인)과 게스트 기기 정보를 불러와 표시.
 *  3. "확인" → POST /api/qr-login/approve, "취소" → POST /api/qr-login/cancel.
 *
 * 세션 쿠키는 게스트 기기(폴링 후 redeem)에 발급되며, 이 페이지는 승인 신호만 보낸다.
 */

import { ui } from '../../../packages/wiki-shared/src/i18n/client';
import type { QrLoginInfoResponse } from '../../shared/api/qr-login';

const DEFAULT_AVATAR = '/avatar-default.svg';

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function tokenFromPath(): string {
    // /qr-login/<token>
    const m = window.location.pathname.match(/^\/qr-login\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
}

function show(id: string): void {
    $(id)?.classList.remove('qr-hidden');
}
function hide(id: string): void {
    $(id)?.classList.add('qr-hidden');
}

function setStatus(msg: string, kind: 'muted' | 'error' | 'success' = 'muted'): void {
    const el = $('qrStatus');
    if (!el) return;
    el.textContent = msg;
    el.style.color =
        kind === 'error' ? 'var(--wiki-danger, #dc3545)'
        : kind === 'success' ? 'var(--wiki-primary)'
        : 'var(--wiki-text-muted)';
}

/** 결과 화면(성공/취소/오류)으로 전환한다. */
function showResult(icon: string, message: string, iconColor?: string): void {
    hide('qrLoading');
    hide('qrApprovePanel');
    setStatus('');
    const iconEl = $('qrResultIcon');
    if (iconEl) {
        iconEl.className = 'mdi qr-approve-icon ' + icon;
        if (iconColor) iconEl.style.color = iconColor;
    }
    const msgEl = $('qrResultMessage');
    if (msgEl) msgEl.textContent = message;
    show('qrResult');
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
    const res = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    let data: any = null;
    try {
        data = await res.json();
    } catch {
        // ignore
    }
    return { ok: res.ok, status: res.status, data };
}

function renderInfo(info: QrLoginInfoResponse): void {
    const avatar = $('qrAccountAvatar') as HTMLImageElement | null;
    if (avatar) {
        avatar.src = info.account.picture || DEFAULT_AVATAR;
        avatar.onerror = () => {
            avatar.onerror = null;
            avatar.src = DEFAULT_AVATAR;
        };
    }
    const nameEl = $('qrAccountName');
    if (nameEl) nameEl.textContent = info.account.name;

    const uaEl = $('qrGuestUa');
    if (uaEl) uaEl.textContent = info.guest.user_agent || ui("m_59196cb466701f5a");

    hide('qrLoading');
    show('qrApprovePanel');
}

function bindActions(token: string): void {
    const approveBtn = $('qrApproveBtn') as HTMLButtonElement | null;
    const cancelBtn = $('qrCancelBtn') as HTMLButtonElement | null;

    approveBtn?.addEventListener('click', async () => {
        if (approveBtn.disabled) return;
        approveBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
        setStatus(ui("m_b1965e9a33b60544"), 'muted');
        try {
            const { ok, data } = await postJson('/api/qr-login/approve', { token });
            if (ok) {
                showResult('mdi-check-circle-outline', ui("m_21c695ae62258237"), 'var(--wiki-primary)');
            } else {
                setStatus(data?.error || ui("m_52079e3d89b7f5ed"), 'error');
                approveBtn.disabled = false;
                if (cancelBtn) cancelBtn.disabled = false;
            }
        } catch {
            setStatus(ui("m_ad74275ac6289357"), 'error');
            approveBtn.disabled = false;
            if (cancelBtn) cancelBtn.disabled = false;
        }
    });

    cancelBtn?.addEventListener('click', async () => {
        if (cancelBtn.disabled) return;
        cancelBtn.disabled = true;
        if (approveBtn) approveBtn.disabled = true;
        setStatus(ui("m_6978544ed97b044f"), 'muted');
        try {
            await postJson('/api/qr-login/cancel', { token });
        } catch {
            // 취소는 best-effort — 실패해도 결과 화면으로 넘어간다.
        }
        showResult('mdi-close-circle-outline', ui("m_2d2fcd9b1096be89"), 'var(--wiki-text-muted)');
    });
}

async function init(): Promise<void> {
    const token = tokenFromPath();
    if (!token) {
        showResult('mdi-alert-circle-outline', ui("m_8308e7dd479f58bf"), 'var(--wiki-danger, #dc3545)');
        return;
    }

    let res: Response;
    try {
        res = await fetch('/api/qr-login/info?token=' + encodeURIComponent(token), { credentials: 'same-origin' });
    } catch {
        showResult('mdi-alert-circle-outline', ui("m_144d55618c028435"), 'var(--wiki-danger, #dc3545)');
        return;
    }

    // HTTP 상태를 구조적으로 분기한다(에러 메시지 문자열 매칭 금지 — token 이 메시지에 섞여 오탐).
    if (res.status === 401) {
        // 세션 만료/비로그인 → 로그인 후 이 승인 페이지로 복귀.
        window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
        return;
    }
    if (!res.ok) {
        showResult('mdi-alert-circle-outline', ui("m_0fb1ab813a38f51b"), 'var(--wiki-danger, #dc3545)');
        return;
    }

    let info: QrLoginInfoResponse;
    try {
        info = (await res.json()) as QrLoginInfoResponse;
    } catch {
        showResult('mdi-alert-circle-outline', ui("m_144d55618c028435"), 'var(--wiki-danger, #dc3545)');
        return;
    }

    // 이미 처리됐거나 만료된 경우: 승인 버튼 대신 안내만 표시.
    if (info.status !== 'pending') {
        const messages: Record<string, string> = {
            approved: ui("m_930e28e0c8f2cb2f"),
            consumed: ui("m_e909abefcc215f82"),
            cancelled: ui("m_faa2bb59f1d2a8f9"),
            expired: ui("m_8b732305fddaa400"),
        };
        showResult('mdi-information-outline', messages[info.status] || ui("m_09c584944f0898d0"), 'var(--wiki-text-muted)');
        return;
    }

    renderInfo(info);
    bindActions(token);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
