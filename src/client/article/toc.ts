// @ts-nocheck — 문서 구조(목차)·읽기/Raw 모드 공유 컨트롤러(전역 위키·워크스페이스 공용).
// 두 셸이 동일한 DOM 마커를 쓰므로 ID 는 고정이다:
//   본문 #articleContent / 문서 래퍼 #articlePage / 목차 소스 #tocNav /
//   플로팅 목차 #tocFloatingPanel·#tocFloatingNav / 사이드바 목차 #wikiTocSidebarNav·
//   #wikiTocSidebarRightNav / 스크롤바 목차 레일 #tocScrollRail /
//   FAB 그룹 #scrollFabGroup / 읽기·Raw 종료 FAB.
// 스크롤스파이/플로팅/모드 상태는 인스턴스에 캡슐화한다. 프레젠테이션 문서의 읽기 모드
// 토글 시 재렌더만 셸별로 다르므로 onReadingModeToggled 콜백으로 위임한다.
// 동작은 과거 index.ts 의 목차/읽기/Raw 모드 블록과 동일하다.

import { createTocSidebarRail } from './toc-sidebar-rail';

export interface TocControllerOptions {
  /** 읽기 모드 토글 직후 호출(프레젠테이션 문서 재렌더 등 셸별 후처리). */
  onReadingModeToggled?: (active: boolean) => void;
}

export function createTocController(opts: TocControllerOptions = {}) {
  let spyLastId: string | null = null;
  let spyAttached = false;
  // 우측 목차 사이드바(docs·right-toc)의 진행 레일. 마크업이 없는 셸에서는 모든 호출이 no-op.
  const sidebarRail = createTocSidebarRail('wikiTocSidebarRightNav', 'wikiTocSidebarRightRail');
  // 목차 링크 클릭으로 고정된 헤딩 id. 스무스 스크롤이 진행되는 동안 스크롤스파이가 중간
  // 섹션들을 훑고 지나가며 활성 항목을 깜빡이게 하므로, 클릭 대상에 고정해 두고 사용자가
  // 직접 스크롤 입력(휠·터치·키보드)을 주는 순간 해제한다.
  let pinnedId: string | null = null;
  // 고정 대상이 한 번이라도 뷰포트에 들어온 적이 있는지. 스무스 스크롤은 비동기라 클릭
  // 직후에는 대상이 아직 화면 밖이다 — "화면 밖이면 해제" 규칙을 도착 전에 적용하면 정작
  // 멀리 있는 섹션을 클릭한 경우(고정이 가장 필요한 경우)에 곧바로 풀린다.
  let pinnedSeen = false;
  // 도착을 기다리는 시간 상한(ms). 스크롤이 끝내 도달하지 못하는 경우(중간에 레이아웃이
  // 바뀌어 대상이 사라짐 등) 고정이 영구히 남지 않도록 한다.
  const PIN_ARRIVAL_TIMEOUT = 3000;
  let pinnedAt = 0;
  // 고정을 건 문서의 경로. 헤딩 id 는 위치 기반(`s-1.2`)이라 다른 문서에도 같은 id 가 존재할 수
  // 있어, SPA 로 문서를 옮긴 뒤에도 고정이 남으면 새 문서의 엉뚱한 항목이 계속 활성이 된다
  // (마우스만 쓰면 releasePin 이 발화하지 않는다). 목차 클릭은 해시만 바꾸므로 경로는 그대로다.
  let pinnedPath = '';

  // ── 우측 스크롤바 목차 레일 상수 ──
  // 레일은 뷰포트 우측 끝(스크롤바 옆)에 고정되며, 상단/하단 여백으로 헤더·스크롤 FAB 그룹을 피한다.
  // 상단은 고정값이라 style.css `.toc-rail` 의 top 과 반드시 같아야 하고(JS 가 이 범위 안에서
  // 좌표를 계산), 하단은 아래 railBottomInset() 이 실측해 CSS 로 내보낸다.
  const RAIL_TOP_INSET = 72;     // px
  // 하단 여백은 스크롤 FAB 그룹을 실측해서 정한다(JS 가 --toc-rail-bottom 으로 써 넣고
  // style.css `.toc-rail` 이 그 값을 쓴다). FAB 개수는 상황에 따라 변한다 — 기본 3개(목차/
  // 맨 위로/맨 아래로)지만 읽기 모드에서는 종료 FAB 이 더 붙어 4개가 되고, temporal 로 목차가
  // 통째로 숨은 문서에서는 목차 FAB 이 빠져 2개가 된다. 개수·크기·간격을 상수로 재현하면
  // CSS 와 어긋나는 순간 조용히 틀어지므로 rect 를 읽는다. 아래 값은 실측 전(첫 프레임)
  // 폴백이며 style.css 의 `bottom` 기본값과 같아야 한다.
  const RAIL_BOTTOM_INSET = 152; // px
  // FAB 그룹 위로 남길 여유. 점은 좌표 중심 정렬(translateY(-50%))이라 히트 박스가 레일
  // 아래로 반높이(RAIL_MIN_GAP/2)만큼 삐져나오므로, 그만큼 + 여유를 함께 확보해야 최하단
  // 점의 히트 박스가 최상단 FAB 의 클릭을 삼키지 않는다.
  const RAIL_FAB_CLEARANCE = 4;  // px
  // 점의 히트 박스 높이(style.css `--toc-rail-hit-h` 기본값)와 같은 값이어야 인접 박스가 겹치지
  // 않는다 — 겹치면 뒤 형제가 히트 테스트를 가져가 "가리킨 점"과 "펼쳐지는 제목"이 어긋난다.
  const RAIL_MIN_GAP = 22;       // px
  // 점이 이보다 촘촘해지면(헤딩 수백 개) 히트 박스를 줄여도 겹침을 피할 수 없어 "가리킨 점"과
  // "펼쳐지는 제목"이 어긋난다. 그 밀도에서는 어피던스 자체가 무의미하므로 레일을 띄우지 않는다.
  const RAIL_MIN_DOT_GAP = 4;    // px
  // 전체 제목 펼침(어느 점에 호버하든 모든 제목 노출)을 켜는 최소 점 간격. 라벨 한 줄 높이
  // (fs-base × line-height 1.2 ≈ 18px)보다 촘촘하면 제목끼리 세로로 겹쳐 읽을 수 없으므로,
  // 그 밀도에서는 가리킨 점 하나만 펼친다(style.css `.toc-rail-labels` 유무로 갈린다).
  const RAIL_LABEL_MIN_GAP = 18; // px
  const RAIL_MIN_HEIGHT = 240;   // px — 이보다 낮은 뷰포트에서는 레일을 띄우지 않는다
  let railRebuildTimer: number | null = null;
  let railLayoutTimer: number | null = null;
  // 마지막으로 만든 점 구성의 시그니처(헤딩 id·레벨·라벨). 같으면 재구축 대신 좌표만 갱신한다 —
  // {timer:} 초 단위 갱신처럼 헤딩과 무관한 본문 변경이 옵저버를 계속 깨우기 때문.
  let railSignature = '';

  // ── 목차 사이드바 채우기 ──
  // docs 레이아웃에서는 본문 헤딩에 이미 번호가 있거나 중복으로 붙는 문제를 방지하기 위해
  // 문단 번호 prefix(.wiki-toc-num)를 새로 붙이지 않는다(includeNumbers = false).
  function populateSidebar(sidebarId: string, navId: string, includeNumbers?: boolean): boolean {
    const sidebar = document.getElementById(sidebarId);
    const nav = document.getElementById(navId);
    if (!sidebar || !nav) return false;
    const contentEl = document.getElementById('articleContent');
    const realHeadings = contentEl
      ? Array.from(contentEl.querySelectorAll(
          'h1:not(.accordion-header), h2:not(.accordion-header), h3:not(.accordion-header), h4:not(.accordion-header)'))
          .filter((h) => !h.closest('.wiki-footnotes'))
      : [];
    if (!realHeadings.length) {
      sidebar.classList.add('d-none');
      nav.innerHTML = '';
      if (navId === 'wikiTocSidebarRightNav') sidebarRail.build();
      return false;
    }
    const withNumbers = typeof includeNumbers === 'boolean'
      ? includeNumbers
      : (window.appConfig?.layoutMode !== 'docs' && document.body.dataset.layoutMode !== 'docs');
    let html = (contentEl && typeof window.buildTocOlHtml === 'function')
      ? window.buildTocOlHtml(contentEl, withNumbers)
      : '';
    if (!html) {
      const src = document.getElementById('tocNav');
      html = src ? src.innerHTML.trim() : '';
    }
    if (!html) {
      sidebar.classList.add('d-none');
      nav.innerHTML = '';
      if (navId === 'wikiTocSidebarRightNav') sidebarRail.build();
      return false;
    }
    nav.innerHTML = html;
    sidebar.classList.remove('d-none');
    // 재구축된 사이드바 목차에 temporal(:::after/:::until) 숨김 필터를 재적용.
    // buildTocOlHtml 은 숨김 분기 헤딩도 포함해 생성하고, 이 재구축은
    // renderWikiContent 내부의 _initTemporal 동기화보다 늦게 실행되기 때문.
    window._syncTemporalDerivedVisibility?.(document);
    // 진행 레일은 목차 링크의 실제 좌표에서 경로를 뽑으므로 DOM 이 확정된 지금 다시 그린다
    // (temporal 필터가 항목을 숨긴 뒤여야 숨은 항목이 경로에 끼지 않는다).
    // 레일은 우측 사이드바에만 있으므로 좌측(left-toc) 호출에서는 건드리지 않는다.
    if (navId === 'wikiTocSidebarRightNav') sidebarRail.build();
    return true;
  }

  // ── 플로팅 목차 패널 ──
  function toggleFloating() {
    const panel = document.getElementById('tocFloatingPanel');
    const tocSource = document.getElementById('tocNav');
    const floatingNav = document.getElementById('tocFloatingNav');
    if (!panel || !floatingNav) return;
    const isVisible = panel.classList.contains('visible');

    if (!isVisible) {
      // temporal(:::after/:::until) 필터로 전 항목이 숨겨진 목차는 없는 것으로 취급
      // (raw innerHTML 은 숨김 li 도 포함하므로 보이는 항목 기준으로 판정).
      if (!tocSource || !tocSource.querySelector('li:not([hidden])')) return;
      floatingNav.innerHTML = tocSource.innerHTML;
      floatingNav.querySelectorAll('a').forEach((a) => {
        a.addEventListener('click', () => {
          panel.classList.remove('visible');
        });
      });
      spyLastId = null;
      updateActive();
    }
    panel.classList.toggle('visible');
  }

  // ── 우측 스크롤바 목차 레일 (PC 전용) ──
  // 본문 헤딩 하나당 점 하나를 문서 내 위치 비율대로 뷰포트 우측 끝에 배치한다(미니맵 매핑).
  // 목차 사이드바가 없는 레이아웃(default·wide)에서만 띄운다. 어느 점에 호버하든 모든 헤딩
  // 제목이 카드 없이 각자의 점 옆(좌측)으로 함께 펼쳐지고, 클릭하면 FAB 목차와 동일한 경로
  // (_resolveAnchorTarget → _scrollToElementWithAncestors)로 해당 헤딩까지 스크롤한다.
  // 목차 패널·사이드바와 같은 목차를 포인터 전용으로 중복 제공하므로 키보드/스크린리더 경로는
  // 기존 목차가 담당한다(컨테이너 aria-hidden, 점은 포커스 대상이 아닌 span).

  /** 레일을 띄울 조건인지: 목차 사이드바가 없는 레이아웃 + PC 폭 + 포인터 호버 가능 +
   *  문서 페이지 노출 + Raw 모드 아님. */
  function railEligible(): boolean {
    const articlePage = document.getElementById('articlePage');
    if (!articlePage || articlePage.classList.contains('d-none')) return false;
    if (document.body.classList.contains('raw-mode')) return false;
    // 목차 사이드바가 없는 레이아웃(default·wide)에서만 — left-toc·right-toc·docs 는 같은
    // 목차를 사이드바로 상시 노출하므로 레일이 중복이다. style.css 도 같은 화이트리스트를
    // `body:not([data-layout-mode="default"]):not(...="wide"])` 로 걸어 두었으므로 모드를
    // 추가할 때는 두 곳을 함께 고친다(극성이 달라지면 빈 레일이 남는다).
    // 개인 설정 오버라이드는 body[data-layout-mode] 에 즉시 반영되므로 그쪽을 우선 읽는다.
    const mode = document.body.dataset.layoutMode || window.appConfig?.layoutMode || 'default';
    if (mode !== 'default' && mode !== 'wide') return false;
    if (window.innerHeight - RAIL_TOP_INSET - railBottomInset() < RAIL_MIN_HEIGHT) return false;
    if (typeof window.matchMedia !== 'function') return false;
    // CSS 의 노출 조건(min-width:992px + hover:hover)과 일치시켜, 숨겨질 레일을 계산하지 않는다.
    return window.matchMedia('(min-width: 992px)').matches && window.matchMedia('(hover: hover)').matches;
  }

  /** 목차에 노출되는(=temporal 숨김이 아니고 실제로 렌더된) 본문 헤딩 목록. */
  function railHeadings(): HTMLElement[] {
    const contentEl = document.getElementById('articleContent');
    if (!contentEl) return [];
    return Array.from(contentEl.querySelectorAll(
      'h1:not(.accordion-header), h2:not(.accordion-header), h3:not(.accordion-header), h4:not(.accordion-header)'))
      .filter((h) => {
        if (!h.id) return false;
        if (h.closest('.wiki-temporal[hidden]')) return false;
        // 숨겨진 조상 아래의 헤딩은 좌표가 0 이라 레일 위치를 계산할 수 없다.
        return !!(h.offsetWidth || h.offsetHeight || h.getClientRects().length);
      }) as HTMLElement[];
  }

  /** 헤딩 하나의 레일 라벨(본문 번호 prefix + 제목) — 사이드바 목차와 같은 표기.
   *  `key` 는 재구축 판정용이다. 헤딩 안에 라이브 `{timer:}` 가 있으면 텍스트가 초마다 바뀌어
   *  매초 전면 재구축이 되므로, 그 헤딩만 본문 텍스트를 빼고 id·레벨·번호로 판정한다.
   *  헤딩 id 는 텍스트가 아니라 위치 기반(`s-1.2`)이므로 트레이드오프가 있다 — 아웃라인이
   *  그대로인 채 타이머 헤딩의 제목만 바뀌면 라벨 갱신을 놓친다(초당 재구축을 피하는 대가). */
  function railLabelOf(h: HTMLElement): { num: string; text: string; key: string } {
    const numSpan = h.querySelector('.wiki-heading-num');
    let text = '';
    h.childNodes.forEach((n) => { if (n !== numSpan) text += n.textContent; });
    text = text.trim();
    return {
      num: numSpan ? (numSpan.textContent || '').trim() : '',
      text,
      key: h.querySelector('.wiki-timer') ? '' : text,
    };
  }

  /** 스크롤 FAB 그룹을 실측해 레일 하단 여백을 정한다(그룹 상단 + 점 히트 박스 반높이 + 여유).
   *  덮개는 레일 박스보다 점 히트 박스 반높이만큼 위아래로 넓다(style.css ::before) — 그
   *  삐져나온 부분까지 FAB 위에서 끝나야 최상단 FAB 의 클릭을 삼키지 않는다. */
  function railBottomInset(): number {
    const fabGroup = document.getElementById('scrollFabGroup');
    const rect = fabGroup ? fabGroup.getBoundingClientRect() : null;
    // 그룹이 없거나(다른 셸) 자식이 전부 display:none 이면 rect 가 0 이라 폴백을 쓴다.
    if (!rect || !rect.height) return RAIL_BOTTOM_INSET;
    const fabTop = window.innerHeight - rect.top;
    return Math.max(RAIL_BOTTOM_INSET, Math.ceil(fabTop) + RAIL_MIN_GAP / 2 + RAIL_FAB_CLEARANCE);
  }

  /** 이상적 위치(문서 내 비율)를 최소 간격 제약에 맞게 보정해 레일 좌표(--toc-rail-y)를
   *  확정한다. 점은 호버해도 자리를 옮기지 않고 제목만 옆으로 펼쳐지므로 좌표는 이 하나뿐이다.
   *  전체 펼침 가능 여부(`.toc-rail-labels`)도 여기서 실제 간격을 보고 정한다. */
  function layoutRailPositions() {
    const rail = document.getElementById('tocScrollRail');
    if (!rail) return;
    const dots = Array.from(rail.querySelectorAll('.toc-rail-dot')) as HTMLElement[];
    if (!dots.length) return;
    // 레일 하단은 FAB 그룹 실측값을 따른다(읽기 모드 종료 FAB 처럼 개수가 바뀌면 함께 움직인다).
    const bottomInset = railBottomInset();
    const railHeight = window.innerHeight - RAIL_TOP_INSET - bottomInset;
    // 레일을 띄우지 않는 높이에서는 좌표가 음수가 되어 점이 헤더 쪽으로 튄다. syncRail 이
    // 리사이즈 디바운스 후 레일을 비우지만, 그 사이 잔상이 보이지 않도록 여기서 감춘다 —
    // 좌표를 다시 찍지 않고 그냥 두면 옛 railHeight 로 찍힌 아래쪽 점이 그대로 남아,
    // FAB 이 늘어난 만큼(읽기 모드 진입 등) 그 위에 겹친 채 호버 제목까지 펼친다.
    if (railHeight < RAIL_MIN_HEIGHT) {
      rail.hidden = true;
      rail.classList.remove('toc-rail-labels');
      return;
    }
    rail.style.setProperty('--toc-rail-bottom', `${bottomInset}px`);
    const docHeight = Math.max(document.documentElement.scrollHeight, 1);

    let ys: number[];
    if (dots.length > 1 && (dots.length - 1) * RAIL_MIN_GAP >= railHeight) {
      // 헤딩이 너무 많아 최소 간격을 지킬 수 없으면 균등 분배로 전환한다(레일 밖으로 넘치지 않게).
      const step = railHeight / (dots.length - 1);
      ys = dots.map((_, i) => i * step);
    } else {
      // 접힌 <details> 안 등 렌더되지 않은 헤딩은 rect 가 0 이라 위치를 알 수 없다. 0 으로 두면
      // docY 가 scrollY 가 되어 점이 스크롤에 따라 튀고 최소 간격 보정이 이웃까지 끌고 가므로,
      // 직전 점 좌표를 물려받아 순서만 유지한다(재구축 시점에 목록에서 빠져 정리된다).
      let lastY = 0;
      ys = dots.map((dot) => {
        const target = document.getElementById(dot.dataset.tocRailId || '');
        const rect = target ? target.getBoundingClientRect() : null;
        if (!rect || (!rect.width && !rect.height)) return lastY;
        lastY = Math.min(Math.max((rect.top + window.scrollY) / docHeight, 0), 1) * railHeight;
        return lastY;
      });
      // 앞→뒤로 최소 간격 확보 후, 넘친 만큼 뒤→앞으로 되밀어 레일 범위 안에 가둔다.
      // 이 분기의 진입 조건이 (n-1)*GAP < railHeight 이므로 되민 결과의 ys[0] 도 항상 양수다
      // (ys[0] >= railHeight - (n-1)*GAP > 0) — 별도 하한 clamp 는 두지 않는다.
      for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + RAIL_MIN_GAP);
      for (let i = ys.length - 1; i > 0; i--) {
        if (ys[i] > railHeight) ys[i] = railHeight;
        ys[i - 1] = Math.min(ys[i - 1], ys[i] - RAIL_MIN_GAP);
      }
    }

    // 실제 간격보다 히트 박스가 크면 뒤 형제가 앞 점의 원 위를 덮어 "가리킨 점"과 "펼쳐지는 제목"이
    // 어긋난다(균등 분배 폴백에서 간격이 RAIL_MIN_GAP 미만이 될 수 있다). 최소 간격에 맞춰 줄이되,
    // 간격은 실제로 찍히는 정수 좌표 기준으로 재야 반올림분(최대 1px)만큼 다시 겹치지 않는다.
    const tops = ys.map((y) => Math.round(y));
    let minGap = RAIL_MIN_GAP;
    for (let i = 1; i < tops.length; i++) minGap = Math.min(minGap, tops[i] - tops[i - 1]);
    if (minGap < RAIL_MIN_DOT_GAP) {
      rail.hidden = true;
      rail.classList.remove('toc-rail-labels');
      return;
    }
    rail.hidden = false;
    dots.forEach((dot, i) => { dot.style.setProperty('--toc-rail-y', `${tops[i]}px`); });
    rail.style.setProperty('--toc-rail-hit-h', `${Math.floor(minGap)}px`);
    // 점 간격이 한 줄을 담을 만큼 넉넉할 때만 전체 펼침을 허용한다(그렇지 않으면 제목이 겹친다).
    rail.classList.toggle('toc-rail-labels', minGap >= RAIL_LABEL_MIN_GAP);
  }

  /** 좌표 재계산 디바운스(이미지 로드 등으로 본문 높이가 계속 변할 때 과다 계산 방지). */
  function scheduleRailLayout(delay = 120) {
    if (railLayoutTimer !== null) clearTimeout(railLayoutTimer);
    railLayoutTimer = window.setTimeout(() => {
      railLayoutTimer = null;
      layoutRailPositions();
    }, delay);
  }

  /** 레일을 현재 문서 헤딩으로 다시 만든다(멱등). 조건 미충족 시 비우고 숨긴다. */
  function syncRail() {
    const rail = document.getElementById('tocScrollRail');
    if (!rail) return;
    const headings = railEligible() ? railHeadings() : [];
    if (headings.length < 2) {
      // 헤딩이 하나뿐이면 이동 대상이 사실상 없으므로 레일을 띄우지 않는다.
      rail.innerHTML = '';
      rail.classList.remove('visible', 'toc-rail-labels');
      rail.hidden = false;
      railSignature = '';
      return;
    }

    const entries = headings.map((h) => {
      const { num, text, key } = railLabelOf(h);
      return { id: h.id, level: Math.min(Math.max(parseInt(h.tagName[1], 10), 1), 4), num, text, key };
    });
    // 필드·항목 경계를 구분자로 남긴다 — 단순 연결이면 서로 다른 헤딩 구성이 같은 문자열이 되어
    // 점이 실제 헤딩과 어긋난 채 유지될 수 있다.
    const signature = entries.map((e) => `${e.level}\x1f${e.id}\x1f${e.num}\x1f${e.key}`).join('\x1e');
    if (signature === railSignature && rail.querySelector('.toc-rail-dot')) {
      // 헤딩 구성이 그대로면 DOM 을 갈아엎지 않는다 — 호버 중인 제목이 파괴되지 않고,
      // {timer:} 같은 초 단위 본문 갱신에서 매번 전체 재생성이 일어나지 않는다.
      layoutRailPositions();
      return;
    }

    // 헤딩 제목은 사용자 입력이므로 문자열 조립 대신 textContent 로 넣는다.
    // 포인터 전용 어피던스(컨테이너 aria-hidden)이므로 button 이 아닌 span 을 쓴다 —
    // button 은 클릭 시 포커스가 aria-hidden 서브트리로 들어가 접근성 검사에 걸린다.
    const frag = document.createDocumentFragment();
    entries.forEach((e) => {
      const dot = document.createElement('span');
      dot.className = `toc-rail-dot toc-rail-lv${e.level}`;
      dot.dataset.tocRailId = e.id;
      const label = document.createElement('span');
      label.className = 'toc-rail-label';
      if (e.num) {
        const numEl = document.createElement('span');
        numEl.className = 'toc-rail-num';
        numEl.textContent = e.num;
        label.appendChild(numEl);
        label.appendChild(document.createTextNode(' '));
      }
      label.appendChild(document.createTextNode(e.text));
      dot.appendChild(label);
      frag.appendChild(dot);
    });
    rail.replaceChildren(frag);
    rail.classList.add('visible');
    railSignature = signature;
    layoutRailPositions();
    // 새 점에 현재 활성 헤딩 표시를 즉시 반영(SPA 전환 직후엔 스파이 값이 이전 문서 기준이다).
    // 여기서 updateActive() 를 부르면 레일 밖(목차 nav)까지 class 를 바꿔 아래 MutationObserver
    // 가드를 빠져나가고 재구축이 무한히 재예약되므로, 레일 표시만 직접 갱신한다.
    updateRailActive(findCurrentHeadingId());
  }

  /** 스크롤스파이 활성 헤딩을 레일 점에 반영. */
  function updateRailActive(currentId: string | null) {
    const rail = document.getElementById('tocScrollRail');
    if (!rail) return;
    rail.querySelectorAll('.toc-rail-dot.toc-active').forEach((d) => d.classList.remove('toc-active'));
    if (!currentId) return;
    const dot = rail.querySelector(`.toc-rail-dot[data-toc-rail-id="${CSS.escape(currentId)}"]`);
    if (dot) dot.classList.add('toc-active');
  }

  /** 짧은 디바운스로 레일 재구축을 예약(연속 DOM 변경·리사이즈에서 과다 계산 방지). */
  function scheduleRailSync(delay = 120) {
    if (railRebuildTimer !== null) clearTimeout(railRebuildTimer);
    railRebuildTimer = window.setTimeout(() => {
      railRebuildTimer = null;
      syncRail();
    }, delay);
  }

  function onRailClick(e: Event) {
    const dot = (e.target as Element).closest('.toc-rail-dot');
    if (!dot) return;
    const id = (dot as HTMLElement).dataset.tocRailId;
    if (!id) return;
    const target = typeof window._resolveAnchorTarget === 'function'
      ? window._resolveAnchorTarget(id)
      : document.getElementById(id);
    if (!target) return;
    history.pushState(null, '', `#${encodeURIComponent(id)}`);
    // 목차 링크 클릭과 동일하게 도착 섹션을 고정한다(스무스 스크롤 중 활성 깜빡임 방지).
    setPin(id);
    if (typeof window._scrollToElementWithAncestors === 'function') {
      window._scrollToElementWithAncestors(target, { behavior: 'smooth', block: 'start' });
    } else {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // 목차 링크 클릭과 동일하게 도착 항목을 즉시 칠한다(스무스 스크롤을 기다리지 않는다).
    spyLastId = null;
    updateActive();
  }

  // ── 스크롤 스파이 ──

  /** 활성 판정 기준선(뷰포트 상단에서 이만큼 아래를 지난 마지막 헤딩이 현재 섹션).
   *  뷰포트 높이의 25% 를 쓰되 [120, 180]px 로 묶는다 — 고정 상수는 낮은 창에서 기준선이
   *  화면 중앙까지 내려가고 큰 창에서는 헤더에 붙어, 같은 문서인데 창 크기에 따라 활성 항목이
   *  달라 보인다. 하한은 sticky 헤더 높이를, 상한은 "다음 섹션이 화면 절반을 채우기 전에는
   *  넘어가지 않는다"는 감각을 지킨다. */
  function spyOffset(): number {
    return Math.min(180, Math.max(120, Math.round(window.innerHeight * 0.25)));
  }

  /** 스크롤이 문서 최하단에 닿았는지(오차 2px). 마지막 섹션이 짧으면 기준선을 끝내 넘지
   *  못해 활성이 되지 못하므로, 이때는 마지막 헤딩을 강제로 활성으로 본다.
   *  스크롤이 아예 없는(뷰포트보다 짧은) 문서는 제외한다 — scrollHeight 는 최소 뷰포트
   *  높이라 그런 문서에서는 이 조건이 처음부터 참이 되어 항상 마지막 항목이 활성이 된다. */
  function atDocumentBottom(): boolean {
    const doc = document.documentElement;
    if (doc.scrollHeight <= window.innerHeight + 4) return false;
    return window.scrollY + window.innerHeight >= doc.scrollHeight - 2;
  }

  /** 고정 상태를 비운다(활성 재계산은 호출측이 필요할 때 한다). */
  function clearPin() {
    pinnedId = null;
    pinnedSeen = false;
    pinnedAt = 0;
    pinnedPath = '';
  }

  /** 목차 클릭으로 건 고정을 계속 유지할지. 도착 전(아직 화면 밖)에는 시간 상한까지 기다리고,
   *  한 번 화면에 들어온 뒤로는 대상이 뷰포트를 벗어나는 순간 놓아 준다. */
  function pinnedStillActive(): boolean {
    if (!pinnedId) return false;
    if (location.pathname !== pinnedPath) return false;
    const el = document.getElementById(pinnedId);
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const rendered = !!(rect.height || rect.width);
    const visible = rendered && rect.bottom > 0 && rect.top < window.innerHeight;
    if (visible) { pinnedSeen = true; return true; }
    // 아직 도착 전: 스무스 스크롤이 진행 중일 수 있으므로 상한까지 유지한다.
    if (!pinnedSeen) return Date.now() - pinnedAt < PIN_ARRIVAL_TIMEOUT;
    return false;
  }

  /** 목차 클릭 대상을 고정한다(클릭 경로 공용). */
  function setPin(id: string) {
    pinnedId = id;
    pinnedSeen = false;
    pinnedAt = Date.now();
    pinnedPath = location.pathname;
  }

  /** 목차 클릭 고정 해제 — 사용자가 직접 스크롤 입력을 준 순간 자동 스파이로 돌아간다. */
  function releasePin() {
    if (pinnedId === null) return;
    clearPin();
    spyLastId = null;
    updateActive();
  }

  function findCurrentHeadingId(): string | null {
    const articleContent = document.getElementById('articleContent');
    if (!articleContent) return null;
    // 렌더되지 않는 헤딩(접힌 :::fold·비활성 탭 pane·temporal [hidden] 분기)은 제외한다.
    // 그런 헤딩은 rect 가 전부 0 이라 "기준선을 이미 지났다"로 판정되므로, 문서 뒤쪽에 하나만
    // 있어도 스크롤 위치와 무관하게 활성을 가져간다(railHeadings 와 같은 가시성 필터).
    const headings = (Array.from(articleContent.querySelectorAll('h1, h2, h3, h4')) as HTMLElement[])
      .filter((h) => !!h.id && !!(h.offsetWidth || h.offsetHeight || h.getClientRects().length));
    if (!headings.length) return null;

    // 클릭으로 고정된 섹션이 아직 화면에 있으면 스크롤 좌표와 무관하게 그대로 유지한다.
    if (pinnedId) {
      if (pinnedStillActive()) return pinnedId;
      clearPin();
    }

    // 최하단에서는 기준선을 못 넘은 마지막 섹션도 활성으로 본다(짧은 꼬리 섹션 보정).
    if (atDocumentBottom()) return headings[headings.length - 1].id;

    const offset = spyOffset();
    let currentId: string | null = null;
    for (const h of headings) {
      if (h.getBoundingClientRect().top - offset <= 0) {
        currentId = h.id;
      } else {
        break;
      }
    }
    return currentId || headings[0].id;
  }

  function updateActive() {
    const articlePage = document.getElementById('articlePage');
    if (!articlePage || articlePage.classList.contains('d-none')) return;
    const currentId = findCurrentHeadingId();
    if (!currentId) return;
    if (currentId === spyLastId) return;
    spyLastId = currentId;

    ['tocNav', 'tocFloatingNav', 'wikiTocSidebarNav', 'wikiTocSidebarRightNav'].forEach((navId) => {
      const nav = document.getElementById(navId);
      if (!nav) return;
      nav.querySelectorAll('a.toc-active').forEach((a) => {
        a.classList.remove('toc-active');
        // 시각 강조(.toc-active)와 짝을 이루는 보조기술 신호. 목차는 링크 목록이므로
        // aria-current="true"(현재 항목)로 표시한다.
        a.removeAttribute('aria-current');
      });
      nav.querySelectorAll('a').forEach((a) => {
        const href = a.getAttribute('href') || '';
        if (href.slice(1) === currentId) {
          a.classList.add('toc-active');
          a.setAttribute('aria-current', 'true');
        }
      });
    });

    updateRailActive(currentId);
    // 우측 사이드바 진행 레일: 활성 항목 구간으로 칠을 옮긴다(경로 재계산 없음).
    sidebarRail.sync();

    const floatingNav = document.getElementById('tocFloatingNav');
    const panel = document.getElementById('tocFloatingPanel');
    if (floatingNav && panel && panel.classList.contains('visible')) {
      const activeLink = floatingNav.querySelector('a.toc-active');
      if (activeLink) {
        const navRect = floatingNav.getBoundingClientRect();
        const linkRect = activeLink.getBoundingClientRect();
        if (linkRect.top < navRect.top || linkRect.bottom > navRect.bottom) {
          activeLink.scrollIntoView({ block: 'nearest' });
        }
      }
    }

    // docs/right-toc 우측 목차 사이드바: 활성 항목이 사이드바 스크롤 영역 밖으로 밀려나면
    // 사이드바 내부 스크롤만 조정해 다시 보이게 한다(플로팅 목차 패널과 동일하게 스크롤스파이
    // 갱신 시점에만 실행). 스크롤 컨테이너는 nav 가 아니라 aside(#wikiTocSidebarRight,
    // overflow-y:auto)이며, sticky 사이드바에서 scrollIntoView 는 윈도우 스크롤까지 유발할 수
    // 있으므로 컨테이너 scrollTop 만 직접 보정한다.
    const rightSidebar = document.getElementById('wikiTocSidebarRight');
    if (rightSidebar && !rightSidebar.classList.contains('d-none')) {
      const activeLink = rightSidebar.querySelector('a.toc-active');
      if (activeLink) {
        const boxRect = rightSidebar.getBoundingClientRect();
        const linkRect = activeLink.getBoundingClientRect();
        // temporal(:::after/:::until) 숨김 헤딩에 활성 표시가 걸리면 그 목차 링크의 li 는
        // [hidden] 이라 rect 가 0 이 된다. 이 경우 top(0) < boxRect.top 가 참이 되어 사이드바를
        // 잘못 위로 스냅하므로, 렌더되지 않는(rect 0) 링크는 보정 대상에서 제외한다
        // (FAB 의 scrollIntoView 가 비렌더 대상에서 no-op 인 것과 동일한 방어).
        // 가장자리에 딱 붙은 항목은 "보이긴 하지만 잘린 것처럼" 읽히므로 여백(EDGE)을 두고
        // 그 안쪽까지 끌어온다. 레일의 칠해진 구간도 함께 보여야 하므로 항목 높이보다
        // 조금 넉넉한 값을 쓴다.
        const EDGE = 12;
        if (linkRect.width || linkRect.height) {
          if (linkRect.top < boxRect.top + EDGE) {
            rightSidebar.scrollTop -= (boxRect.top + EDGE) - linkRect.top;
          } else if (linkRect.bottom > boxRect.bottom - EDGE) {
            rightSidebar.scrollTop += linkRect.bottom - (boxRect.bottom - EDGE);
          }
        }
      }
    }
  }

  /** 렌더 직후/레이아웃 변동 시 스파이 재계산(여러 프레임 보정). */
  function refresh() {
    spyLastId = null;
    updateActive();
    // 섹션 접기/펼치기 등으로 문서 높이가 바뀌면 레일 점 좌표도 다시 계산해야 한다.
    layoutRailPositions();
    // 우측 사이드바 목차도 temporal 토글로 항목이 드나들 수 있으므로 경로를 다시 그린다
    // (크기가 그대로면 ResizeObserver 가 깨지 않는다).
    scheduleSidebarRailBuild();
    [90, 200, 340, 450].forEach((d) => setTimeout(() => {
      spyLastId = null;
      updateActive();
      layoutRailPositions();
      // 높이는 그대로인 채 링크 x 좌표만 바뀌는 경우(들여쓰기 재계산)는 ResizeObserver 가
      // 잡지 못하므로 같은 보정 시점에 레일도 다시 그린다.
      scheduleSidebarRailBuild();
    }, d));
  }

  function interceptTocLinkClick(e: Event) {
    const a = (e.target as Element).closest && (e.target as Element).closest('a[href^="#"]');
    if (!a) return;
    const hash = a.getAttribute('href');
    if (!hash || hash.length < 2) return;
    let id: string;
    try { id = decodeURIComponent(hash.slice(1)); } catch (_) { id = hash.slice(1); }
    const target = id && typeof window._resolveAnchorTarget === 'function'
      ? window._resolveAnchorTarget(id)
      : (id ? document.getElementById(id) : null);
    if (!target) return;
    e.preventDefault();
    history.pushState(null, '', hash);
    // 스무스 스크롤이 지나치는 중간 섹션들로 활성 항목이 깜빡이지 않도록 클릭 대상에 고정한다.
    // 실제 헤딩 id(=목차 링크의 href)로 고정한다 — _resolveAnchorTarget 이 탭/폴드 안의 대체
    // 앵커를 돌려줄 수 있으나, 활성 표시는 목차 링크 기준이어야 하기 때문.
    setPin(id);
    if (typeof window._scrollToElementWithAncestors === 'function') {
      window._scrollToElementWithAncestors(target, { behavior: 'smooth', block: 'start' });
    } else {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    spyLastId = null;
    updateActive();
  }

  function attachLinkInterceptors() {
    // 우측 사이드바(docs·right-toc)도 좌측과 동일하게 앵커 해석(_resolveAnchorTarget)과
    // 조상 펼치기 스크롤을 태운다 — 빠지면 접힌 섹션/탭 안의 헤딩으로 이동하지 못한다.
    ['tocNav', 'tocFloatingNav', 'wikiTocSidebarNav', 'wikiTocSidebarRightNav'].forEach((navId) => {
      const nav = document.getElementById(navId);
      if (nav && !nav._tocLinkIntercepted) {
        nav.addEventListener('click', interceptTocLinkClick);
        nav._tocLinkIntercepted = true;
      }
    });
  }

  /** 우측 사이드바 진행 레일 재계산을 짧은 디바운스로 합친다. build() 는 항목마다 rect 를
   *  읽고 경로를 다시 재므로, ResizeObserver 의 연속 발화나 리사이즈 드래그에서 프레임마다
   *  돌면 낭비다(스크롤바 레일의 scheduleRailSync 와 같은 정책). 마지막 호출 기준으로 한 번만
   *  실행한다. */
  const SIDEBAR_RAIL_DEBOUNCE = 120; // ms
  let sidebarRailTimer: number | null = null;
  function scheduleSidebarRailBuild(delay = SIDEBAR_RAIL_DEBOUNCE) {
    if (sidebarRailTimer !== null) clearTimeout(sidebarRailTimer);
    sidebarRailTimer = window.setTimeout(() => {
      sidebarRailTimer = null;
      sidebarRail.build();
    }, delay);
  }

  /** 스크롤 스파이 + 링크 인터셉터 + FAB 가시성 옵저버 부착(멱등). */
  function attachSpy() {
    attachLinkInterceptors();
    if (spyAttached) return;
    spyAttached = true;

    let ticking = false;
    const handler = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        updateActive();
        ticking = false;
      });
    };
    // 스크롤·리사이즈 모두에서 활성 헤딩 재계산(리사이즈/방향전환 시 좌표 변동 반영).
    window.addEventListener('scroll', handler, { passive: true });
    window.addEventListener('resize', handler, { passive: true });

    // 목차 클릭 고정 해제 트리거 — 사용자가 스스로 스크롤을 움직인 입력만 본다.
    // scroll 이벤트는 클릭이 유발한 스무스 스크롤에서도 발생하므로 쓸 수 없다.
    const PIN_RELEASE_KEYS = new Set([
      'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar',
    ]);
    window.addEventListener('wheel', releasePin, { passive: true });
    window.addEventListener('touchmove', releasePin, { passive: true });
    window.addEventListener('keydown', (e) => {
      if (!PIN_RELEASE_KEYS.has((e as KeyboardEvent).key)) return;
      // 검색창·편집기에서의 Space/방향키는 문서 스크롤이 아니므로 고정을 건드리지 않는다.
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      releasePin();
    }, { passive: true });

    // 우측 목차 사이드바 진행 레일: 목차 자체의 크기(줄바꿈·폰트 로드·사이드바 폭)가 바뀌면
    // 링크 좌표가 통째로 달라지므로 경로를 다시 그린다. 스크롤스파이의 활성 이동은
    // updateActive 의 sidebarRail.sync() 가 담당하며 여기서는 다루지 않는다.
    const rightNav = document.getElementById('wikiTocSidebarRightNav');
    if (rightNav && typeof ResizeObserver === 'function') {
      new ResizeObserver(() => scheduleSidebarRailBuild()).observe(rightNav);
    }
    // 폭만 바뀌어 nav 높이가 그대로인 리사이즈(들여쓰기 x 좌표는 달라진다)도 잡는다.
    window.addEventListener('resize', () => scheduleSidebarRailBuild(), { passive: true });

    // 목차 레일: 클릭 위임 + 리사이즈 시 재구축(PC/모바일 경계 통과로 노출 조건이 바뀐다).
    const rail = document.getElementById('tocScrollRail');
    if (rail) {
      rail.addEventListener('click', onRailClick);
      // 제목 펼침은 순수 CSS(`.toc-rail-labels:has(.toc-rail-dot:hover)`)로 처리한다 — 점은
      // 자리를 옮기지 않고 라벨도 히트 테스트에 참여하지 않으므로(pointer-events:none) 호버가
      // 끊겨 다시 붙는 진동이 없고, 호버 유지용 덮개나 JS 상태 토글이 필요 없다.
      window.addEventListener('resize', () => scheduleRailSync(160), { passive: true });
      // 이미지·폰트 로드로 본문 높이가 늘면 문서 내 비율이 달라지지만 mutation 은 발생하지
      // 않으므로(옵저버가 못 잡는다) 본문 크기 자체를 관찰해 좌표를 다시 계산한다.
      const contentEl = document.getElementById('articleContent');
      if (contentEl && typeof ResizeObserver === 'function') {
        new ResizeObserver(() => scheduleRailLayout()).observe(contentEl);
      } else {
        window.addEventListener('load', () => scheduleRailLayout(0));
      }
    }

    // 스크롤 FAB 그룹 표시/숨김 — 200px 이상 스크롤하면 노출(읽기/Raw 모드 중에는 유지).
    const fabGroup = document.getElementById('scrollFabGroup');
    if (fabGroup) {
      window.addEventListener('scroll', () => {
        if (window.scrollY > 200) {
          fabGroup.classList.add('visible');
        } else if (!document.body.classList.contains('reading-mode') && !document.body.classList.contains('raw-mode')) {
          fabGroup.classList.remove('visible');
        }
      }, { passive: true });
    }

    document.addEventListener('transitionend', (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (e.propertyName && e.propertyName !== 'grid-template-rows') return;
      if (t.classList && t.classList.contains('wiki-section-body')) refresh();
    });
    document.addEventListener('toggle', (e) => {
      const t = e.target as Element;
      if (t && t.tagName === 'DETAILS') refresh();
    }, true);

    const tocCollapse = document.getElementById('collapseTOC');
    if (tocCollapse) {
      ['show.bs.collapse', 'hide.bs.collapse', 'shown.bs.collapse', 'hidden.bs.collapse'].forEach((ev) =>
        tocCollapse.addEventListener(ev, refresh));
    }

    // 문서 페이지가 아니거나 목차가 없으면 TOC FAB 숨김.
    const observer = new MutationObserver((mutations) => {
      // 레일 재구축 트리거. 두 종류의 변경은 무시해야 한다:
      //  ① 레일 자체의 DOM 변경 — 재구축이 자기 자신을 다시 예약하는 순환이 된다.
      //  ② 스크롤스파이가 목차 nav 링크에 붙였다 떼는 .toc-active — 스크롤 중 활성 헤딩이
      //     바뀔 때마다 레일을 통째로 다시 만들게 된다(구조 변경이 아니므로 재구축 불필요).
      //  ③ 스크롤 FAB 그룹의 .visible 토글 — 위 스크롤 핸들러가 스크롤마다 classList.add 를
      //     호출하고, DOMTokenList 는 토큰이 그대로여도 attribute 갱신 record 를 남기므로
      //     제외하지 않으면 스크롤 내내 디바운스가 리셋된다.
      //  ④ {timer:} 의 초 단위 textContent 갱신 — 헤딩 구성과는 무관하다.
      const railEl = document.getElementById('tocScrollRail');
      //  ⑤ 우측 사이드바 진행 레일(#wikiTocSidebarRightRail)의 hidden/좌표 갱신 — 이 레일은
      //     스크롤바 레일과 무관하며, 걸러내지 않으면 리사이즈마다 재동기가 재예약된다.
      const sidebarRailEl = document.getElementById('wikiTocSidebarRightRail');
      const isRailNoise = (m: MutationRecord) => {
        const t = m.target;
        if (railEl && railEl.contains(t)) return true;
        if (sidebarRailEl && (sidebarRailEl === t || sidebarRailEl.contains(t))) return true;
        if (!(t instanceof Element)) return false;
        if (t.id === 'scrollFabGroup') return true;
        if (t.classList.contains('wiki-timer')) return true;
        return t.tagName === 'A'
          && !!t.closest('#tocNav, #tocFloatingNav, #wikiTocSidebarNav, #wikiTocSidebarRightNav, .wiki-toc-card-nav');
      };
      if (!mutations.every(isRailNoise)) scheduleRailSync();

      const tocBtn = document.getElementById('tocFabBtn');
      const tocSource = document.getElementById('tocNav');
      const articlePage = document.getElementById('articlePage');
      if (tocBtn) {
        // temporal 필터로 전 항목이 숨겨진 목차(li 전부 [hidden])는 FAB 도 숨긴다.
        const hasToc = tocSource && tocSource.querySelector('li:not([hidden])');
        const isArticle = articlePage && !articlePage.classList.contains('d-none');
        (tocBtn as HTMLElement).style.display = (hasToc && isArticle) ? '' : 'none';
      }
    });
    // attributeFilter 에 hidden 포함: temporal 경계 flip 이 li[hidden] 만 바꾸는 경우에도
    // FAB 표시 여부가 재평가되도록 한다.
    // attributeFilter 에 open 포함: <details>(:::fold) 개폐는 class 도 hidden 도 바꾸지 않아,
    // 그대로 두면 접힌 폴드 안 헤딩의 점이 레일에 남는다(반대로 열어도 나타나지 않는다).
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'open'] });

    updateActive();
    syncRail();
  }

  // ── 읽기 모드 ──
  function applyReadingUi(active: boolean) {
    const exitBtn = document.getElementById('readingModeExitFab');
    const fabGroup = document.getElementById('scrollFabGroup');
    if (!exitBtn || !fabGroup) return;
    if (active) {
      exitBtn.classList.remove('d-none');
      fabGroup.classList.add('visible');
    } else {
      exitBtn.classList.add('d-none');
      if (window.scrollY <= 200 && !document.body.classList.contains('raw-mode')) {
        fabGroup.classList.remove('visible');
      }
    }
  }

  function toggleReadingMode() {
    if (document.body.classList.contains('raw-mode')) {
      exitRawMode();
    }
    const active = document.body.classList.toggle('reading-mode');
    applyReadingUi(active);
    // FAB 이 3↔4개로 바뀌므로 확장 영역(패널·호버 덮개)을 다시 계산한다.
    scheduleRailLayout(0);
    try {
      if (active) localStorage.setItem('readingMode', '1');
      else localStorage.removeItem('readingMode');
    } catch (e) { /* noop */ }
    if (typeof opts.onReadingModeToggled === 'function') opts.onReadingModeToggled(active);
  }

  function restoreReadingMode() {
    try {
      if (localStorage.getItem('readingMode') === '1') {
        document.body.classList.add('reading-mode');
        applyReadingUi(true);
      }
    } catch (e) { /* noop */ }
  }

  // ── Raw 보기 모드 ──
  function applyRawUi(active: boolean) {
    const exitBtn = document.getElementById('rawModeExitFab');
    const fabGroup = document.getElementById('scrollFabGroup');
    if (!exitBtn || !fabGroup) return;
    if (active) {
      exitBtn.classList.remove('d-none');
      fabGroup.classList.add('visible');
    } else {
      exitBtn.classList.add('d-none');
      if (window.scrollY <= 200 && !document.body.classList.contains('reading-mode')) {
        fabGroup.classList.remove('visible');
      }
    }
  }

  function exitRawMode() {
    if (document.body.classList.contains('raw-mode')) {
      document.body.classList.remove('raw-mode');
    }
    applyRawUi(false);
    // Raw 모드에서는 레일을 띄우지 않으므로 진입/이탈 시 재구축한다.
    scheduleRailSync(0);
  }

  function toggleRawMode() {
    if (document.body.classList.contains('reading-mode')) {
      document.body.classList.remove('reading-mode');
      applyReadingUi(false);
      try { localStorage.removeItem('readingMode'); } catch (e) { /* noop */ }
    }
    const active = document.body.classList.toggle('raw-mode');
    applyRawUi(active);
    scheduleRailSync(0);
    if (active) window.scrollTo({ top: 0, behavior: 'auto' });
  }

  return {
    populateSidebar,
    toggleFloating,
    syncRail,
    attachSpy,
    refresh,
    toggleReadingMode,
    restoreReadingMode,
    toggleRawMode,
    exitRawMode,
  };
}
