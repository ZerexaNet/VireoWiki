/**
 * Slug를 정규화합니다.
 * 앞뒤 공백을 제거하고, 결과의 맨 앞/뒤에 붙은 '/' 슬래시를 모두 제거합니다.
 * (슬래시는 하위 문서 구분자로만 의미가 있으므로 시작/끝 위치에서는 무효 문자로 취급)
 * 원래 대소문자는 유지합니다.
 * 예: "Foo Bar" -> "Foo Bar"
 *     "/Foo/Bar/" -> "Foo/Bar"
 */
export function normalizeSlug(text: string): string {
    return text.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * ENABLED_EXTENSIONS에 등록된 네임스페이스인 경우에만 본문을 DB에 저장하지 않고 R2에만 저장할지 여부를 반환합니다.
 * @param slug 문서 슬러그
 * @param enabledExtensions 활성화된 익스텐션(네임스페이스) 목록
 */
export function isR2OnlyNamespace(slug: string, enabledExtensions: string[]): boolean {
    if (enabledExtensions.length === 0) return false;
    const colonIndex = slug.indexOf(':');
    if (colonIndex === -1) return false; // 일반 문서
    const namespace = slug.substring(0, colonIndex);
    return enabledExtensions.includes(namespace);
}

/**
 * `map:` 예약 네임스페이스 여부.
 * `map:` 슬러그는 실제 문서가 아니라 하위 문서 트리 + TOC 를 합성해 보여주는
 * 가상 뷰 전용이므로, 일반 문서 생성/수정/이동의 출발지·도착지로 사용할 수 없다.
 */
export function isMapNamespace(slug: string): boolean {
    return slug.startsWith('map:');
}

/**
 * 하위 문서(`base/...`) 스캔용 slug 범위 경계를 만든다. `null` 이면 baseSlug 가 비어
 * 있어(= 위키 전체가 대상) 범위 조건 자체를 붙이지 않아야 한다는 뜻이다.
 *
 * **`slug LIKE 'base/%'` 를 쓰지 말 것.** Cloudflare D1 은 SQLite 의
 * `SQLITE_LIMIT_LIKE_PATTERN_LENGTH` 를 **50바이트**로 낮게 잡아 두어, LIKE/GLOB 패턴이
 * 50바이트를 넘으면 쿼리가 통째로 `SQLITE_ERROR: LIKE or GLOB pattern too complex` 로
 * 실패한다. UTF-8 한글은 글자당 3바이트라 17자만 넘어도 한도를 초과하므로, 한국어 슬러그의
 * 하위 문서 조회에서는 사실상 상시 터진다.
 *
 * 대신 prefix 범위 비교(`slug > lower AND slug < upper`)를 쓴다. `/`(0x2F) 의 바로 다음
 * 코드포인트가 `0`(0x30) 이므로 `base/` 로 시작하는 모든 슬러그는 정확히
 * `('base/', 'base0')` 구간에 들어간다. UTF-8 은 코드포인트 순서와 바이트 사전순이 일치하고
 * `pages.slug` 는 UNIQUE(BINARY collation) 이라 비-ASCII 슬러그에서도 안전하며, LIKE 와
 * 달리 UNIQUE 인덱스를 그대로 탄다. lower 가 exclusive 인 것도 의도적이다 — `normalizeSlug`
 * 가 끝의 `/` 를 떼므로 `base/` 자체가 슬러그로 존재할 수 없다.
 *
 * LIKE 는 ASCII 한정 case-insensitive 지만 이 비교는 대소문자를 구분한다. slug 는 UNIQUE
 * BINARY 식별자라 대소문자가 다르면 서로 다른 문서이므로, 오히려 이쪽이 정확한 동작이다.
 */
export function subtreeSlugRange(baseSlug: string): { lower: string; upper: string } | null {
    if (!baseSlug) return null;
    return { lower: baseSlug + '/', upper: baseSlug + '0' };
}

/** MCP raw 읽기 허용 네임스페이스 목록 */
const MCP_READABLE_NAMESPACES = ['틀', '템플릿', '유저'];

/**
 * MCP 도구(get_toc/read_document/read_section)에서 해당 slug의 raw 데이터를
 * 읽을 수 있는지 여부를 반환합니다.
 * 콜론이 없는 일반 문서는 허용, 허용 네임스페이스(틀/템플릿/유저)도 허용,
 * 그 외 네임스페이스는 차단합니다.
 */
export function isMcpReadableSlug(slug: string): boolean {
    const colonIndex = slug.indexOf(':');
    if (colonIndex === -1) return true; // 일반 문서는 허용
    const namespace = slug.substring(0, colonIndex);
    return MCP_READABLE_NAMESPACES.includes(namespace);
}
