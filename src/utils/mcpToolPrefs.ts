// 사용자별 MCP 도구 On/Off 설정 공용 모듈.
//
// 저장 방식: users.mcp_disabled_tools TEXT (JSON 배열, Off 처리된 도구명 목록).
// 기본값 '[]' = 모두 On. Off된 도구는 MCP 핸드셰이크(tools/list·tools/call)에서
// 아예 없는 것처럼 취급된다 (mcp.ts visibleToolDefs 필터).
//
// 레거시 D1(mcp_disabled_tools 컬럼 부재) 대비 idempotent 런타임 마이그레이션을
// 컬럼 참조 전에 반드시 보장한다 (mcpInstantApplyMigration 과 동일 패턴).
// Workers isolate 가 살아있는 동안 결과를 캐시해 PRAGMA 조회를 한 번만 수행한다.

let migrationDone = false;
let migrationInflight: Promise<void> | null = null;

export function resetMcpDisabledToolsMigrationCacheForTests() {
    migrationDone = false;
    migrationInflight = null;
}

export async function ensureMcpDisabledToolsMigration(db: D1Database): Promise<void> {
    if (migrationDone) return;
    if (migrationInflight) return migrationInflight;
    migrationInflight = (async () => {
        try {
            const cols = await db.prepare('PRAGMA table_info(users)').all<{ name: string }>();
            const have = new Set(cols.results.map(c => c.name));
            if (!have.has('mcp_disabled_tools')) {
                await db.prepare("ALTER TABLE users ADD COLUMN mcp_disabled_tools TEXT NOT NULL DEFAULT '[]'").run();
            }
            migrationDone = true;
        } catch (e) {
            migrationInflight = null;
            console.error('ensureMcpDisabledToolsMigration failed:', e);
            return;
        } finally {
            migrationInflight = null;
        }
    })();
    return migrationInflight!;
}

// 저장 가능한 항목 수 상한 — 비정상적으로 큰 JSON 저장을 방지한다.
export const MCP_DISABLED_TOOLS_MAX = 200;
// 단일 도구명의 최대 길이 — 실제 도구명은 50자 이내이나 여유를 둔다.
export const MCP_TOOL_NAME_MAX_LENGTH = 100;

/**
 * DB/users 객체에 들어있는 mcp_disabled_tools 원시값을 string[] 로 정규화한다.
 * - null/undefined/'' → []
 * - JSON 문자열 → 파싱 (실패 시 [])
 * - 배열 → 그대로 사용
 * 이후 비문자열/빈문자열 제거, 길이 제한, dedupe, 상한 컷. 순서는 입력 순서를 유지한다.
 */
export function parseDisabledTools(raw: unknown): string[] {
    let arr: unknown;
    if (raw === null || raw === undefined) return [];
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) return [];
        try {
            arr = JSON.parse(trimmed);
        } catch {
            return [];
        }
    } else if (Array.isArray(raw)) {
        arr = raw;
    } else {
        return [];
    }
    if (!Array.isArray(arr)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of arr) {
        if (typeof item !== 'string') continue;
        const name = item.trim();
        if (!name) continue;
        if (name.length > MCP_TOOL_NAME_MAX_LENGTH) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        out.push(name);
        if (out.length >= MCP_DISABLED_TOOLS_MAX) break;
    }
    return out;
}

export function serializeDisabledTools(tools: string[]): string {
    return JSON.stringify(parseDisabledTools(tools));
}

/** User 객체(또는 동등한 모양)에서 Off 도구 Set 을 꺼낸다. 구 KV 캐시(필드 부재)도 [] 로 처리. */
export function getUserDisabledToolSet(user: { mcp_disabled_tools?: unknown } | null | undefined): Set<string> {
    if (!user) return new Set();
    return new Set(parseDisabledTools(user.mcp_disabled_tools));
}

/** visible 도구 목록에서 Off 처리된 도구를 제거한다. */
export function filterToolsByDisabled<T extends { name: string }>(tools: T[], disabled: Set<string>): T[] {
    if (disabled.size === 0) return tools;
    return tools.filter(t => !disabled.has(t.name));
}
