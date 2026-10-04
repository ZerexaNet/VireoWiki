/**
 * QR 로그인 — 게스트(로그인할) 기기 측. 로그인 페이지(/login)에서 사용된다.
 *
 * 흐름:
 *  1. "다른 기기로 로그인 (QR)" 버튼 → POST /api/qr-login/start 로 token(공개)+secret(비공개) 수령.
 *  2. token 이 담긴 승인 URL 을 QR 로 표시. 호스트(로그인된) 기기가 스캔·승인.
 *  3. GET /api/qr-login/status 로 폴링하다 approved 를 감지하면 POST /api/qr-login/redeem 으로
 *     6시간 임시 세션 쿠키를 발급받고 홈으로 이동.
 *
 * secret 은 메모리에만 두고 저장/노출하지 않는다(QR 에는 token 만 담긴다).
 * QR 렌더는 esm.sh 의 qrcode-generator 를 필요 시에만 동적 로드하며, 실패 시 URL 텍스트로 폴백한다.
 */

import { ui } from '../../../packages/wiki-shared/src/i18n/client';
import type { QrLoginStartResponse, QrLoginStatusResponse } from '../../shared/api/qr-login';

interface QrCode {
    addData(data: string): void;
    make(): void;
    createSvgTag(opts: { cellSize?: number; margin?: number; scalable?: boolean }): string;
}
type QrFactory = (typeNumber: number, errorCorrectionLevel: string) => QrCode;

let qrFactory: QrFactory | null = null;
async function loadQrFactory(): Promise<QrFactory> {
    if (qrFactory) return qrFactory;
    // 변수 specifier 라 번들러가 정적 분석하지 않고 브라우저 런타임 native import 로 남긴다(외부 URL 유지).
    const url = 'https://esm.sh/qrcode-generator@1.4.4';
    const mod: any = await import(/* @vite-ignore */ url);
    qrFactory = (mod.default || mod) as QrFactory;
    return qrFactory;
}

// ── 흐름 상태 ──
let active = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let token = '';
let secret = '';
let pollIntervalMs = 2000;
let errorStreak = 0;

function getSafeRedirect(): string {
    const raw = new URLSearchParams(window.location.search).get('redirect');
    return raw && raw.startsWith('/') && !raw.startsWith('//') && !/[\x00-\x1f\x7f]/.test(raw) ? raw : '/';
}

function stopFlow(): void {
    active = false;
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
}

function popupEl(): HTMLElement | null {
    return document.querySelector('.swal2-popup');
}

function setBody(html: string): void {
    const body = popupEl()?.querySelector('#qrGuestBody');
    if (body) body.innerHTML = html;
}

function setStatusText(msg: string): void {
    const el = popupEl()?.querySelector('#qrGuestStatus');
    if (el) el.textContent = msg;
}

const QR_BODY_SKELETON = ui("m_dec763746e2bf83b");

function renderRetryButton(): void {
    const wrap = popupEl()?.querySelector('#qrGuestRetryWrap');
    if (!wrap) return;
    wrap.innerHTML = ui("m_c430706bebcd4c60");
    wrap.querySelector('#qrGuestRetry')?.addEventListener('click', () => {
        startFlow();
    });
}

function renderQrCode(url: string): void {
    const codeEl = popupEl()?.querySelector('#qrGuestCode');
    if (!codeEl) return;
    loadQrFactory()
        .then((factory) => {
            const qr = factory(0, 'M');
            qr.addData(url);
            qr.make();
            codeEl.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 1, scalable: true });
            const svg = codeEl.querySelector('svg') as SVGElement | null;
            if (svg) {
                svg.style.width = '100%';
                svg.style.height = '100%';
                svg.setAttribute('role', 'img');
                svg.setAttribute('aria-label', ui("m_52ad5a1cb43fd593"));
            }
        })
        .catch(() => {
            // 라이브러리 로드 실패 → URL 텍스트 폴백.
            codeEl.innerHTML =
                '<div style="font-size:0.7rem; color:#333; word-break:break-all; text-align:center; padding:8px;">' +
                ui("m_12bcdee453c023ec") +
                escapeText(url) +
                '</div>';
        });
}

function escapeText(s: string): string {
    return s.replace(/[&<>"']/g, (ch) =>
        ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
    );
}

async function startFlow(): Promise<void> {
    stopFlow();
    active = true;
    errorStreak = 0;
    setBody(QR_BODY_SKELETON);
    setStatusText(ui("m_d137adaabd16ba07"));

    let start: QrLoginStartResponse;
    try {
        const res = await fetch('/api/qr-login/start', { method: 'POST', credentials: 'same-origin' });
        if (!res.ok) throw new Error('start ' + res.status);
        start = (await res.json()) as QrLoginStartResponse;
    } catch {
        if (!active) return;
        setStatusText(ui("m_99d69a7ccfd6fc10"));
        renderRetryButton();
        return;
    }
    if (!active) return;

    token = start.token;
    secret = start.secret;
    pollIntervalMs = start.poll_interval_ms || 2000;

    renderQrCode(start.approve_url);
    setStatusText(ui("m_9b13c60f73a97c95"));

    scheduleNextPoll();
}

function scheduleNextPoll(): void {
    if (!active) return;
    pollTimer = setTimeout(poll, pollIntervalMs);
}

async function poll(): Promise<void> {
    if (!active) return;
    let status: QrLoginStatusResponse['status'];
    try {
        // secret 이 URL/로그에 남지 않도록 POST 본문으로 전송한다.
        const res = await fetch('/api/qr-login/status', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, secret }),
        });
        if (!res.ok) throw new Error('status ' + res.status);
        const data = (await res.json()) as QrLoginStatusResponse;
        status = data.status;
        errorStreak = 0;
    } catch {
        // 일시적 네트워크 오류 → 몇 번까지는 계속 폴링.
        errorStreak++;
        if (errorStreak >= 5) {
            setStatusText(ui("m_b9824cfb644211bf"));
            renderRetryButton();
            stopFlow();
            return;
        }
        scheduleNextPoll();
        return;
    }

    if (!active) return;

    if (status === 'approved') {
        await redeem();
        return;
    }
    if (status === 'pending') {
        scheduleNextPoll();
        return;
    }
    // cancelled / expired / consumed → 종료 + 재시도 안내
    const messages: Record<string, string> = {
        cancelled: ui("m_3fbf5ab6fb7856f2"),
        expired: ui("m_2276c50e0e3b1fdd"),
        consumed: ui("m_de7c3d878f5e82c9"),
    };
    setStatusText(messages[status] || ui("m_d58aaf028427dd8d"));
    renderRetryButton();
    stopFlow();
}

async function redeem(): Promise<void> {
    setStatusText(ui("m_c5e408a98fcff5ee"));
    try {
        const res = await fetch('/api/qr-login/redeem', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, secret }),
        });
        if (res.ok) {
            stopFlow();
            setStatusText(ui("m_b962efbd7193f3fb"));
            window.location.href = getSafeRedirect();
            return;
        }
        let data: any = null;
        try {
            data = await res.json();
        } catch {
            // ignore
        }
        setStatusText(data?.error || ui("m_f9426ed57766679c"));
        renderRetryButton();
        stopFlow();
    } catch {
        setStatusText(ui("m_6284f4d1f05c1e1f"));
        renderRetryButton();
        stopFlow();
    }
}

function openQrModal(): void {
    if (!window.Swal) return;
    window.Swal.fire({
        title: ui("m_abd39a7fc1d21fb6"),
        html: `<div id="qrGuestBody">${QR_BODY_SKELETON}</div>`,
        showConfirmButton: false,
        showCloseButton: true,
        width: '340px',
        didOpen: () => {
            startFlow();
        },
        willClose: () => {
            stopFlow();
        },
    });
}

/** 로그인 페이지에서 호출: QR 로그인 트리거 버튼을 바인딩한다. */
export function initQrLogin(): void {
    const btn = document.getElementById('btnQrLogin');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        openQrModal();
    });
}
