/**
 * 사용자 검색어를 컬럼에 부분 매칭할 때 쓰는 SQL 조각 빌더.
 *
 * **`col LIKE '%q%'` 를 쓰지 말 것.** Cloudflare D1 은 SQLite 의
 * `SQLITE_LIMIT_LIKE_PATTERN_LENGTH` 를 **50바이트**로 낮게 잡아 두어, 검색어를 끼워 넣은
 * LIKE 패턴이 50바이트를 넘으면 쿼리가 통째로
 * `SQLITE_ERROR: LIKE or GLOB pattern too complex` 로 실패한다. UTF-8 한글은 글자당 3바이트라
 * `%…%` 를 감안하면 16자 남짓부터 한도를 넘긴다 — 즉 조금만 긴 한국어 검색어에서는 FTS 경로도
 * LIKE 폴백 경로도 같이 터져 검색 API 가 통째로 500 이 됐다.
 *
 * `instr()` 는 패턴 길이 제한이 없고 와일드카드 해석도 하지 않으므로 LIKE 메타문자(`%`, `_`,
 * `\`) 이스케이프 자체가 불필요하다 — 바인드에는 검색어 원문을 그대로 넘긴다.
 *
 * SQLite 의 `LIKE` 와 `lower()` 는 둘 다 ASCII 한정 case-insensitive 라
 * `instr(lower(col), lower(?))` 는 기존 LIKE 와 매칭 결과가 동일하다. `col` 이 NULL 이면
 * `instr()` 도 NULL 을 돌려줘 조건이 거짓이 되는 것까지 LIKE 와 같다(`title` 은 nullable).
 * 빈 검색어는 `instr(x, '') = 1` 이라 `LIKE '%'` 와 마찬가지로 모든 행에 매치된다.
 *
 * `%q%` LIKE 도 인덱스를 타지 못하는 전체 스캔이라 접근 경로는 동일하다. 다만 `lower(col)` 은
 * 행마다 컬럼 값의 소문자 사본을 만들므로, 본문 컬럼을 전수 스캔하는 경로(`runLikeSearch` 의
 * field=body/all, `mcpDispatch` search_fts 폴백)에서는 LIKE 의 스트리밍 case-folding 보다 CPU 를
 * 조금 더 쓴다. 부분 문자열 매칭에 길이 제한 없는 대안이 없으므로 감수한 트레이드오프다.
 */

/** `col LIKE '%q%'` 대체 — 부분 문자열 포함. 바인드 1개(검색어 원문)를 소비한다. */
export function sqlContains(col: string): string {
    return `instr(lower(${col}), lower(?)) > 0`;
}

/** `col LIKE 'q%'` 대체 — 접두사 매칭. 바인드 1개(검색어 원문)를 소비한다. */
export function sqlStartsWith(col: string): string {
    return `instr(lower(${col}), lower(?)) = 1`;
}
