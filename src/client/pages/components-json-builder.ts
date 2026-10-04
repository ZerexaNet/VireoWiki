/**
 * 컴포넌트 JSON 빌더(/components-json-builder) 클라이언트 스크립트.
 *
 * wrangler.toml 의 `SIDEBAR` / `FOOTER` 환경변수에 넣을 네비게이션 JSON 을
 * GUI 로 제작·편집하는 운영자용 보조 도구. 서버 호출 없이 전적으로 브라우저에서
 * 동작하며, 결과 JSON 을 복사해 운영자가 직접 `wrangler.toml` 에 붙여넣는다.
 *
 * - sweetalert2 (CDN, window.Swal) 로 항목 추가 모달/토스트를 표시한다.
 * - HTML on* 핸들러(onclick)에서 호출되는 함수는 window.* 로 노출한다.
 * - escapeHtml 은 공통 유틸을 재사용해 innerHTML 삽입을 안전하게 처리한다.
 */

import { ui } from '../../../packages/wiki-shared/src/i18n/client';
import { escapeHtml } from '../utils/html';
import '../utils/swal';

type NavTarget = 'sidebar' | 'footer';
type NavItemType = 'link' | 'header' | 'text' | 'divider';

interface NavItem {
    type: NavItemType;
    text?: string;
    url?: string;
    icon?: string;
}

// 상태 관리를 위한 데이터 배열 (초기값 빈 배열)
const configData: Record<NavTarget, NavItem[]> = {
    sidebar: [],
    footer: [],
};

// 리스트 렌더링 및 JSON 업데이트 함수
function renderList(target: NavTarget): void {
    const listElement = document.getElementById(`${target}List`);
    const countElement = document.getElementById(`${target}Count`);
    if (!listElement || !countElement) return;
    const data = configData[target];

    countElement.textContent = String(data.length);

    if (data.length === 0) {
        listElement.innerHTML = ui("m_38ed9f4ba6124ff7");
    } else {
        listElement.innerHTML = data
            .map((item, idx) => {
                let badge = '';
                const iconHtml = item.icon ? `<i class="${escapeHtml(item.icon)} me-2"></i>` : '';

                if (item.type === 'header') badge = ui("m_50d31cce0e90b6f0");
                else if (item.type === 'link') badge = ui("m_b96d7c3b45d30da9");
                else if (item.type === 'text') badge = ui("m_ed6dbf8ac2b22530");
                else if (item.type === 'divider') badge = ui("m_505d97348549989a");

                let content = '';
                if (item.type === 'divider') {
                    content = `<span class="text-muted w-100"><hr class="my-1"></span>`;
                } else {
                    content = `
                        <div class="flex-grow-1 text-truncate">
                            <span class="fw-bold">${iconHtml}${escapeHtml(item.text || '')}</span>
                            ${item.url ? `<div class="text-muted small mt-1 text-truncate" style="font-family: monospace;"><i class="mdi mdi-link-variant me-1"></i>${escapeHtml(item.url)}</div>` : ''}
                        </div>
                    `;
                }

                return ui("m_602245ed4eaa4f92", [target, idx, idx === 0 ? 'disabled' : '', target, idx, idx === data.length - 1 ? 'disabled' : '', badge, content, target, idx]);
            })
            .join('');
    }

    updateJsonOutput(target);
}

// JSON 출력 업데이트
function updateJsonOutput(target: NavTarget): void {
    const textarea = document.getElementById(`${target}JsonOut`) as HTMLTextAreaElement | null;
    if (!textarea) return;
    // JSON 결과물을 항상 minify 하여 출력
    textarea.value = JSON.stringify(configData[target]);
}

// 직접 입력한 JSON 적용하기
function applyJson(target: NavTarget): void {
    const textarea = document.getElementById(`${target}JsonOut`) as HTMLTextAreaElement | null;
    if (!textarea) return;
    const jsonString = textarea.value.trim();

    // 내용을 다 지우고 적용 버튼을 누른 경우 빈 배열 처리
    if (jsonString === '') {
        configData[target] = [];
        renderList(target);
        return;
    }

    try {
        const parsedData = JSON.parse(jsonString);

        // 최상위가 배열 형식인지 검사
        if (!Array.isArray(parsedData)) {
            throw new Error(ui("m_b113aa5a6fb9a5cd"));
        }

        configData[target] = parsedData as NavItem[];
        renderList(target);

        window.Swal?.fire({
            toast: true,
            position: 'top-end',
            icon: 'success',
            title: ui("m_a7e04da8e43cf6ce"),
            showConfirmButton: false,
            timer: 1500,
        });
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        window.Swal?.fire({
            icon: 'error',
            title: ui("m_ee08022bc594ec0f"),
            html: ui("m_9ce10d6ab3c73bca", [escapeHtml(message)]),
        });
    }
}

// 항목 추가 모달 (SweetAlert2)
async function addItem(target: NavTarget, type: NavItemType): Promise<void> {
    if (type === 'divider') {
        configData[target].push({ type: 'divider' });
        renderList(target);
        return;
    }

    let title = '';
    if (type === 'header') title = ui("m_ca2c953402996b21");
    if (type === 'link') title = ui("m_b5ba46e9a638e4d1");
    if (type === 'text') title = ui("m_1abf0e0da64cca16");

    let html = ui("m_338d167f3755a272");

    if (type === 'link') {
        html += ui("m_270d377dea8d48d6");
    }

    if (type !== 'header') {
        html += ui("m_8917df7098c56ec2");
    }

    const result = await window.Swal?.fire<NavItem | false>({
        title,
        html,
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: ui("m_20df662357441cfb"),
        cancelButtonText: ui("m_2cd0f3be8738a86c"),
        confirmButtonColor: target === 'sidebar' ? '#0d6efd' : '#0dcaf0',
        didOpen: () => {
            const iconInput = document.getElementById('swal-input-icon') as HTMLInputElement | null;
            const iconPreview = document.getElementById('swal-icon-preview');
            const pickBtn = document.getElementById('swal-icon-pick-btn');
            if (!iconInput) return; // header 타입 등 아이콘 필드가 없는 경우

            // 입력값(직접 입력/피커 선택)을 좌측 미리보기 아이콘에 반영.
            const syncPreview = () => {
                if (!iconPreview) return;
                const val = iconInput.value.trim();
                iconPreview.className = val || 'mdi mdi-star-outline';
            };
            iconInput.addEventListener('input', syncPreview);

            // 아이콘 선택기 모달(iconPicker.ts). 결과는 이미 'mdi mdi-<이름>' /
            // 'bi bi-<이름>' 형식의 class 문자열이므로 그대로 입력값에 채운다.
            pickBtn?.addEventListener('click', async () => {
                if (typeof window.pickWikiIcon !== 'function') return;
                const picked = await window.pickWikiIcon();
                if (picked) {
                    iconInput.value = picked;
                    syncPreview();
                }
            });
        },
        preConfirm: () => {
            const textInput = document.getElementById('swal-input-text') as HTMLInputElement | null;
            const urlInput = document.getElementById('swal-input-url') as HTMLInputElement | null;
            const iconInput = document.getElementById('swal-input-icon') as HTMLInputElement | null;
            const text = textInput ? textInput.value.trim() : '';
            const url = urlInput ? urlInput.value.trim() : '';
            const icon = iconInput ? iconInput.value.trim() : '';

            if (!text) {
                window.Swal?.showValidationMessage(ui("m_22897b499b8bab6e"));
                return false;
            }
            if (type === 'link' && !url) {
                window.Swal?.showValidationMessage(ui("m_2cfeb3c9d255eb1a"));
                return false;
            }

            const item: NavItem = { type, text };
            if (url) item.url = url;
            if (icon) item.icon = icon;
            return item;
        },
    });

    const formValues = result?.value;
    if (formValues) {
        configData[target].push(formValues);
        renderList(target);

        window.Swal?.fire({
            toast: true,
            position: 'top-end',
            icon: 'success',
            title: ui("m_79a3d5f833e14e45"),
            showConfirmButton: false,
            timer: 1500,
        });
    }
}

// 항목 이동 (위/아래)
function moveItem(target: NavTarget, index: number, direction: number): void {
    const arr = configData[target];
    const newIndex = index + direction;

    if (newIndex < 0 || newIndex >= arr.length) return;

    [arr[index], arr[newIndex]] = [arr[newIndex], arr[index]];

    renderList(target);
}

// 항목 삭제
function deleteItem(target: NavTarget, index: number): void {
    configData[target].splice(index, 1);
    renderList(target);
}

// 전체 초기화
function clearAll(): void {
    window.Swal?.fire({
        title: ui("m_91211d8faac71c08"),
        text: ui("m_f24ee40fb98f74fb"),
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#dc3545',
        confirmButtonText: ui("m_321d3a69a12109cf"),
        cancelButtonText: ui("m_2cd0f3be8738a86c"),
    }).then((res) => {
        if (res?.isConfirmed) {
            configData.sidebar = [];
            configData.footer = [];
            renderList('sidebar');
            renderList('footer');
        }
    });
}

function showCopySuccess(): void {
    window.Swal?.fire({
        toast: true,
        position: 'top-end',
        icon: 'success',
        title: ui("m_5414fc96c6e58627"),
        showConfirmButton: false,
        timer: 1500,
    });
}

// 클립보드에 JSON 복사
function copyJson(target: NavTarget): void {
    const textarea = document.getElementById(`${target}JsonOut`) as HTMLTextAreaElement | null;
    if (!textarea) return;

    textarea.select();
    textarea.setSelectionRange(0, 99999);

    try {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(textarea.value).then(() => {
                showCopySuccess();
            });
        } else {
            document.execCommand('copy');
            showCopySuccess();
        }
    } catch {
        window.Swal?.fire(ui("m_2743911f83e1da69"), ui("m_0bddd4195710081a"), 'error');
    }

    window.getSelection()?.removeAllRanges();
}

// HTML on* 핸들러용 전역 노출
declare global {
    interface Window {
        addItem: typeof addItem;
        applyJson: typeof applyJson;
        copyJson: typeof copyJson;
        clearAll: typeof clearAll;
        moveItem: typeof moveItem;
        deleteItem: typeof deleteItem;
    }
}

window.addItem = addItem;
window.applyJson = applyJson;
window.copyJson = copyJson;
window.clearAll = clearAll;
window.moveItem = moveItem;
window.deleteItem = deleteItem;

// 초기 렌더링
document.addEventListener('DOMContentLoaded', () => {
    renderList('sidebar');
    renderList('footer');
});
