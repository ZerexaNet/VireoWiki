/**
 * 문법 치트시트 (Syntax cheatsheet) — 제안 G-5.
 *
 * 기억나지 않는 위키 문법 토큰/블록을 **이름·용도로 검색해 커서 위치에 삽입**하는
 * 경량 검색 모달. 커맨드 팔레트(Cmd/Ctrl+K)의 "문법 치트시트" 액션과 에디터 툴바
 * 버튼(edit/main.ts 가 추가)이 진입점이며, 두 진입점 모두 `window.openSyntaxCheatsheet()`
 * 를 호출한다.
 *
 * 모달 DOM/CSS 는 커맨드 팔레트와 동일하게 첫 오픈 시 동적 주입한다(별도 CSS 파일/셸
 * 링크 불필요). 삽입은 CM6 `window._cmView` 를 직접 사용해 선택 범위를 스니펫으로
 * 교체하고, 스니펫 내 커서 센티넬('') 위치로 캐럿을 옮긴다.
 *
 * 카탈로그는 렌더러(render.ts)가 실제로 지원하는 어휘만 담는다 — 없는 문법을 넣어
 * "삽입은 되는데 렌더가 안 되는" 상태를 만들지 않는다.
 */

import { ui } from '../../../packages/wiki-shared/src/i18n/client';
import './types';
import { escapeHtml } from '../utils/html';

// 삽입 후 커서를 놓을 위치를 표시하는 센티넬(삽입 전 제거).
const CARET = '';

interface CheatEntry {
    /** 표시 이름 */
    label: string;
    /** 용도 설명 */
    desc: string;
    /** 검색 키워드(라벨/설명 외 추가 매칭 어휘) */
    keywords: string;
    /** 삽입 스니펫(CARET 로 커서 위치 지정) */
    insert: string;
    /** 미리보기용 문법 표기(모노스페이스) */
    syntax: string;
}

interface CheatSection {
    title: string;
    entries: CheatEntry[];
}

// ── 문법 카탈로그 ──────────────────────────────────────────────────────────
const CATALOG: CheatSection[] = [
    {
        title: ui("m_5ad40d10dec739e9"),
        entries: [
            { label: ui("m_fba83d218eea748c"), desc: ui("m_5e70b93f06c4552a"), keywords: ui("m_87b0c4285bb1641a"), syntax: ui("m_7c27f0abb0e69ed7"), insert: `**${CARET}**` },
            { label: ui("m_dd933ae8c2d8fac8"), desc: ui("m_6b81a8b6ee0375d9"), keywords: ui("m_45641a8e2826ec3f"), syntax: ui("m_e0143d2608b062f4"), insert: `*${CARET}*` },
            { label: ui("m_f88f8ea2b7099d9d"), desc: ui("m_f88f8ea2b7099d9d"), keywords: ui("m_79a9e92a9823d2d8"), syntax: ui("m_28ee3b434f7fbc8a"), insert: `__${CARET}__` },
            { label: ui("m_a862dac745e78146"), desc: ui("m_a862dac745e78146"), keywords: ui("m_9605541606a51a5d"), syntax: ui("m_164ece50125e1e53"), insert: `~~${CARET}~~` },
            { label: ui("m_425c77dfa9261c85"), desc: ui("m_b7426c44e328feab"), keywords: ui("m_60941b9372553b49"), syntax: ui("m_e5ebe60e52d4d291"), insert: ui("m_ecdfb1788e6e5c75", [CARET]) },
            { label: ui("m_c3405f8c7d9d392a"), desc: ui("m_7c7c786c576b8eb3"), keywords: ui("m_7a5a6074fcb22b40"), syntax: ui("m_6ab7acb2deb94bde"), insert: `## ${CARET}` },
            { label: ui("m_8d79ff34d4f67a6e"), desc: ui("m_0ce0c96ab3059495"), keywords: ui("m_24eb627b33e92123"), syntax: ui("m_195f9d1a2608f871"), insert: '`' + CARET + '`' },
            { label: ui("m_02c2cc5f07593701"), desc: ui("m_722dbffc4414f098"), keywords: ui("m_788ad98034524474"), syntax: ui("m_7381a56fb257da46"), insert: `## ${CARET} {collapse}` },
        ],
    },
    {
        title: ui("m_63fe65fbe46155a9"),
        entries: [
            { label: ui("m_6d2b296c1cd03af4"), desc: ui("m_4d7af31a1fd5bfce"), keywords: ui("m_a799735f3ebb03cb"), syntax: '{bg:#RRGGBB}', insert: `{bg:${CARET}}` },
            { label: ui("m_04b9d4d0d299bc60"), desc: ui("m_3c40a3091a0e1668"), keywords: ui("m_560b02f2ba31d1f5"), syntax: '{color:#RRGGBB}', insert: `{color:${CARET}}` },
            { label: ui("m_8fd7bf321f4cb142"), desc: ui("m_0749a92d98df30a3"), keywords: ui("m_ca9845d3588058b3"), syntax: '{palette:primary}', insert: `{palette:${CARET}}` },
            { label: ui("m_6b28ff42c3bd1e53"), desc: ui("m_4bad4a16e714cbee"), keywords: ui("m_b53aac0c18c9b535"), syntax: '{fs:lg}', insert: `{fs:${CARET}}` },
        ],
    },
    {
        title: ui("m_ba2e24e6750375d5"),
        entries: [
            { label: ui("m_1d1a784d512f3d57"), desc: ui("m_4e03ec5334e74e4c"), keywords: ui("m_30ccd27a372b1e49"), syntax: '{bi:star}', insert: `{bi:${CARET}}` },
            { label: ui("m_1f038fec36e3ef39"), desc: ui("m_59252e6364e70887"), keywords: ui("m_37e5baccbef61206"), syntax: '{mdi:home}', insert: `{mdi:${CARET}}` },
            { label: ui("m_57ff1b60f5b9be4b"), desc: ui("m_cfb78faa23dd4a6f"), keywords: ui("m_bdbe40566cd2f81d"), syntax: ui("m_e1119c65933c92d1"), insert: `{badge:${CARET}}` },
            { label: ui("m_e24f8f799a09913f"), desc: ui("m_8b037fd8c5402754"), keywords: ui("m_542ba3c621b8a37e"), syntax: ui("m_aadeffbf7c926876"), insert: `{tag:${CARET}}` },
            { label: ui("m_605632038f49400b"), desc: ui("m_d35505adc98ef0c0"), keywords: ui("m_a168d5a58c13ccf4"), syntax: ui("m_98d83eb186555ae4"), insert: ui("m_1e8943dde4c14dbe", [CARET]) },
            { label: ui("m_30c765b107c5eb5a"), desc: ui("m_84ecd62d6ae48287"), keywords: ui("m_90f74d94326bae42"), syntax: ui("m_d8feb24858e3b649"), insert: ui("m_20d2f907b69fe58e", [CARET]) },
            { label: ui("m_2fe5356cb0530f05"), desc: ui("m_54257d4a537853ff"), keywords: ui("m_d7847edfc4e1daf9"), syntax: '{kbd:Ctrl+C}', insert: `{kbd:${CARET}}` },
            { label: ui("m_6bbd4af8328c9ba6"), desc: ui("m_8d24e901ebb500be"), keywords: ui("m_fa7d9bcdb08c890f"), syntax: '{progress:70}', insert: `{progress:${CARET}}` },
        ],
    },
    {
        title: ui("m_77fb16dee5514e18"),
        entries: [
            { label: ui("m_482456fb5ca84f27"), desc: ui("m_6dafcb53f03855a1"), keywords: ui("m_07c8d2eaeda97ec9"), syntax: ui("m_ec3a11cca7c57eeb"), insert: `[[${CARET}]]` },
            { label: ui("m_282b19bc77204d16"), desc: ui("m_4f228ede45ed04d8"), keywords: ui("m_442639c8443f627b"), syntax: ui("m_457114ee2acc1c24"), insert: `{{${CARET}}}` },
            { label: ui("m_78ca2b93ff924626"), desc: ui("m_986eddf472ab6404"), keywords: ui("m_e317d2501c3cc784"), syntax: ui("m_34e72d21069043d5"), insert: `{{{${CARET}}}}` },
            { label: ui("m_d72cd75279d7b329"), desc: ui("m_bd6cc888c6ab9ecd"), keywords: ui("m_bfdf9c84a40c551c"), syntax: ui("m_d6d03ba9e7cdc40e"), insert: ui("m_1c4b0effa5ee1b68", [CARET]) },
            { label: ui("m_37c27f988750a4d2"), desc: ui("m_cec0f2d90e9c7ea9"), keywords: ui("m_f1da77da10bea126"), syntax: ui("m_fee80b881568c844"), insert: ui("m_2da25cc1311428c9", [CARET]) },
            { label: ui("m_20b90f10d2bc1a07"), desc: ui("m_5faada11476c7ca3"), keywords: ui("m_f261f375b763025b"), syntax: '{{#expr:1 + 2}}', insert: `{{#expr:${CARET}}}` },
            { label: ui("m_857a13037ceeb267"), desc: ui("m_804af85d7bed565b"), keywords: ui("m_af615ff3c5ed19de"), syntax: ui("m_ae3750a1f5f51449"), insert: ui("m_330f2dcca9e6ca91", [CARET]) },
        ],
    },
    {
        title: ui("m_77a8a5d48e0ec576"),
        entries: [
            { label: ui("m_d24c10d37db0feea"), desc: ui("m_b2fd5e226f6b38d1"), keywords: ui("m_be55173c7e7eb5a4"), syntax: '![alt](URL)', insert: `![${CARET}]()` },
            { label: ui("m_2810cd41e255386b"), desc: ui("m_acf497c8753ad9b9"), keywords: ui("m_abc73f4524e8c1ae"), syntax: '{size:medium}', insert: `{size:${CARET}}` },
            { label: ui("m_0af5878da3772fe3"), desc: ui("m_fdbbd1b98a5312fc"), keywords: ui("m_bc36ee263d186ae6"), syntax: '{align:center}', insert: `{align:${CARET}}` },
            { label: ui("m_c9420abd33d772ed"), desc: ui("m_5fdba67640e01bbf"), keywords: ui("m_473ec399206fecdb"), syntax: ui("m_7dfe175110f64f08"), insert: `{caption:${CARET}}` },
            { label: ui("m_588be0deb770b095"), desc: ui("m_b1eb718abc171730"), keywords: ui("m_3cd8a2a6e594de28"), syntax: '{embed:URL}', insert: `{embed:${CARET}}` },
            { label: ui("m_626df1ec399ef16e"), desc: ui("m_1685c0c8b5916d94"), keywords: ui("m_3f121d5b04e38b63"), syntax: '{embed:URL}{size:small}', insert: `{embed:URL}{size:${CARET}}` },
        ],
    },
    {
        title: ui("m_055eb7ff930783f3"),
        entries: [
            { label: ui("m_eab19781a95f8ba4"), desc: ui("m_5dfac4d259681910"), keywords: ui("m_1967cf4ff8d3e05a"), syntax: '{table:center}', insert: `{table:${CARET}}` },
            { label: ui("m_cae9028f5ba8b3a3"), desc: ui("m_710178eac8c6c859"), keywords: ui("m_3aceb5cf2a6b4af9"), syntax: '{w:50%}', insert: `{w:${CARET}}` },
            { label: ui("m_50a94e45fa19f96f"), desc: ui("m_acb79305cdb79a39"), keywords: ui("m_f2b718b14c7ea3fe"), syntax: ui("m_2ab6f421dabfe446"), insert: `{caption:${CARET}}` },
            { label: ui("m_a38b0a754df466ae"), desc: ui("m_ad58615453d6b0b1"), keywords: ui("m_abaf6d2bf557ed75"), syntax: '{sticky-header}', insert: '{sticky-header}' },
            { label: ui("m_5cde908049d1520b"), desc: ui("m_33660b9f2ee02506"), keywords: ui("m_70e4ac9277083c00"), syntax: '{sortable}', insert: '{sortable}' },
            { label: ui("m_995cce3fccaa251b"), desc: ui("m_63ea5efb0ef87398"), keywords: ui("m_4b72e6a48983f4bf"), syntax: '{row-header}', insert: '{row-header}' },
        ],
    },
    {
        title: ui("m_4692cef5ac69eb37"),
        entries: [
            { label: ui("m_563d700698b2e153"), desc: ui("m_4389adee0f33fa83"), keywords: ui("m_1405cf22ddb2f9a2"), syntax: '{dday:2026-01-01}', insert: `{dday:${CARET}}` },
            { label: ui("m_e8e55f63b04c532c"), desc: ui("m_906e695a9dd195d4"), keywords: ui("m_4021494af219130b"), syntax: '{time:1735689600}', insert: `{time:${CARET}}` },
            { label: ui("m_39434f4dbd6aa9ad"), desc: ui("m_b2a3929e82f566cf"), keywords: ui("m_d6fbe7b84eaa393f"), syntax: '{timer:1735689600}', insert: `{timer:${CARET}}` },
            { label: ui("m_57b8d86c7074f30c"), desc: ui("m_32bec01b8725cfd4"), keywords: ui("m_7d01647a9637b258"), syntax: '{age:2000-01-01}', insert: `{age:${CARET}}` },
            { label: ui("m_b9a2602b5dd2c5b7"), desc: ui("m_0d59048a5e3146e0"), keywords: ui("m_cf168b44190eb3cc"), syntax: '{calendar:2026-01-01}', insert: `{calendar:${CARET}}` },
        ],
    },
    {
        title: ui("m_986794778c6f6fc3"),
        entries: [
            { label: ui("m_62b41b5aaec6fef4"), desc: ui("m_155774e65ecb6263"), keywords: ui("m_b3f4e8fc2790045f"), syntax: ':::card', insert: `:::card ${CARET}\n\n:::` },
            { label: ui("m_14a173232a613b6e"), desc: ui("m_03d0d662f6417857"), keywords: ui("m_4f5ec595721386a2"), syntax: ':::grid {cols:2}', insert: `:::grid {cols:2}\n${CARET}\n\n:::` },
            { label: ui("m_328263b28ff57998"), desc: ui("m_5511e6819e5f7622"), keywords: ui("m_d55c4e8d8a03ccb0"), syntax: ':::canvas', insert: `:::canvas {gap:md}\n:::area {span:8} {panel}\n${CARET}\n:::\n:::area {span:4} {panel}\n\n:::\n:::` },
            { label: ui("m_5430ebf3366f2ff9"), desc: ui("m_426a72d1fe03a6ca"), keywords: ui("m_89aa7d3181af6159"), syntax: ':::infobox', insert: ui("m_58432bbf1955743f", [CARET]) },
            { label: ui("m_18d0e6bc2a7f45bd"), desc: ui("m_17e105d42bc57a79"), keywords: ui("m_5591bfd19eb12134"), syntax: ':::float {right} {span:4}', insert: `:::float {right} {span:4}\n${CARET}\n\n:::` },
            { label: ui("m_5cd4cd76699a6fd0"), desc: ui("m_88c22b4254856d07"), keywords: ui("m_96fc4cbfbbb4a68b"), syntax: ':::gallery {cols:3}', insert: `:::gallery {cols:3}\n![](${CARET})\n![]()\n:::` },
            { label: ui("m_28badb093c233e15"), desc: ui("m_d77ec0c5d65354a6"), keywords: ui("m_729d61eb72abd520"), syntax: ':::tabs', insert: ui("m_3c8db42388fda965", [CARET]) },
            { label: ui("m_9a076cf23c023e1a"), desc: ui("m_b2e85d62c21ea26c"), keywords: ui("m_ae717844f311cab8"), syntax: ':::accordion', insert: ui("m_44b0836ae9501f74", [CARET]) },
            { label: ui("m_a096cdeecea40a9d"), desc: ui("m_db3b5555c19bee61"), keywords: ui("m_879aa0b087e1fb3a"), syntax: ':::steps', insert: ui("m_6eaaaff58dad3cc3", [CARET]) },
            { label: ui("m_d22e12c683a74d09"), desc: ui("m_23249fcbb4541ae0"), keywords: ui("m_03ef46a22b868a2c"), syntax: ':::meta', insert: ui("m_79847f774c9abf5a", [CARET]) },
            { label: ui("m_e4aa9f3cc7f52ddd"), desc: ui("m_2a1a5d18bb46c4ec"), keywords: ui("m_959f447cf8bdc114"), syntax: ':::embed', insert: `:::embed\n${CARET}\n\n:::` },
            { label: ui("m_128b0dfe35235930"), desc: ui("m_5876fdcab265e1f3"), keywords: ui("m_8b2b237e6910529a"), syntax: ':::after 2026-01-01', insert: `:::after ${CARET}\n\n:::` },
            { label: ui("m_745bc68d37465f9d"), desc: ui("m_07a947f26ac6ae13"), keywords: ui("m_e907c60ac4bad13f"), syntax: ':::until 2026-01-01', insert: `:::until ${CARET}\n\n:::` },
        ],
    },
    {
        title: ui("m_f231c50e8d5e879c"),
        entries: [
            { label: ui("m_28fe61bef75af3d5"), desc: ui("m_4a609a79cafc842c"), keywords: ui("m_3a337dba478e1b62"), syntax: ':::info', insert: `:::info\n${CARET}\n\n:::` },
            { label: ui("m_4fa4e2ac36cd09f1"), desc: ui("m_bbca38e930cbff68"), keywords: ui("m_473ec26f3b031ee0"), syntax: ':::tip', insert: `:::tip\n${CARET}\n\n:::` },
            { label: ui("m_261ff49b524384f1"), desc: ui("m_8486ba3807e58e90"), keywords: ui("m_9cb03ca06ba3b0e7"), syntax: ':::success', insert: `:::success\n${CARET}\n\n:::` },
            { label: ui("m_833a2943e99a7d7f"), desc: ui("m_9b460cad5e7cae7e"), keywords: ui("m_cb0c12f7fe7188a5"), syntax: ':::warning', insert: `:::warning\n${CARET}\n\n:::` },
            { label: ui("m_d9fc0886a0acb827"), desc: ui("m_86ab151104bb5f57"), keywords: ui("m_f93695c7580de589"), syntax: ':::danger', insert: `:::danger\n${CARET}\n\n:::` },
            { label: ui("m_88530cabd97e47c4"), desc: ui("m_f777f1fd9661c4ac"), keywords: ui("m_3963bd77a691fad5"), syntax: ':::note', insert: `:::note\n${CARET}\n\n:::` },
        ],
    },
    {
        title: ui("m_af4eb87c4024e6a8"),
        entries: [
            { label: ui("m_c8084b4d279d80e4"), desc: ui("m_4e005affa741cdd5"), keywords: ui("m_f4b700906190aaae"), syntax: '```chart', insert: '```chart\ntype: bar\nlabels: [A, B, C]\nseries:\n  - ' + CARET + '1, 2, 3\n```' },
            { label: ui("m_b49df9362b9fc04c"), desc: ui("m_10f31f3c85ee150f"), keywords: ui("m_39f01b610b764d12"), syntax: '```mermaid', insert: '```mermaid\n' + CARET + '\n```' },
        ],
    },
];

// ── 검색 인덱스 ────────────────────────────────────────────────────────────
interface FlatEntry extends CheatEntry { section: string; }
const FLAT: FlatEntry[] = CATALOG.flatMap(sec => sec.entries.map(e => ({ ...e, section: sec.title })));

function matches(e: FlatEntry, term: string): boolean {
    if (!term) return true;
    const t = term.toLowerCase();
    return e.label.toLowerCase().includes(t)
        || e.desc.toLowerCase().includes(t)
        || e.keywords.toLowerCase().includes(t)
        || e.syntax.toLowerCase().includes(t)
        || e.section.toLowerCase().includes(t);
}

// ── 삽입 (CM6 직접) ─────────────────────────────────────────────────────────
function insertSnippet(snippet: string): void {
    const view = (window as unknown as { _cmView?: any })._cmView;
    const markerIdx = snippet.indexOf(CARET);
    const clean = markerIdx >= 0 ? snippet.replace(CARET, '') : snippet;
    if (!view || !view.state) {
        // 폴백: shim 삽입(캐럿 지정 불가)
        window.editor?.insertText?.(clean);
        return;
    }
    const sel = view.state.selection.main;
    const from = sel.from;
    const to = sel.to;
    const caretPos = markerIdx >= 0 ? from + markerIdx : from + clean.length;
    view.dispatch({ changes: { from, to, insert: clean }, selection: { anchor: caretPos } });
    view.focus();
}

// ── 모달 UI ────────────────────────────────────────────────────────────────
let overlayEl: HTMLDivElement | null = null;
let inputEl: HTMLInputElement | null = null;
let listEl: HTMLUListElement | null = null;
let triggerEl: Element | null = null;
let selectable: FlatEntry[] = [];
let activeIdx = -1;
let curQuery = '';

const STYLE_ID = 'syntax-cheatsheet-styles';

function ensureStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.cheat-overlay { position: fixed; inset: 0; z-index: 20000; display: flex; align-items: flex-start; justify-content: center; padding-top: 10vh; background: rgba(0,0,0,0.4); }
.cheat-overlay[hidden] { display: none; }
.cheat-panel { width: min(640px, 92vw); max-height: 76vh; display: flex; flex-direction: column; background: var(--wiki-card-bg, #fff); border: 1px solid var(--wiki-border, #d0d7de); border-radius: var(--wiki-radius-lg, 8px); box-shadow: 0 12px 40px rgba(0,0,0,0.3); overflow: hidden; }
.cheat-input-wrap { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--wiki-border, #d0d7de); }
.cheat-input-wrap > i { color: var(--wiki-text-muted, #6e7781); font-size: 1.1rem; }
.cheat-input { flex: 1; border: none; outline: none; background: transparent; font-size: 1rem; color: var(--wiki-text, #1f2328); }
.cheat-esc { font-size: 0.7rem; color: var(--wiki-text-muted, #6e7781); border: 1px solid var(--wiki-border, #d0d7de); border-radius: 4px; padding: 1px 5px; }
.cheat-list { list-style: none; margin: 0; padding: 6px 0; overflow-y: auto; }
.cheat-group { padding: 8px 14px 4px; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; color: var(--wiki-text-muted, #6e7781); }
.cheat-item { display: flex; align-items: baseline; gap: 10px; padding: 7px 14px; cursor: pointer; }
.cheat-item.active, .cheat-item:hover { background: var(--wiki-bg, #f6f8fa); }
.cheat-item .cheat-label { font-weight: 600; color: var(--wiki-text, #1f2328); white-space: nowrap; }
.cheat-item .cheat-desc { flex: 1; font-size: 0.82rem; color: var(--wiki-text-muted, #6e7781); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cheat-item .cheat-syntax { font-family: var(--wiki-font-mono, monospace); font-size: 0.78rem; color: var(--wiki-primary, #0969da); background: var(--wiki-bg, #f6f8fa); border: 1px solid var(--wiki-border, #d0d7de); border-radius: 4px; padding: 1px 6px; white-space: nowrap; max-width: 46%; overflow: hidden; text-overflow: ellipsis; }
.cheat-empty { padding: 24px 14px; text-align: center; color: var(--wiki-text-muted, #6e7781); font-size: 0.9rem; }
.cheat-foot { display: flex; gap: 14px; padding: 8px 14px; border-top: 1px solid var(--wiki-border, #d0d7de); font-size: 0.72rem; color: var(--wiki-text-muted, #6e7781); }
.cheat-foot kbd { border: 1px solid var(--wiki-border, #d0d7de); border-radius: 3px; padding: 0 4px; font-size: 0.68rem; }
`;
    document.head.appendChild(style);
}

function ensureDom(): void {
    if (overlayEl) return;
    ensureStyles();

    overlayEl = document.createElement('div');
    overlayEl.className = 'cheat-overlay';
    overlayEl.setAttribute('role', 'dialog');
    overlayEl.setAttribute('aria-modal', 'true');
    overlayEl.setAttribute('aria-label', ui("m_7411923f3565f219"));
    overlayEl.hidden = true;
    overlayEl.innerHTML =
        '<div class="cheat-panel" role="document">' +
        '<div class="cheat-input-wrap">' +
        '<i class="mdi mdi-book-search-outline" aria-hidden="true"></i>' +
        '<input type="text" class="cheat-input" id="cheatInput" autocomplete="off" spellcheck="false" ' +
        ui("m_adfbc5b5031b3785") +
        ui("m_6fa21481d0463d65") +
        '</div>' +
        ui("m_353196e2f209db14") +
        ui("m_01f3562e8937f940") +
        '</div>';
    document.body.appendChild(overlayEl);
    inputEl = overlayEl.querySelector('#cheatInput');
    listEl = overlayEl.querySelector('#cheatList');

    overlayEl.addEventListener('mousedown', (e) => { if (e.target === overlayEl) close(); });
    inputEl!.addEventListener('input', () => { curQuery = inputEl!.value.trim(); render(); });
    inputEl!.addEventListener('keydown', onKey);
}

function render(): void {
    if (!listEl) return;
    selectable = [];
    let html = '';
    let lastSection = '';
    for (const e of FLAT) {
        if (!matches(e, curQuery)) continue;
        if (e.section !== lastSection) {
            html += '<li class="cheat-group" role="presentation">' + escapeHtml(e.section) + '</li>';
            lastSection = e.section;
        }
        const idx = selectable.length;
        selectable.push(e);
        html +=
            '<li class="cheat-item" role="option" id="cheat-opt-' + idx + '" data-idx="' + idx + '">' +
            '<span class="cheat-label">' + escapeHtml(e.label) + '</span>' +
            '<span class="cheat-desc">' + escapeHtml(e.desc) + '</span>' +
            '<span class="cheat-syntax">' + escapeHtml(e.syntax) + '</span>' +
            '</li>';
    }
    if (selectable.length === 0) {
        html = ui("m_0c8ad43d75788277");
    }
    listEl.innerHTML = html;
    listEl.querySelectorAll<HTMLLIElement>('.cheat-item').forEach((el) => {
        el.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            const i = Number(el.dataset.idx);
            if (selectable[i]) choose(i);
        });
        el.addEventListener('mousemove', () => {
            const i = Number(el.dataset.idx);
            if (i !== activeIdx) { activeIdx = i; updateActive(); }
        });
    });
    activeIdx = selectable.length ? 0 : -1;
    updateActive();
}

function updateActive(): void {
    if (!listEl || !inputEl) return;
    const items = listEl.querySelectorAll<HTMLLIElement>('.cheat-item');
    items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
    if (activeIdx >= 0 && items[activeIdx]) {
        items[activeIdx].scrollIntoView({ block: 'nearest' });
        inputEl.setAttribute('aria-activedescendant', 'cheat-opt-' + activeIdx);
    } else {
        inputEl.setAttribute('aria-activedescendant', '');
    }
}

function choose(idx: number): void {
    const e = selectable[idx];
    if (!e) return;
    close();
    insertSnippet(e.insert);
}

function onKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (selectable.length) { activeIdx = Math.min(activeIdx + 1, selectable.length - 1); updateActive(); }
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (selectable.length) { activeIdx = Math.max(activeIdx - 1, 0); updateActive(); }
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIdx >= 0) choose(activeIdx);
    } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
    }
}

function isOpen(): boolean { return !!overlayEl && !overlayEl.hidden; }

function open(): void {
    ensureDom();
    if (isOpen()) return;
    triggerEl = document.activeElement;
    curQuery = '';
    inputEl!.value = '';
    overlayEl!.hidden = false;
    render();
    requestAnimationFrame(() => inputEl?.focus());
}

function close(): void {
    if (!overlayEl || overlayEl.hidden) return;
    overlayEl.hidden = true;
    // 삽입 대상 에디터로 포커스 복귀(삽입 경로는 자체적으로 view.focus() 호출).
    if (triggerEl instanceof HTMLElement && document.contains(triggerEl) && !triggerEl.closest('.cheat-overlay')) {
        triggerEl.focus();
    }
    triggerEl = null;
}

// ── 전역 노출 ──────────────────────────────────────────────────────────────
declare global {
    interface Window {
        openSyntaxCheatsheet?: () => void;
    }
}
window.openSyntaxCheatsheet = open;

console.log('[edit/cheatsheet] module loaded');
