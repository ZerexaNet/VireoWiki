// 우측 목차 사이드바(#wikiTocSidebarRight — docs·right-toc 레이아웃)의 진행 레일.
// 목차 항목 왼쪽을 따라 흐르는 SVG path 하나를 그려 두고(track), 같은 path 를 복제한
// 두 번째 path(active)의 stroke-dasharray/­dashoffset 으로 "현재 섹션 구간만" 칠한다.
// 항목마다 별도 요소를 만드는 방식과 달리 들여쓰기(레벨)가 바뀌는 지점이 라운딩된 직각으로
// 이어져 목차 전체가 하나의 선으로 읽히고, 활성 구간 이동도 두 속성의 transition 만으로
// 끝난다(요소 생성/파괴 없음 → 스크롤 중 재레이아웃 0).
//
// 좌표계: path 는 nav 의 border box 기준 px 좌표로 그리고 <svg> 를 같은 크기로 맞춘다
// (viewBox 비율 왜곡이 없어 stroke 굵기가 어디서나 동일). 그래서 nav 크기가 바뀌면
// (문서 전환·폰트 로드·사이드바 폭 변화) 반드시 build() 를 다시 호출해야 한다 —
// 호출측(article/toc.ts)이 ResizeObserver·resize 로 배선한다.
//
// 스크롤바 목차 레일(`.toc-rail`, default·wide 레이아웃)과는 별개 장치다: 저쪽은 뷰포트
// 우측 끝의 미니맵이고, 이쪽은 목차 카드 안에서 목차 자체를 따라가는 선이다.

/** 항목 링크 왼쪽에서 레일까지 띄우는 거리(px). style.css 의 nav padding-left 와 짝. */
const RAIL_GUTTER = 10;
/** 레벨(x)이 바뀌는 꺾임 지점의 90도 라운딩 반경(px). */
const RAIL_CORNER_RADIUS = 4;
/** 이 개수를 넘는 목차는 레일을 그리지 않는다 — 구간마다 getTotalLength() 를 부르므로
 *  항목 수에 비례해 비용이 붙고, 그 밀도에서는 구간 하나가 1~2px 라 시각적 의미도 없다. */
const RAIL_MAX_ITEMS = 300;

interface RailSegment {
  /** path 시작점부터 이 항목 구간이 시작하는 지점까지의 길이. */
  start: number;
  /** 이 항목 구간(세로선)의 길이. */
  len: number;
}

export interface TocSidebarRail {
  /** 목차 DOM 이 바뀌었을 때(문서 전환·temporal 토글·리사이즈) 경로를 다시 그린다. */
  build(): void;
  /** 현재 활성 링크에 맞춰 칠해진 구간을 옮긴다. 활성 링크가 없으면 비운다. */
  sync(): void;
}

/**
 * @param navId   목차 링크가 담긴 nav 의 id
 * @param svgId   레일 <svg> 의 id (내부에 track/active path 를 가진다)
 */
export function createTocSidebarRail(navId: string, svgId: string): TocSidebarRail {
  let segments: RailSegment[] = [];
  let totalLength = 0;
  /** 구간 인덱스 조회용 — segments 와 같은 순서의 링크 목록. */
  let items: HTMLAnchorElement[] = [];
  let lastIndex = -1;
  /** 첫 칠은 애니메이션 없이 확정한다(문서 진입 시 선이 위에서부터 자라 내려오는 잔상 방지). */
  let ready = false;

  function els() {
    const nav = document.getElementById(navId);
    const svg = document.getElementById(svgId) as SVGSVGElement | null;
    const track = svg?.querySelector('.wiki-toc-rail-track') as SVGPathElement | null;
    const active = svg?.querySelector('.wiki-toc-rail-active') as SVGPathElement | null;
    return { nav, svg, track, active };
  }

  function clear(svg: SVGSVGElement | null, track: SVGPathElement | null, active: SVGPathElement | null) {
    segments = [];
    items = [];
    totalLength = 0;
    lastIndex = -1;
    ready = false;
    if (track) track.removeAttribute('d');
    if (active) {
      active.removeAttribute('d');
      active.removeAttribute('data-ready');
      active.style.strokeOpacity = '0';
    }
    // SVGElement 에는 HTMLElement 의 `hidden` IDL 속성이 없으므로 속성으로 직접 토글하고
    // (스타일도 UA 기본에 기대지 않고 style.css 가 `[hidden]{display:none}` 로 명시한다).
    // 이미 감춰져 있으면 건드리지 않는다 — 같은 값 재설정도 MutationObserver record 를
    // 남기고(toc.ts 의 레일 재동기 디바운스가 리사이즈마다 리셋된다) 얻을 게 없다.
    if (svg && !svg.hasAttribute('hidden')) svg.setAttribute('hidden', '');
  }

  /** temporal 숨김·비렌더 항목을 제외한, 실제로 보이는 목차 링크. */
  function visibleLinks(nav: HTMLElement): HTMLAnchorElement[] {
    return (Array.from(nav.querySelectorAll('a[href^="#"]')) as HTMLAnchorElement[])
      .filter((a) => {
        const li = a.closest('li');
        if (li && li.hidden) return false;
        return !!(a.offsetWidth || a.offsetHeight || a.getClientRects().length);
      });
  }

  function build() {
    const { nav, svg, track, active } = els();
    if (!nav || !svg || !track || !active) return;
    // 사이드바가 숨겨진 레이아웃/폭(모바일)에서는 좌표가 전부 0 이라 그릴 수 없다.
    if (!nav.offsetParent && nav.getClientRects().length === 0) { clear(svg, track, active); return; }

    const links = visibleLinks(nav);
    // 항목이 하나뿐이면 칠할 구간과 남는 구간의 구분이 없어 선이 장식으로만 남는다.
    if (links.length < 2 || links.length > RAIL_MAX_ITEMS) { clear(svg, track, active); return; }

    const navRect = nav.getBoundingClientRect();
    if (!navRect.height) { clear(svg, track, active); return; }

    // 측정 전에 노출한다 — getTotalLength() 는 렌더 트리에 없는(display:none) 요소에서
    // 0 을 돌려주는 구현이 있다.
    svg.removeAttribute('hidden');

    const segs: RailSegment[] = [];
    let d = '';
    let prevX = 0;
    let prevBottom = 0;
    // 길이는 누적으로 직접 계산한다. 항목마다 전체 경로를 다시 재면(setAttribute + 
    // getTotalLength 를 2n 회) d 문자열이 길어질수록 재파싱 비용이 제곱으로 붙는다.
    // 세로선은 좌표 차이가 곧 길이이고, 실제 측정이 필요한 것은 레벨이 바뀌는 곡선 연결부뿐이다.
    let acc = 0;

    links.forEach((a, i) => {
      const r = a.getBoundingClientRect();
      const x = Math.max(1, Math.round(r.left - navRect.left - RAIL_GUTTER));
      const top = r.top - navRect.top;
      const bottom = r.bottom - navRect.top;

      if (i === 0) {
        d = `M${x} ${top}`;
      } else if (x !== prevX) {
        // 레벨이 바뀌는 지점: 라운딩된 직각(두 개의 90도 라운드 코너 + 수평 연결선)으로 연결한다.
        const dx = x - prevX;
        const dirX = dx > 0 ? 1 : -1;
        const dy = Math.max(0, top - prevBottom);
        const midY = prevBottom + dy / 2;
        const r = Math.min(RAIL_CORNER_RADIUS, Math.abs(dx) / 2, dy / 2);
        const curve = r <= 0.5
          ? `L${prevX} ${midY} L${x} ${midY} L${x} ${top}`
          : `L${prevX} ${midY - r} Q${prevX} ${midY} ${prevX + dirX * r} ${midY} L${x - dirX * r} ${midY} Q${x} ${midY} ${x} ${midY + r} L${x} ${top}`;
        // 곡선 하나만 담은 임시 경로로 길이를 잰다(전체 경로 재파싱 회피).
        track.setAttribute('d', `M${prevX} ${prevBottom} ${curve}`);
        acc += track.getTotalLength();
        d += ` ${curve}`;
      } else {
        acc += Math.abs(top - prevBottom);
        d += ` L${x} ${top}`;
      }
      const len = Math.abs(bottom - top);
      segs.push({ start: acc, len });
      acc += len;
      d += ` L${x} ${bottom}`;

      prevX = x;
      prevBottom = bottom;
    });

    track.setAttribute('d', d);
    totalLength = acc;
    segments = segs;
    items = links;
    lastIndex = -1;
    ready = false;

    active.setAttribute('d', d);
    active.removeAttribute('data-ready');
    // dasharray 미설정 상태로 두면 전체가 칠해진 채 한 프레임 노출된다. 길이 0 dash 는
    // stroke-linecap:round 에서 점으로 렌더되므로 stroke-opacity 로 확실히 감춘다.
    active.style.strokeDasharray = `0 ${totalLength + 1}`;
    active.style.strokeDashoffset = '0';
    active.style.strokeOpacity = '0';

    // 좌표는 nav 기준으로 뽑았으므로 <svg> 도 nav 자리에 정확히 겹쳐 놓는다. 보통은 nav 가
    // 컨테이너를 꽉 채우지만, 향후 nav 에 마진/형제 요소가 붙어도 어긋나지 않게 실측한다.
    // absolute 좌표의 원점은 컨테이닝 블록의 padding box 이므로 border 두께를 빼야 한다.
    const host = svg.parentElement;
    if (host) {
      const hostRect = host.getBoundingClientRect();
      const cs = getComputedStyle(host);
      const originLeft = hostRect.left + parseFloat(cs.borderLeftWidth || '0');
      const originTop = hostRect.top + parseFloat(cs.borderTopWidth || '0');
      svg.style.left = `${navRect.left - originLeft}px`;
      svg.style.top = `${navRect.top - originTop}px`;
    }
    svg.setAttribute('width', String(Math.ceil(navRect.width)));
    svg.setAttribute('height', String(Math.ceil(navRect.height)));

    sync();
  }

  function sync() {
    const { nav, svg, active } = els();
    if (!nav || !svg || !active || svg.hasAttribute('hidden') || !segments.length) return;
    const current = nav.querySelector('a.toc-active') as HTMLAnchorElement | null;
    const index = current ? items.indexOf(current) : -1;
    if (index === lastIndex) return;
    lastIndex = index;

    if (index < 0) {
      // 활성 링크가 없거나(문서 진입 직후) 활성이 숨김 항목에 걸린 과도기 프레임.
      // 좌표는 그대로 두고 칠만 감춘다 — 0 으로 되돌리면 다음 활성에서 선이 맨 위에서
      // 자라 내려오고, 길이 0 dash 자체도 round cap 에서 점으로 남는다.
      active.style.strokeOpacity = '0';
      return;
    }
    active.style.strokeOpacity = '';
    const seg = segments[index];
    // 전체 path 중 [start, start+len] 구간만 보이게 하는 dash 트릭.
    // 두 번째 dash 값을 전체보다 길게 잡아 나머지 구간이 다시 나타나지 않게 한다.
    active.style.strokeDasharray = `${seg.len} ${totalLength + 1}`;
    active.style.strokeDashoffset = `${-seg.start}`;

    if (!ready) {
      ready = true;
      // 첫 좌표가 화면에 반영된 뒤에 transition 을 켠다(두 프레임: 스타일 적용 → 커밋).
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (ready) active.setAttribute('data-ready', 'true');
      }));
    }
  }

  return { build, sync };
}
