import { HTTPException } from 'hono/http-exception';
// 추가 MCP 도구 정의 + 디스패처 (일반 유저 편집 도구 + 관리자 전용 도구).
//
// 통합 MCP 엔드포인트 (/api/mcp) 가 호출 시점에 사용자 역할을 보고 이 모듈의 도구를
// 공용 읽기 도구 위에 추가로 노출한다. 별도 라우트(/api/admin-mcp) 를 직접 등록하지 않으며,
// 본 파일은 도구 정의와 디스패처만 export 한다.
//
// 노출 계층:
//   - guest (인증 없음 또는 권한 없는 토큰): MCP_TOOL_DEFS_ALL (mcpDispatch.ts) 만.
//   - 일반 유저 (`wiki:edit`): + USER_TOOL_DEFS
//        - 읽기: list_drafts, read_draft, read_revision
//        - 편집(draft 모델): create_or_update_page, patch_page, edit_section
//             → commit_edit / discard_edit 로 마무리. 도중 단계는 새 리비전을 만들지 않고
//             mcp_drafts 테이블에 사용자별로 누적된다 (같은 슬러그에 대해 1개).
//             commit_edit 가 base_revision_id 와 현재 last_revision_id 를 비교해 충돌 감지.
//             draft 는 마지막 활동 이후 12시간이 지나면 자정 크론이 일괄 삭제.
//        - 편집(즉시 적용): revert_page
//   - 관리자 (`admin:access`): + ADMIN_ONLY_TOOL_DEFS
//        - 읽기: list_deleted_pages
//        - 편집(즉시 적용): delete_page, restore_page, move_page
//
// 편집 도구는 wiki.ts 의 PUT /w/:slug, DELETE /w/:slug, POST /w/:slug/restore,
// POST /w/:slug/move 와 동일한 동작을 수행한다 — 동일한 헬퍼(buildLinkAndCategoryStatements,
// invalidatePageCache 등)를 재사용해 FTS 트리거, 역링크 인덱스, 캐시 무효화가 일관되게
// 적용되도록 한다.
import { ui } from '../i18n/server';
import { Context } from 'hono';
import type { Env, User } from '../types';
import { RBAC } from '../utils/role';
import { uploadRevisionToR2, getRevisionContent, insertVirtualRevision } from '../utils/r2';
import { mirrorPageBody, removePageMirror } from '../utils/rag';
import { replaceSection } from '../utils/aiParser';
import { isR2OnlyNamespace } from '../utils/slug';
import { normalizeSlug } from '../utils/slug';
import { getEnabledExtensions } from '../utils/extensions';
import {
    type McpToolDef,
    type ToolResult,
} from '../utils/mcpDispatch';
import { computeLineDiffStats } from '../utils/diff';
import { ensureMcpDraftsMigration } from '../utils/mcpDraftsMigration';
import { ensureRevisionsVirtualMigration } from '../utils/revisionsVirtualMigration';
import { ensureEditorNoteMigration } from '../utils/editorNoteMigration';
import { createNotification } from '../utils/notification';
import {
    findConflictingPage,
    buildLinkAndCategoryStatements,
    rewriteContentForRename,
} from './wiki';
import { computePageMetricsTracked } from '../utils/pageMetrics';
import { withFtsRecovery } from '../utils/ftsRecovery';
import { SLUG_FORBIDDEN_CHARS, TITLE_FORBIDDEN_CHARS, TITLE_MAX_LENGTH, normalizeTitleInput } from '../utils/validation';
import {
    invalidatePageCache,
    refreshRecentChangesCache,
    invalidateBacklinkCaches,
} from '../utils/cacheInvalidation';
import { extractFirstThumbnail, rebuildBlogImageLinks } from './blog';
import { removeAnnouncementByPostId } from '../utils/announcements';
import {
    parseEditAcl,
    serializeEditAcl,
    evaluateEditAcl,
    getEditAclMinAgeDays,
    findPrefixRuleEditAcl,
} from '../utils/editAcl';
import { isAdminOnlyCategory } from '../utils/categoryAcl';

/**
 * 관리자 전용 카테고리 게이트 — 웹 PUT /w/:slug (wiki.ts) 의 isAdminOnlyCategory 검사와 패리티.
 *
 * 비관리자가 admin_only 플래그를 가진 카테고리(category_acl)를 적용하려 하면 차단한다.
 * 관리자는 우회(웹과 동일: `if (body.category && !isAdmin)`). 통과면 null, 차단이면 에러 문자열.
 */
export async function enforceAdminOnlyCategories(
    db: D1Database,
    rbac: RBAC,
    user: User,
    category: string | null,
): Promise<string | null> {
    if (!category) return null;
    if (rbac.can(user.role, 'admin:access')) return null;
    const cats = category.split(',').map(s => s.trim()).filter(Boolean);
    for (const cat of cats) {
        if (await isAdminOnlyCategory(db, cat)) {
            return ui("m_31429406550ed617", [cat]);
        }
    }
    return null;
}

/**
 * MCP 편집 도구용 ACL 게이트.
 *
 * - admin_only 플래그가 없는 ACL 은 관리자가 우회.
 * - admin_only 플래그가 있으면 evaluate 단계에서 isAdmin 으로 판정 (관리자도 평가에 참여).
 * - 기존 페이지면 pages.edit_acl 평가, 신규 생성 케이스(pageId=null)면 prefix 룰 ACL 평가.
 * - 통과면 null, 차단이면 사용자 친화적 에러 문자열을 반환한다.
 */
async function enforceMcpEditAcl(
    db: D1Database,
    user: User,
    rbac: RBAC,
    existingPage: { id: number; edit_acl?: string | null } | null,
    slugForCreate: string | null,
): Promise<string | null> {
    const isAdmin = rbac.can(user.role, 'admin:access');
    const minAge = await getEditAclMinAgeDays(db);
    if (existingPage) {
        let rawAcl: string | null | undefined = existingPage.edit_acl;
        if (rawAcl === undefined) {
            const row = await db
                .prepare('SELECT edit_acl FROM pages WHERE id = ?')
                .bind(existingPage.id)
                .first<{ edit_acl: string | null }>();
            rawAcl = row?.edit_acl ?? null;
        }
        const acl = parseEditAcl(rawAcl);
        if (!acl || acl.flags.length === 0) return null;
        const hasAdminOnly = acl.flags.includes('admin_only');
        if (isAdmin && !hasAdminOnly) return null;
        const ev = await evaluateEditAcl(db, acl, user, existingPage.id, minAge, isAdmin);
        if (ev.allowed) return null;
        if (ev.decisive === 'admin_only') {
            return ui("m_718e2147e1a2bdab");
        }
        return ui("m_b38aea24dea3b95b", [acl.flags.join(',')]);
    }
    if (!slugForCreate) return null;
    const acl = await findPrefixRuleEditAcl(db, slugForCreate);
    if (!acl || acl.flags.length === 0) return null;
    const hasAdminOnly = acl.flags.includes('admin_only');
    if (isAdmin && !hasAdminOnly) return null;
    const ev = await evaluateEditAcl(db, acl, user, null, minAge, isAdmin);
    if (ev.allowed) return null;
    if (ev.decisive === 'admin_only') {
        return ui("m_40db2d51a7822a45");
    }
    return ui("m_d5aa081f3614ef8a", [acl.flags.join(',')]);
}

// ────────────────────────────────────────────────────────────────
// 일반 유저(`wiki:edit`) 도 호출 가능한 읽기 도구.
// (draft 흐름·과거 리비전 조회는 편집과 짝을 이루므로 wiki:edit 권한자에게 노출.)
// ────────────────────────────────────────────────────────────────

export const USER_READ_TOOL_DEFS: McpToolDef[] = [
    {
        name: 'read_revision',
        description: ui("m_35463423c1da3db2"),
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: ui("m_eab54d7e6d46ef2e") },
                revision_id: { type: 'number', description: ui("m_ab40a49df486a2a4") }
            },
            required: ['title', 'revision_id']
        }
    },
    {
        name: 'list_drafts',
        description: ui("m_e8f6e0fc69c68cce"),
        inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'read_draft',
        description: ui("m_066f30f8e937ee89"),
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: ui("m_5a07ed31a58feb5f") }
            },
            required: ['title']
        }
    }
];

// ────────────────────────────────────────────────────────────────
// 관리자(`admin:access`) 전용 읽기 도구.
// ────────────────────────────────────────────────────────────────

export const ADMIN_ONLY_READ_TOOL_DEFS: McpToolDef[] = [
    {
        name: 'list_deleted_pages',
        description: ui("m_be0bef7757373462"),
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: ui("m_d97ab144879ae08b") },
                since: { type: 'string', description: ui("m_6892a3de2fc8f445") }
            },
            required: []
        }
    }
];

// ────────────────────────────────────────────────────────────────
// 일반 유저(`wiki:edit`) 도 호출 가능한 편집 도구 정의.
// (revert_page 는 본질적으로 새 리비전을 만드는 편집이므로 user 계층에 둔다.)
// ────────────────────────────────────────────────────────────────

const HEADING_RULE_NOTE =
    ui("m_9affaa695800932b") +
    ui("m_924ee1d025cc7457") +
    ui("m_2912b9d4b8cdae72");

export const USER_EDIT_TOOL_DEFS: McpToolDef[] = [
    {
        name: 'create_or_update_page',
        description: ui("m_7db2629871eda279") + HEADING_RULE_NOTE,
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: ui("m_1912bfdf15320f6f") },
                content: { type: 'string', description: ui("m_3f40303960c3dd7a") },
                category: { type: 'string', description: ui("m_9184a0a02e3537fe") },
                redirect_to: { type: 'string', description: ui("m_a73ce1e5ea4e4eab") },
                create_only: { type: 'boolean', description: ui("m_f225f4981b80626a") },
                display_title: { type: ['string', 'null'], description: ui("m_73238162a48c3cf3") },
                editor_note: { type: 'string', description: ui("m_3d7c2b7994b3115d") }
            },
            required: ['title', 'content']
        }
    },
    {
        name: 'patch_page',
        description: ui("m_b311de5bec1786ff") + HEADING_RULE_NOTE,
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: ui("m_34cb2b870cc0091f") },
                old_string: { type: 'string', description: ui("m_9f0f47181df49afa") },
                new_string: { type: 'string', description: ui("m_680108655cd6e15c") }
            },
            required: ['title', 'old_string', 'new_string']
        }
    },
    {
        name: 'edit_section',
        description: ui("m_a4d5650e98914ad7") + HEADING_RULE_NOTE,
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: ui("m_34cb2b870cc0091f") },
                section_number: { type: 'string', description: ui("m_2e7d5e478b0f50f9") },
                new_content: { type: 'string', description: ui("m_08853e15284006c1") }
            },
            required: ['title', 'section_number', 'new_content']
        }
    },
    {
        name: 'commit_edit',
        description: ui("m_1733ff031c83966b"),
        inputSchema: {
            type: 'object',
            properties: {
                draft_id: { type: 'number', description: ui("m_99c040ac74eb7f5a") },
                summary: { type: 'string', description: ui("m_d94deba089b9cc19") },
            },
            required: ['draft_id']
        }
    },
    {
        name: 'discard_edit',
        description: ui("m_2511d64529f77c69"),
        inputSchema: {
            type: 'object',
            properties: {
                draft_id: { type: 'number', description: ui("m_df9da3b97a3d932c") }
            },
            required: ['draft_id']
        }
    },
    {
        name: 'revert_page',
        description: ui("m_8331d117bc307c22"),
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: ui("m_954004d370420e93") },
                revision_id: { type: 'number', description: ui("m_0f6bbfd4bfc70d40") },
                summary: { type: 'string', description: ui("m_1a534a0c2d48c342") }
            },
            required: ['title', 'revision_id']
        }
    }
];

// ────────────────────────────────────────────────────────────────
// 관리자(`admin:access`) 전용 편집 도구 정의 (즉시 적용 — draft 모델 미사용).
// ────────────────────────────────────────────────────────────────

export const ADMIN_ONLY_EDIT_TOOL_DEFS: McpToolDef[] = [
    {
        name: 'delete_page',
        description: ui("m_a8319bc306b93ca0"),
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: ui("m_cba875e322a3b362") },
                hard: { type: 'boolean', description: ui("m_77cd1dca513b92bf") }
            },
            required: ['title']
        }
    },
    {
        name: 'restore_page',
        description: ui("m_8aa291a2b51c5649"),
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: ui("m_9443783ff1f6e7f3") }
            },
            required: ['title']
        }
    },
    {
        name: 'move_page',
        description: ui("m_4782d7c3ddde2cb5"),
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: ui("m_b7efb4c7aa9167ef") },
                new_title: { type: 'string', description: ui("m_24cae5596547e34d") },
                update_backlinks: { type: 'boolean', description: ui("m_3d539028bf57ada4") }
            },
            required: ['title', 'new_title']
        }
    },
    {
        name: 'create_blog_post',
        description: ui("m_86493ccf3dd29124"),
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: ui("m_ea1ece85c0fd0b4b") },
                content: { type: 'string', description: ui("m_4f67d9921b617e0e") }
            },
            required: ['title', 'content']
        }
    },
    {
        name: 'update_blog_post',
        description: ui("m_6f4b4056a4874cdc"),
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number', description: ui("m_963c381e30c73ad2") },
                title: { type: 'string', description: ui("m_3a5e8e05f681f266") },
                content: { type: 'string', description: ui("m_ecad3ddd01b1cc4b") }
            },
            required: ['id']
        }
    },
    {
        name: 'delete_blog_post',
        description: ui("m_8ed5a0ca38c32806"),
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number', description: ui("m_59b8dd468f3c0bd5") }
            },
            required: ['id']
        }
    },
    {
        name: 'restore_blog_post',
        description: ui("m_4e5af2aae9a06ee2"),
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number', description: ui("m_cf198c4727854a63") }
            },
            required: ['id']
        }
    },
    {
        name: 'set_page_status',
        description: ui("m_636f29ef3dd55f9b"),
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: ui("m_11f69bd32d428f14") },
                category: { type: 'string', description: ui("m_d5112ef535b0ce5b") }
            },
            required: ['title', 'category']
        }
    }
];

// ────────────────────────────────────────────────────────────────
// 편집 도구 디스패처
// ────────────────────────────────────────────────────────────────

function asTextResult(text: string, isError = false): ToolResult {
    return { content: [{ type: 'text', text }], isError };
}

// MCP 경로에서 만들어지는 모든 리비전 summary 에 [MCP] 접두를 보장한다.
// 편집 자체는 OAuth 로 인증된 사용자(에이전트가 연결된 계정) 의 작업으로 기록되며,
// 이 접두만 추가해 사람이 직접 편집한 리비전과 구분할 수 있게 한다.
// 사용자가 직접 [MCP] 로 시작하는 summary 를 넘기면 중복 접두를 만들지 않는다.
export const MCP_SUMMARY_PREFIX = '[MCP]';
export const MCP_SUMMARY_MAX_LENGTH = 255;
export function withMcpPrefix(summary: string | null | undefined): string {
    const trimmed = (summary ?? '').trim();
    if (!trimmed) return MCP_SUMMARY_PREFIX;
    if (trimmed.startsWith(MCP_SUMMARY_PREFIX)) return trimmed;
    return `${MCP_SUMMARY_PREFIX} ${trimmed}`;
}
// 입력 summary 가 [MCP] 접두 부여 후에도 255자 한도(MCP_SUMMARY_MAX_LENGTH) 를 넘지 않는지 검증.
// 도구 스키마/문서가 명시한 contract 가 무너지지 않도록 raw 입력이 아니라 저장될 최종 문자열을 기준으로 한다.
export function validateMcpSummaryLength(summary: string | null | undefined): string | null {
    const finalLength = withMcpPrefix(summary).length;
    if (finalLength > MCP_SUMMARY_MAX_LENGTH) {
        return ui("m_9615f12f15f8e6f7", [MCP_SUMMARY_MAX_LENGTH, finalLength]);
    }
    return null;
}

// commit_edit 의 리비전 summary 앞에 자동 부여되는 diff 마커.
// "[+N줄 -M줄]" 형식이며 [MCP] 접두 뒤, 사용자 summary 앞에 위치한다.
// 예) `[MCP] [+5줄 -2줄] 오타 수정`
export function formatDiffMarker(stats: { added: number; removed: number }): string {
    return ui("m_4a3f2ae942af04cc", [stats.added, stats.removed]);
}

// 사용자 summary 와 diff 마커를 결합한 최종 summary 본문(=[MCP] 접두 부여 전) 을 만든다.
// 결합 후 [MCP] 접두까지 포함한 길이가 255자를 넘으면 사용자 summary 를 말줄임표(…)로 잘라
// 한도를 맞춘다 — 마커는 항상 보존된다.
export function buildCommitSummary(userSummary: string | null, stats: { added: number; removed: number }): string {
    const marker = formatDiffMarker(stats);
    const trimmedUser = (userSummary ?? '').trim();
    const combined = trimmedUser ? `${marker} ${trimmedUser}` : marker;
    if (withMcpPrefix(combined).length <= MCP_SUMMARY_MAX_LENGTH) return combined;

    // 한도 초과 — 사용자 summary 만 잘라낸다.
    // 최종 형태는 "[MCP] {marker} {truncatedUser}…" 이므로 다음 4가지 고정 비용을 모두 예산에 포함해야 한다.
    // (withMcpPrefix 가 .trim() 하므로 marker 뒤 공백 1 자가 누락되지 않도록 명시적으로 계산.)
    const fixedOverhead =
        MCP_SUMMARY_PREFIX.length /* "[MCP]" */
        + 1 /* "[MCP]" 와 marker 사이 공백 */
        + marker.length
        + 1 /* marker 와 user 사이 공백 */
        + 1 /* 말줄임표 '…' */;
    const room = MCP_SUMMARY_MAX_LENGTH - fixedOverhead;
    if (room <= 0) return marker;
    return `${marker} ${trimmedUser.slice(0, room)}…`;
}

function unixToIso(unix: number | null | undefined): string | null {
    if (unix === null || unix === undefined || !Number.isFinite(unix)) return null;
    return new Date(unix * 1000).toISOString();
}

// 추가 읽기 도구 디스패처 — guest 에게는 노출하지 않으며, 일반 유저(`wiki:edit`) /
// 관리자(`admin:access`) 에게 단계적으로 노출된다. 진입 시 visible-tools 검사로 차단되지만
// 디스패처 자체에서도 권한을 다시 확인해 방어선을 둔다.
export async function dispatchAdminReadTool(c: Context<Env>, user: User, toolName: string, args: any): Promise<ToolResult | null> {
    const db = c.env.DB;
    const rbac = c.get('rbac') as RBAC;
    // mcp_drafts 의 새 컬럼(submitted_at / submitted_summary) 을 사용하기 전에 기존 D1 에서
    // 컬럼이 빠져 있는 환경을 위해 idempotent 런타임 마이그레이션을 적용한다.
    await ensureMcpDraftsMigration(db);

    if (toolName === 'list_drafts') {
        if (!rbac.can(user.role, 'wiki:edit')) {
            return asTextResult(ui("m_eaf5dbfe425cfa3f"), true);
        }
        const { results } = await db.prepare(`
            SELECT id, slug, action, base_revision_id, base_version,
                   length(content) AS content_length, updated_at, submitted_at, submitted_summary
            FROM mcp_drafts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100
        `).bind(user.id).all<{
            id: number; slug: string; action: string; base_revision_id: number | null;
            base_version: number; content_length: number; updated_at: number;
            submitted_at: number | null; submitted_summary: string | null;
        }>();
        const formatted = results.map(r => ({
            draft_id: r.id,
            slug: r.slug,
            action: r.action,
            // 'pending_approval' = commit_edit 로 제출됨, 유저 검토 대기.
            // 'draft' = AI 가 계속 편집 가능한 작성 중 상태 (기본).
            status: r.submitted_at !== null ? 'pending_approval' : 'draft',
            base_revision_id: r.base_revision_id,
            base_version: r.base_version,
            content_length: r.content_length,
            updated_at: unixToIso(r.updated_at),
            submitted_at: unixToIso(r.submitted_at),
            submitted_summary: r.submitted_summary,
        }));
        return asTextResult(JSON.stringify(formatted, null, 2));
    }

    if (toolName === 'read_draft') {
        if (!rbac.can(user.role, 'wiki:edit')) {
            return asTextResult(ui("m_eaf5dbfe425cfa3f"), true);
        }
        const slug = String(args.title || '').trim();
        if (!slug) return asTextResult(ui("m_8ab6728713ad8858"), true);
        const draft = await db.prepare(`
            SELECT id, slug, action, base_revision_id, base_version, content,
                   category, redirect_to, editor_note, updated_at, submitted_at, submitted_summary
            FROM mcp_drafts WHERE user_id = ? AND slug = ?
        `).bind(user.id, slug).first<{
            id: number; slug: string; action: string; base_revision_id: number | null;
            base_version: number; content: string; category: string | null;
            redirect_to: string | null; editor_note: string | null; updated_at: number;
            submitted_at: number | null; submitted_summary: string | null;
        }>();
        if (!draft) return asTextResult(ui("m_aa2df5e3971b60e7"), true);
        return asTextResult(JSON.stringify({
            draft_id: draft.id,
            slug: draft.slug,
            action: draft.action,
            status: draft.submitted_at !== null ? 'pending_approval' : 'draft',
            base_revision_id: draft.base_revision_id,
            base_version: draft.base_version,
            category: draft.category,
            redirect_to: draft.redirect_to,
            editor_note: draft.editor_note,
            updated_at: unixToIso(draft.updated_at),
            submitted_at: unixToIso(draft.submitted_at),
            submitted_summary: draft.submitted_summary,
            content: draft.content,
        }, null, 2));
    }

    if (toolName === 'list_deleted_pages') {
        if (!rbac.can(user.role, 'admin:access')) {
            return asTextResult(ui("m_b525ffd5499fc86d"), true);
        }
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
        const wheres: string[] = ['p.deleted_at IS NOT NULL'];
        const binds: any[] = [];
        if (args.since && typeof args.since === 'string') {
            const parsed = Date.parse(args.since);
            if (Number.isNaN(parsed)) {
                return asTextResult(ui("m_35456c06c2ad2c05", [args.since]), true);
            }
            wheres.push('p.deleted_at >= ?');
            binds.push(Math.floor(parsed / 1000));
        }
        binds.push(limit);
        const sql = `
            SELECT p.slug, p.deleted_at, p.last_revision_id,
                   u.name AS last_editor, r.summary AS last_summary
            FROM pages p
            LEFT JOIN revisions r ON p.last_revision_id = r.id
            LEFT JOIN users u ON r.author_id = u.id
            WHERE ${wheres.join(' AND ')}
            ORDER BY p.deleted_at DESC LIMIT ?
        `;
        const { results } = await db.prepare(sql).bind(...binds).all<{
            slug: string; deleted_at: number | null; last_revision_id: number | null;
            last_editor: string | null; last_summary: string | null;
        }>();
        const formatted = results.map(r => ({
            slug: r.slug,
            deleted_at: unixToIso(r.deleted_at),
            last_editor: r.last_editor,
            last_summary: r.last_summary,
            last_revision_id: r.last_revision_id,
        }));
        return asTextResult(JSON.stringify(formatted, null, 2));
    }

    if (toolName === 'read_revision') {
        if (!rbac.can(user.role, 'wiki:edit')) {
            return asTextResult(ui("m_eaf5dbfe425cfa3f"), true);
        }
        const slug = normalizeSlug(args.title || '');
        const revisionId = Number(args.revision_id);
        if (!slug) return asTextResult(ui("m_8ab6728713ad8858"), true);
        if (!Number.isFinite(revisionId) || revisionId <= 0) {
            return asTextResult(ui("m_342d2c21b9f70059"), true);
        }
        const page = await db.prepare('SELECT id, slug, is_private, deleted_at FROM pages WHERE slug = ?').bind(slug).first<{ id: number; slug: string; is_private: number; deleted_at: number | null }>();
        if (!page) return asTextResult(ui("m_36f26fa461c07fd6"), true);
        // 페이지 단위 가시성 게이트: 비공개 문서는 wiki:private 권한, 삭제된 문서는
        // admin:access 권한이 없으면 존재하지 않는 것처럼 가린다. (read_revision 은
        // 기본 user 역할도 호출 가능하므로 페이지 가시성을 반드시 재검증한다.)
        const canSeeRevisionPrivate = rbac.can(user.role, 'wiki:private');
        const canSeeRevisionDeletedPage = rbac.can(user.role, 'admin:access');
        if ((page.is_private && !canSeeRevisionPrivate) || (page.deleted_at && !canSeeRevisionDeletedPage)) {
            return asTextResult(ui("m_36f26fa461c07fd6"), true);
        }

        // 레거시 DB(is_virtual 컬럼 부재) 대비 idempotent 마이그레이션 보장 후 쿼리.
        await ensureRevisionsVirtualMigration(db);
        const rev = await db.prepare(`
            SELECT r.id, r.page_id, r.page_version, r.content, r.r2_key, r.summary, r.created_at,
                   r.deleted_at, r.purged_at, r.is_virtual,
                   u.name AS author_name
            FROM revisions r
            LEFT JOIN users u ON r.author_id = u.id
            WHERE r.id = ?
        `).bind(revisionId).first<{
            id: number; page_id: number; page_version: number | null;
            content: string; r2_key: string | null; summary: string | null;
            created_at: number; deleted_at: number | null; purged_at: number | null;
            is_virtual: number; author_name: string | null;
        }>();
        if (!rev) return asTextResult(ui("m_1c0d1ec937005f23"), true);
        if (rev.page_id !== page.id) {
            return asTextResult(ui("m_79a074aac12f4b03"), true);
        }
        // 비관리자 호출자에게는 삭제된 리비전이 존재하지 않는 것처럼 가린다.
        const isAdmin = rbac.can(user.role, 'admin:access');
        if (rev.deleted_at && !isAdmin) {
            return asTextResult(ui("m_1c0d1ec937005f23"), true);
        }
        // 가상 리비전(비-본문 변경 기록)은 본문이 없으므로 빈 본문으로 반환한다.
        // 하드 삭제된 리비전도 R2 본문이 없으므로 빈 본문으로 반환 (관리자 전용 경로).
        const origin = new URL(c.req.url).origin;
        const content = (rev.is_virtual || rev.purged_at)
            ? ''
            : await getRevisionContent(c.env.MEDIA, { content: rev.content, r2_key: rev.r2_key }, origin);
        const payload: Record<string, unknown> = {
            revision_id: rev.id,
            slug: page.slug,
            page_version: rev.page_version,
            author_name: rev.author_name,
            summary: rev.summary,
            created_at: unixToIso(rev.created_at),
            content,
        };
        if (rev.is_virtual) {
            payload.virtual = true;
        }
        if (isAdmin && rev.deleted_at) {
            payload.deleted_at = unixToIso(rev.deleted_at);
            if (rev.purged_at) {
                payload.purged_at = unixToIso(rev.purged_at);
                payload.purged = true;
            }
        }
        return asTextResult(JSON.stringify(payload, null, 2));
    }

    return null;
}

// 기존 문서를 새 리비전으로 갱신하는 공용 헬퍼(저수준 write 단계).
// create_or_update_page 의 update 경로, patch_page, revert_page 가 공유한다.
// 호출자는 페이지 존재/슬러그 검증을 이미 마쳤다고 가정한다.
//
// 주의: 이 헬퍼는 주시자 알림을 내지 않는다. 새 저장 경로는 가능하면 통합 파이프라인
// `commitPageMutation`(src/utils/pagePipeline)을 경유해 주시자 알림 등 사이드이펙트 누락을
// 구조적으로 막아야 한다. 본 헬퍼 직접 호출은 아직 파이프라인 미이행 경로(commit_edit /
// revert / move — 3~4단계)에서만 유지한다.
export async function applyExistingPageUpdate(
    c: Context<Env>,
    user: User,
    page: { id: number; version: number; category: string | null; title?: string | null },
    content: string,
    opts: {
        summary: string | null;
        requiredPermission?: 'wiki:edit' | 'wiki:revert';
        category?: string | null;     // undefined → 기존 유지, null/string → 덮어쓰기
        redirectTo?: string | null;   // undefined → 기존 유지, null/string → 덮어쓰기
        title?: string | null;        // undefined → 기존 유지, null → 제거, string → 설정. 호출자가 사전 충돌 검증을 마쳤다고 가정.
        slug: string;
        editAcl?: string | null;      // undefined → 기존 유지(MCP 기본), null/string → 덮어쓰기 (사람 편집 보류 승인의 카테고리 ACL 머지 적용용).
        isPrivate?: number;           // undefined → 기존 유지(MCP/승인 경로 기본 — 본 저장은 비공개를 바꾸지 않음). 0/1 → 컬럼 덮어쓰기 (직접 PUT 의 wiki:private 토글용).
        summaryRaw?: boolean;         // true 면 withMcpPrefix() 를 건너뛰고 opts.summary 를 그대로 저장 (사람 편집 보류 승인 경로). 기본 false → [MCP] 접두.
        editorNote?: string | null;   // undefined → 기존 유지, null/string → editor_note 컬럼 덮어쓰기
        logType?: string;             // admin_log type (예: page_update / page_patch / page_revert) — 생략 시 로그 없음
        logMessage?: string;
        awaitLinkCategoryIndex?: boolean; // true 면 page_links/page_categories 재색인을 waitUntil 대신 await — 같은 페이지에 연속 리비전을 만드는 2-리비전 승인에서 rev1 의 재색인이 rev2 의 것과 경합/역전돼 중간 리비전 인덱스가 남는 것을 막는다(rev1 에만 사용).
    }
): Promise<{ revision_id: number; new_version: number; rows: number; characters: number }> {
    if (!c.get('rbac').can(user.role, opts.requiredPermission ?? 'wiki:edit')) throw new HTTPException(403, { message: ui('permissions.denied') });
    const db = c.env.DB;
    const enabledExt = getEnabledExtensions(c.env);
    const isR2Only = isR2OnlyNamespace(opts.slug, enabledExt);
    const metrics = computePageMetricsTracked(content, isR2Only);
    const newVersion = page.version + 1;
    const revisionSummary = opts.summaryRaw ? (opts.summary ?? null) : withMcpPrefix(opts.summary);

    const r2Key = await uploadRevisionToR2(c.env.MEDIA, page.id, newVersion, content);
    let revisionId: number;
    try {
        const revResult = await db
            .prepare('INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(page.id, newVersion, '', r2Key, revisionSummary, user.id)
            .run();
        revisionId = revResult.meta.last_row_id;
    } catch (e) {
        await c.env.MEDIA.delete(r2Key).catch(() => {});
        throw e;
    }

    const contentToStore = isR2Only ? '' : content;
    const categoryValue = opts.category === undefined ? page.category : opts.category;
    // title: opts.title 가 누락되면 기존 값을 그대로 유지해야 한다. page 인자에 title 이 포함되지 않은
    // 호출자(예: revert_page) 도 안전하도록 SET 절 자체를 조건부로 구성한다 — page.title 을
    // 비신뢰적으로 (undefined → null) 폴백하면 매 revert 마다 대체 제목이 조용히 지워진다.
    const setClauses: string[] = ['content = ?', 'category = ?'];
    const bindings: unknown[] = [contentToStore, categoryValue];
    if (opts.title !== undefined) {
        setClauses.push('title = ?');
        bindings.push(opts.title);
    }
    if (opts.redirectTo !== undefined) {
        setClauses.push('redirect_to = ?');
        bindings.push(opts.redirectTo);
    }
    // editAcl: undefined → 기존 유지(MCP 경로 기본). null/string → 덮어쓰기.
    // 사람 편집 보류 승인(update)에서 카테고리 ACL 머지 결과를 적용할 때 사용.
    if (opts.editAcl !== undefined) {
        setClauses.push('edit_acl = ?');
        bindings.push(opts.editAcl);
    }
    // isPrivate: undefined → 기존 유지(MCP/승인 경로 기본). 0/1 → 덮어쓰기 (직접 PUT 의 wiki:private 토글).
    if (opts.isPrivate !== undefined) {
        setClauses.push('is_private = ?');
        bindings.push(opts.isPrivate);
    }
    // editorNote: undefined → 기존 유지. null/string → 덮어쓰기.
    if (opts.editorNote !== undefined) {
        setClauses.push('editor_note = ?');
        bindings.push(opts.editorNote);
    }
    setClauses.push('last_revision_id = ?', 'version = ?', 'rows = ?', 'characters = ?', 'updated_at = unixepoch()');
    bindings.push(revisionId, newVersion, metrics.rows, metrics.characters);
    bindings.push(page.id, page.version);

    // 옵티미스틱 락(CAS): 호출자가 SELECT 한 시점의 version 과 일치할 때만 UPDATE.
    // 이 사이 다른 커밋이 들어와 version 이 올라갔으면 0행 변경되며, 우리는 막 만든
    // revision 과 R2 객체를 정리하고 CONCURRENT_MODIFICATION 으로 던진다 — 호출자가
    // 충돌 응답으로 변환한다. wiki.ts 의 PUT /w/:slug 도 동일하게 version-CAS 를 사용.
    // UPDATE 자체가 throw 하는 경우(예: title 의 idx_pages_title_unique race) 도 동일하게
    // 막 만든 리비전 / R2 객체를 청소한 뒤 에러를 재던져 호출자가 적절한 응답으로 매핑하게 한다.
    // FTS5 외부 콘텐츠 인덱스(pages_fts) 가 어긋나 있으면 이 UPDATE 의 pages_au 트리거가
    // 섀도 b-tree 를 읽다 malformed 로 실패한다 — 손상을 감지하면 인덱스를 재구축하고 1회 재시도.
    // (단일 UPDATE+트리거는 원자적이라 첫 시도 실패는 완전 롤백되므로 재시도가 안전하다.)
    let updResult: D1Result;
    try {
        updResult = await withFtsRecovery(db, () => db
            .prepare(`UPDATE pages SET ${setClauses.join(', ')} WHERE id = ? AND version = ?`)
            .bind(...bindings)
            .run());
    } catch (e) {
        await db.prepare('DELETE FROM revisions WHERE id = ?').bind(revisionId).run().catch(() => {});
        await c.env.MEDIA.delete(r2Key).catch(() => {});
        throw e;
    }
    if (!updResult.meta.changes) {
        // 동시 수정으로 CAS 실패 — 막 만든 리비전과 R2 객체를 청소.
        await db.prepare('DELETE FROM revisions WHERE id = ?').bind(revisionId).run().catch(() => {});
        await c.env.MEDIA.delete(r2Key).catch(() => {});
        const err: any = new Error(ui("m_0c08d9cc7b013e9a"));
        err.code = 'CONCURRENT_MODIFICATION';
        throw err;
    }

    const linkCatStmts = buildLinkAndCategoryStatements(c.env.DB, page.id, content, categoryValue ?? null);
    // 2-리비전 승인의 rev1 은 재색인을 await 해, 곧이어 만들 rev2(최종 본문)의 재색인보다 먼저
    // 끝나도록 강제한다 — waitUntil 두 개가 경합하면 rev1 의 page_links/page_categories 가 나중에
    // 끝나 중간(요청자) 리비전 기준 인덱스가 남을 수 있다.
    if (opts.awaitLinkCategoryIndex) {
        await c.env.DB.batch(linkCatStmts).catch(e => console.error('admin-mcp link/cat batch failed:', e));
    } else {
        c.executionCtx.waitUntil(c.env.DB.batch(linkCatStmts).catch(e => console.error('admin-mcp link/cat batch failed:', e)));
    }
    c.executionCtx.waitUntil(Promise.allSettled([
        invalidatePageCache(c, opts.slug),
        refreshRecentChangesCache(c),
        invalidateBacklinkCaches(c, opts.slug, c.env.DB),
    ]));
    // RAG 미러: 현행 본문을 인덱싱 전용 R2 버킷에 best-effort 반영(플러그인 OFF 시 no-op).
    mirrorPageBody(c.env, c.executionCtx, opts.slug, content);
    if (opts.logType && opts.logMessage) {
        c.executionCtx.waitUntil(
            c.env.DB.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind(opts.logType, opts.logMessage, user.id)
                .run().catch((e: any) => console.error('admin-mcp admin_log write failed:', e))
        );
    }

    return { revision_id: revisionId, new_version: newVersion, rows: metrics.rows ?? 0, characters: metrics.characters ?? 0 };
}

// 신규 페이지를 INSERT 하고 첫 리비전을 생성하는 공용 헬퍼(저수준 write 단계).
// commit_edit (action='create') 가 사용한다. 호출자는 슬러그 충돌(soft-deleted 포함) 검사를
// 이미 마쳤다고 가정한다.
//
// 주의: 새 저장 경로는 가능하면 통합 파이프라인 `commitPageMutation`(src/utils/pagePipeline)을
// 경유한다. 본 헬퍼 직접 호출은 아직 파이프라인 미이행 경로(commit_edit — 3단계)에서만 유지한다.
export async function applyNewPageInsert(
    c: Context<Env>,
    user: User,
    slug: string,
    content: string,
    opts: {
        summary: string | null;
        category: string | null;
        redirectTo: string | null;
        editAcl?: string | null;       // serialize 된 JSON. 호출자가 prefix 룰을 평가해 주입.
        isPrivate?: number;            // 호출자가 doc_setting_prefix_rules longest-match 로 산출. 누락 시 0.
        title?: string | null;        // 호출자가 사전 충돌 검증을 마쳤다고 가정. 누락 시 NULL.
        summaryRaw?: boolean;         // true 면 withMcpPrefix() 를 건너뛰고 opts.summary 를 그대로 저장 (사람 편집 보류 승인 경로). 기본 false → [MCP] 접두.
        editorNote?: string | null;   // 편집 메모. 누락 시 NULL.
        logType?: string;
        logMessage?: string;
        awaitLinkCategoryIndex?: boolean; // true 면 page_links/page_categories 재색인을 await — 2-리비전 승인의 rev1(신규 생성)에서 rev2 재색인과의 경합/역전을 막는다.
    }
): Promise<{ page_id: number; revision_id: number; rows: number; characters: number }> {
    if (!c.get('rbac').can(user.role, 'wiki:create')) throw new HTTPException(403, { message: ui('permissions.denied') });
    const db = c.env.DB;
    const enabledExt = getEnabledExtensions(c.env);
    const isR2Only = isR2OnlyNamespace(slug, enabledExt);
    const metrics = computePageMetricsTracked(content, isR2Only);
    const contentToStore = isR2Only ? '' : content;

    // 신규 INSERT 도 pages_ai 트리거로 pages_fts 에 색인하므로, 인덱스가 손상돼 있으면
    // malformed 로 실패할 수 있다 — 감지 시 재구축 후 1회 재시도(단일 INSERT 는 원자적).
    let pageResult;
    try {
        pageResult = await withFtsRecovery(db, () => db
            .prepare('INSERT INTO pages (slug, title, content, category, is_private, edit_acl, redirect_to, editor_note, rows, characters) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(slug, opts.title ?? null, contentToStore, opts.category, opts.isPrivate ?? 0, opts.editAcl ?? null, opts.redirectTo, opts.editorNote ?? null, metrics.rows, metrics.characters)
            .run());
    } catch (e: any) {
        // UNIQUE race: precheck ~ INSERT 사이에 다른 요청이 같은 slug/title 을 점유.
        // 호출자(commit_edit / submission approve) 가 409 형태로 매핑하도록 code 태깅.
        const msg = String(e?.message || e);
        if (/UNIQUE|constraint/i.test(msg)) {
            const err: any = new Error(/title/i.test(msg) ? 'TITLE_TAKEN' : 'SLUG_TAKEN');
            err.code = /title/i.test(msg) ? 'TITLE_TAKEN' : 'SLUG_TAKEN';
            err.dbMessage = msg;
            throw err;
        }
        throw e;
    }
    const pageId = pageResult.meta.last_row_id;

    let firstR2Key: string;
    try {
        firstR2Key = await uploadRevisionToR2(c.env.MEDIA, pageId, 1, content);
    } catch (e) {
        await db.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run().catch(() => {});
        throw e;
    }
    let revisionId: number;
    try {
        const revResult = await db
            .prepare('INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(pageId, 1, '', firstR2Key, opts.summaryRaw ? (opts.summary ?? null) : withMcpPrefix(opts.summary), user.id)
            .run();
        revisionId = revResult.meta.last_row_id;
    } catch (e) {
        await c.env.MEDIA.delete(firstR2Key).catch(() => {});
        await db.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run().catch(() => {});
        throw e;
    }
    await db.prepare('UPDATE pages SET last_revision_id = ? WHERE id = ?').bind(revisionId, pageId).run();

    const linkCatStmts = buildLinkAndCategoryStatements(db, pageId, content, opts.category);
    // 2-리비전 승인의 rev1(신규 생성)은 재색인을 await 해 rev2(최종 본문) 재색인보다 먼저 끝나도록 한다.
    if (opts.awaitLinkCategoryIndex) {
        await db.batch(linkCatStmts).catch(e => console.error('admin-mcp link/cat batch failed:', e));
    } else {
        c.executionCtx.waitUntil(db.batch(linkCatStmts).catch(e => console.error('admin-mcp link/cat batch failed:', e)));
    }
    c.executionCtx.waitUntil(Promise.allSettled([
        invalidatePageCache(c, slug),
        refreshRecentChangesCache(c),
        invalidateBacklinkCaches(c, slug, db),
    ]));
    // RAG 미러: 신규 문서 본문을 인덱싱 전용 R2 버킷에 best-effort 반영(플러그인 OFF 시 no-op).
    mirrorPageBody(c.env, c.executionCtx, slug, content);
    if (opts.logType && opts.logMessage) {
        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind(opts.logType, opts.logMessage, user.id)
                .run().catch((e: any) => console.error('admin-mcp admin_log write failed:', e))
        );
    }

    return { page_id: pageId, revision_id: revisionId, rows: metrics.rows ?? 0, characters: metrics.characters ?? 0 };
}

// 새로 발급된 draft 응답에 포함하는 라이프사이클 가이드.
// 같은 draft 가 이어서 갱신될 때는 더 짧은 안내(DRAFT_UPDATE_NOTE)만 보낸다.
const DRAFT_FIRST_ISSUE_NOTE =
    ui("m_bb6e8cdce042d5d9") +
    ui("m_f1b2a0a0ce744f91") +
    ui("m_5fdebda560bdaf13") +
    ui("m_96af99f246616c9a") +
    ui("m_14633f93c811369e") +
    ui("m_c6df720ffe5dbfaf") +
    ui("m_c5653e410b295271") +
    ui("m_2dc8566bc0bc2a8b");

const DRAFT_UPDATE_NOTE =
    ui("m_89fa221ff4b12753");

// (user_id, slug) 의 draft 를 조회하고, 없으면 페이지에서 현재 본문을 스냅샷해 새 draft 를 생성한다.
// 호출자는 slug 가 admin-mcp 로 편집 가능한지(이미지: 네임스페이스 거부 등)를 이미 확인했다고 가정한다.
async function loadDraftOrSeedFromPage(
    c: Context<Env>,
    user: User,
    slug: string
): Promise<{
    type: 'draft' | 'seeded' | 'not_found' | 'submitted';
    draftId?: number;
    content: string;
    page?: { id: number; version: number; last_revision_id: number | null; category: string | null; redirect_to: string | null; edit_acl: string | null; editor_note: string | null };
}> {
    const db = c.env.DB;
    // action 무관하게 본인의 (slug) draft 가 있으면 그 위에서 편집을 누적한다.
    // create 액션 draft (= 아직 commit 되지 않은 신규 페이지) 도 patch_page / edit_section
    // 으로 점진적으로 다듬을 수 있어야 한다.
    // submitted_at IS NOT NULL → 승인 대기 상태이므로 AI 가 더 이상 수정할 수 없다.
    // 호출자가 별도로 거부 처리해야 한다 (호출 측에서 type='submitted' 처리).
    const draft = await db.prepare(
        'SELECT id, content, submitted_at FROM mcp_drafts WHERE user_id = ? AND slug = ?'
    ).bind(user.id, slug).first<{ id: number; content: string; submitted_at: number | null }>();
    if (draft) {
        if (draft.submitted_at !== null) {
            return { type: 'submitted', draftId: draft.id, content: draft.content };
        }
        return { type: 'draft', draftId: draft.id, content: draft.content };
    }

    const page = await db.prepare(
        'SELECT id, version, content, last_revision_id, category, redirect_to, edit_acl, editor_note FROM pages WHERE slug = ? AND deleted_at IS NULL'
    ).bind(slug).first<{
        id: number; version: number; content: string;
        last_revision_id: number | null; category: string | null; redirect_to: string | null;
        edit_acl: string | null; editor_note: string | null;
    }>();
    if (!page) return { type: 'not_found', content: '' };

    const enabledExt = getEnabledExtensions(c.env);
    const isR2Only = isR2OnlyNamespace(slug, enabledExt);
    let body = page.content;
    if (isR2Only && (!body || body === '') && page.last_revision_id) {
        const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(page.last_revision_id).first<{ content: string; r2_key: string | null }>();
        if (lastRev) body = await getRevisionContent(c.env.MEDIA, lastRev, new URL(c.req.url).origin);
    }
    return {
        type: 'seeded',
        content: body.replace(/\r\n?/g, '\n'),
        page: { id: page.id, version: page.version, last_revision_id: page.last_revision_id, category: page.category, redirect_to: page.redirect_to, edit_acl: page.edit_acl, editor_note: page.editor_note },
    };
}

// commit_edit(submit_for_approval=true) 가 호출된 draft 를 "승인 대기" 로 마크하고
// OAuth 토큰 소유자(=draft.user_id) 에게 알림을 발송한다.
// 알림 link 는 /mypage#mcp-submissions 로, ref_id 는 draft.id 로 둔다 — 승인/거부 시 같은
// ref_id 로 알림을 정리할 수 있도록 정렬한다. submitted_summary 에는 AI 가 제안한 요약을 저장하고,
// 승인 시점에 유저가 그대로 채택하거나 본인이 다시 작성할 수 있다.
//
// 동시성: UPDATE 를 `WHERE submitted_at IS NULL` 조건으로 묶어 두 개의 commit_edit 호출이
// 같은 draft 에 대해 호출 직전 체크를 동시에 통과하더라도 둘 중 하나만 실제 전환되도록 한다.
// UPDATE 가 changes=0 이면 다른 요청이 먼저 전환을 끝낸 것이므로 알림 INSERT 도 하지 않는다.
// 그 경우 호출자는 'already submitted' 응답을 반환하도록 null 을 받게 된다.
async function markDraftSubmittedAndNotify(
    c: Context<Env>,
    draftId: number,
    slug: string,
    aiSummary: string | null,
): Promise<{ iso: string } | null> {
    const db = c.env.DB;
    const submittedAtSec = Math.floor(Date.now() / 1000);
    const updateRes = await db
        .prepare(
            'UPDATE mcp_drafts SET submitted_at = ?, submitted_summary = ?, updated_at = ? WHERE id = ? AND submitted_at IS NULL'
        )
        .bind(submittedAtSec, aiSummary, submittedAtSec, draftId)
        .run();
    if (!updateRes.meta.changes) {
        // 동시 호출이 이미 전환을 끝냄 — 알림 중복 INSERT 방지.
        return null;
    }
    // draft 소유자(=OAuth 토큰 유저) 에게 in-app 알림 + 푸시.
    const ownerRow = await db
        .prepare('SELECT user_id FROM mcp_drafts WHERE id = ?')
        .bind(draftId)
        .first<{ user_id: number | null }>();
    if (ownerRow?.user_id) {
        const notifContent = ui("m_b984971f61ea5da3", [slug]);
        await createNotification(c.env, c.executionCtx, {
            userId: ownerRow.user_id,
            type: 'mcp_submission',
            content: notifContent,
            link: '/mypage#mcp-submissions',
            refId: draftId,
            push: {
                title: ui("m_e085d4d2b72069cf"),
                body: notifContent,
                url: '/mypage#mcp-submissions',
                tag: `mcp_submission:${draftId}`,
            },
        });
    }
    return { iso: new Date(submittedAtSec * 1000).toISOString() };
}

export async function dispatchAdminEditTool(c: Context<Env>, user: User, toolName: string, args: any): Promise<ToolResult | null> {
    const db = c.env.DB;
    const rbac = c.get('rbac') as RBAC;
    // 같은 이유 — 모든 편집 도구가 mcp_drafts 의 새 컬럼을 직간접적으로 사용하므로 진입 시 보장.
    await ensureMcpDraftsMigration(db);
    await ensureEditorNoteMigration(db);

    if (toolName === 'create_or_update_page') {
        // 위임 admin 역할이 wiki:edit 없이 admin:access 만 가진 케이스에서도
        // wiki PUT /w/:slug 와 동일하게 wiki:edit 권한을 요구한다 (기본 역할에서는 admin
        // 이 user 를 상속하므로 자동으로 통과되지만, ROLE_PERMISSIONS_JSON 으로 권한이
        // 분리된 환경에서 우회를 막는다). 비록 draft 단계라도 같은 정책 유지.
        if (!rbac.can(user.role, 'wiki:edit')) {
            return asTextResult(ui("m_eaf5dbfe425cfa3f"), true);
        }
        const slug = String(args.title || '').trim();
        if (!slug) return asTextResult(ui("m_8ab6728713ad8858"), true);
        if (SLUG_FORBIDDEN_CHARS.test(slug)) return asTextResult(ui("m_d562855ceec48d54"), true);
        if (slug.startsWith('이미지:')) return asTextResult(ui("m_e02821f6bffe9ca0"), true);
        if (slug.startsWith('map:')) return asTextResult(ui("m_51f6566a2dc68dac"), true);        if (typeof args.content !== 'string') return asTextResult(ui("m_b3104adc425b92b3"), true);
        if (args.category && typeof args.category === 'string') {
            if (!/^[\p{Script=Han}가-힣a-zA-Z0-9\s,]+$/u.test(args.category)) {
                return asTextResult(ui("m_ecc6b4ed43d3fa11"), true);
            }
        }

        const content = args.content.replace(/\r\n?/g, '\n');
        const category = (args.category && typeof args.category === 'string') ? args.category : null;
        const redirectTo = (args.redirect_to && typeof args.redirect_to === 'string') ? args.redirect_to : null;
        const createOnly = args.create_only === true;

        // 관리자 전용 카테고리 검증 — 웹 PUT /w/:slug 와 동일하게 비관리자의 admin_only 카테고리 적용 차단.
        {
            const catErr = await enforceAdminOnlyCategories(db, rbac, user, category);
            if (catErr) return asTextResult('Error: ' + catErr, true);
        }

        // 대체 표시 제목(display_title): args 에 키가 명시되어 있을 때만 변경 의도로 해석. (undefined = 기존 유지)
        // MCP 컨벤션 상 args.title 은 슬러그를 가리키므로, 표시용 대체 제목은 별도의 display_title 키로 받는다.
        // 잘못된 타입은 string|null 외 모두 거부 — 조용한 데이터 손실(null 로 정규화 후 삭제) 방지.
        const hasTitleChange = Object.prototype.hasOwnProperty.call(args, 'display_title');
        if (hasTitleChange && args.display_title !== null && typeof args.display_title !== 'string') {
            return asTextResult(ui("m_66f6e8ed248c75ed"), true);
        }
        const requestedTitle = hasTitleChange ? normalizeTitleInput(args.display_title) : null;
        if (hasTitleChange && requestedTitle !== null) {
            if (TITLE_FORBIDDEN_CHARS.test(requestedTitle)) {
                return asTextResult(ui("m_c79c864cbdc920ad"), true);
            }
            if (requestedTitle.length > TITLE_MAX_LENGTH) {
                return asTextResult(ui("m_1ef45f2dd443d3e9", [TITLE_MAX_LENGTH]), true);
            }
        }

        const existing = await db
            .prepare('SELECT id, version, last_revision_id, category, title, editor_note FROM pages WHERE slug = ? AND deleted_at IS NULL')
            .bind(slug)
            .first<{ id: number; version: number; last_revision_id: number | null; category: string | null; title: string | null; editor_note: string | null }>();

        // 신규 title 이 다른 페이지의 slug 또는 title 과 충돌하면 거부. 소프트 삭제 행도 포함.
        if (hasTitleChange && requestedTitle) {
            const selfId = existing?.id ?? null;
            const conflict = await findConflictingPage(db, requestedTitle, selfId);
            if (conflict) {
                const deletedSuffix = conflict.isDeleted ? ui("m_ecd14a0b47bd02cf") : '';
                const msg = conflict.matchedColumn === 'slug'
                    ? ui("m_06ab29e11e5de033", [requestedTitle, deletedSuffix])
                    : ui("m_d37ce58985a8c6fb", [requestedTitle, deletedSuffix]);
                return asTextResult(msg, true);
            }
        }

        // 신규 슬러그가 다른 문서의 title 과 충돌하는지 검사 (생성 흐름 한정).
        if (!existing) {
            const slugTitleConflict = await findConflictingPage(db, slug, null);
            if (slugTitleConflict && slugTitleConflict.matchedColumn === 'title') {
                const deletedSuffix = slugTitleConflict.isDeleted ? ui("m_498cdf7a4578a46f") : '';
                return asTextResult(ui("m_8d49255bd1e6c534", [slug, deletedSuffix]), true);
            }
        }

        if (existing && createOnly) {
            return asTextResult(ui("m_0be79ab877efcff9"), true);
        }
        // create 경로 (페이지 미존재) 에서 소프트 삭제된 동일 슬러그가 있으면 commit 시점에
        // INSERT 가 SQLite UNIQUE 제약으로 실패한다. draft 시작 단계에서 미리 감지해
        // restore/hard 삭제 안내.
        if (!existing) {
            const deletedConflict = await db
                .prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NOT NULL')
                .bind(slug)
                .first<{ id: number }>();
            if (deletedConflict) {
                return asTextResult(
                    ui("m_1305aec62a88f8a3") +
                    ui("m_d71e674e7fab6572"),
                    true
                );
            }
        }
        // edit_acl 검사 — admin_only 가 없으면 관리자 우회. admin_only 가 있으면 evaluate 단계에서 관리자도 통과/거부 판정.
        // 기존 페이지는 page.edit_acl, 신규는 prefix 룰 ACL.
        {
            const aclErr = await enforceMcpEditAcl(db, user, rbac, existing ? { id: existing.id } : null, existing ? null : slug);
            if (aclErr) return asTextResult('Error: ' + aclErr, true);
        }

        const action = existing ? 'update' : 'create';
        const baseRevisionId = existing ? existing.last_revision_id : null;
        const baseVersion = existing ? existing.version : 0;

        // 본인의 같은 슬러그 draft 가 이미 있으면 본문/메타데이터를 통째로 교체한다.
        // base_revision_id / base_version 은 보존 — 처음 begin 한 시점의 페이지 상태로 충돌
        // 검증을 해야 의미 있다. 이 호출이 page 가 그 사이 바뀌었는지를 다시 캡처하면
        // 충돌 감지가 무력화된다.
        // 단 submitted_at IS NOT NULL → 이미 승인 대기로 제출된 상태이므로 본문 교체 불가.
        const existingDraft = await db.prepare(
            'SELECT id, action, base_revision_id, base_version, submitted_at FROM mcp_drafts WHERE user_id = ? AND slug = ?'
        ).bind(user.id, slug).first<{ id: number; action: string; base_revision_id: number | null; base_version: number; submitted_at: number | null }>();
        if (existingDraft && existingDraft.submitted_at !== null) {
            return asTextResult(ui("m_da391d05579986b7"), true);
        }

        // draft 단계의 title 저장: hasTitleChange 가 true 일 때만 적용. (false 면 commit 시점에 페이지 기존 title 유지)
        // 기존 draft 갱신 시 display_title 키가 누락된 호출은 이전에 스테이지된 title 변경을 그대로
        // 보존해야 한다 — 후속 patch/edit 호출에서 title 의도가 조용히 지워지는 문제를 막는다.
        const draftHasTitleChange = hasTitleChange ? 1 : 0;
        const draftTitleValue = hasTitleChange ? requestedTitle : null;

        // editor_note: args 에 키가 명시되어 있을 때만 변경 의도로 해석. (undefined = 기존 유지)
        const hasEditorNoteChange = Object.prototype.hasOwnProperty.call(args, 'editor_note');
        const requestedEditorNote = hasEditorNoteChange
            ? (typeof args.editor_note === 'string' ? args.editor_note : null)
            : null;

        // editor_note seed 값: 명시 변경이 있으면 그 값, 없으면 기존 draft 것, draft 도 없으면 페이지 것(또는 null).
        let draftEditorNoteValue: string | null;
        if (hasEditorNoteChange) {
            draftEditorNoteValue = requestedEditorNote;
        } else if (existingDraft) {
            const prevDraftNote = await db.prepare('SELECT editor_note FROM mcp_drafts WHERE id = ?')
                .bind(existingDraft.id).first<{ editor_note: string | null }>();
            draftEditorNoteValue = prevDraftNote?.editor_note ?? null;
        } else {
            draftEditorNoteValue = existing?.editor_note ?? null;
        }

        let draftId: number;
        if (existingDraft) {
            if (hasTitleChange) {
                await db.prepare(
                    `UPDATE mcp_drafts
                     SET content = ?, category = ?, redirect_to = ?,
                         title = ?, has_title_change = ?, editor_note = ?, updated_at = unixepoch()
                     WHERE id = ?`
                ).bind(content, category, redirectTo, draftTitleValue, draftHasTitleChange, draftEditorNoteValue, existingDraft.id).run();
            } else {
                // display_title 미지정: 기존 draft 의 title / has_title_change 그대로 유지.
                await db.prepare(
                    `UPDATE mcp_drafts
                     SET content = ?, category = ?, redirect_to = ?, editor_note = ?, updated_at = unixepoch()
                     WHERE id = ?`
                ).bind(content, category, redirectTo, draftEditorNoteValue, existingDraft.id).run();
            }
            draftId = existingDraft.id;
        } else {
            const ins = await db.prepare(
                `INSERT INTO mcp_drafts (user_id, slug, action, base_revision_id, base_version, content, category, redirect_to, title, has_title_change, editor_note)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(user.id, slug, action, baseRevisionId, baseVersion, content, category, redirectTo, draftTitleValue, draftHasTitleChange, draftEditorNoteValue).run();
            draftId = ins.meta.last_row_id;
        }

        return asTextResult(JSON.stringify({
            draft_id: draftId,
            slug,
            action: existingDraft ? existingDraft.action : action,
            base_revision_id: existingDraft ? existingDraft.base_revision_id : baseRevisionId,
            base_version: existingDraft ? existingDraft.base_version : baseVersion,
            content_length: content.length,
            replaced_existing_draft: !!existingDraft,
            note: existingDraft ? DRAFT_UPDATE_NOTE : DRAFT_FIRST_ISSUE_NOTE,
        }, null, 2));
    }

    if (toolName === 'patch_page') {
        if (!rbac.can(user.role, 'wiki:edit')) {
            return asTextResult(ui("m_eaf5dbfe425cfa3f"), true);
        }
        const slug = String(args.title || '').trim();
        if (!slug) return asTextResult(ui("m_8ab6728713ad8858"), true);
        if (slug.startsWith('이미지:')) return asTextResult(ui("m_b553e7b7164d38ae"), true);
        if (slug.startsWith('map:')) return asTextResult(ui("m_51f6566a2dc68dac"), true);        if (typeof args.old_string !== 'string' || args.old_string.length === 0) {
            return asTextResult(ui("m_1892d082de75f76e"), true);
        }
        if (typeof args.new_string !== 'string') {
            return asTextResult(ui("m_59ce8f7fb9a9d57d"), true);
        }

        const oldStr = (args.old_string as string).replace(/\r\n?/g, '\n');
        const newStr = (args.new_string as string).replace(/\r\n?/g, '\n');

        // draft 가 있으면 draft.content 위에서, 없으면 페이지 현재 본문을 LF 정규화한 뒤
        // 자동으로 새 draft 를 시작한다.
        const loaded = await loadDraftOrSeedFromPage(c, user, slug);
        if (loaded.type === 'not_found') {
            return asTextResult(ui("m_06adfdb126ca2f2d"), true);
        }
        if (loaded.type === 'submitted') {
            return asTextResult(ui("m_da391d05579986b7"), true);
        }
        // edit_acl 검사 — 기존 페이지가 있을 때만. draft 만 있는 케이스도 일치하는 페이지를 다시 조회한다.
        {
            const pageRow = loaded.page
                ? { id: loaded.page.id }
                : await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL')
                    .bind(slug)
                    .first<{ id: number }>();
            if (pageRow) {
                const aclErr = await enforceMcpEditAcl(db, user, rbac, pageRow, null);
                if (aclErr) return asTextResult('Error: ' + aclErr, true);
            }
        }

        const currentContent = loaded.content;

        // 등장 횟수 검사 — 겹치는 매치 포함 0회 또는 2회 이상이면 거부.
        let occurrences = 0;
        let searchFrom = 0;
        while (true) {
            const idx = currentContent.indexOf(oldStr, searchFrom);
            if (idx < 0) break;
            occurrences++;
            searchFrom = idx + 1;
            if (occurrences > 1) break;
        }
        if (occurrences === 0) {
            return asTextResult(ui("m_5215b013ba9c5c3e"), true);
        }
        if (occurrences > 1) {
            let total = 0;
            let from = 0;
            while (true) {
                const idx = currentContent.indexOf(oldStr, from);
                if (idx < 0) break;
                total++;
                from = idx + 1;
            }
            return asTextResult(
                ui("m_c87c37f4896b20b5", [total]) +
                ui("m_84109eed126cc204"),
                true
            );
        }

        // 함수형 replacer 로 newStr 을 리터럴로 삽입한다. 두 번째 인자가 문자열이면 JS 가
        // $&, $1, $$, $`, $' 같은 시퀀스를 특수 토큰으로 해석하므로 셸 변수, 정규식 스니펫,
        // 템플릿 문법(${var}) 같은 합법 본문이 조용히 다른 내용으로 바뀔 수 있다.
        const newContent = currentContent.replace(oldStr, () => newStr);

        // 기존 draft 면 본문만 갱신, 없으면 INSERT 로 새 draft 생성.
        let draftId: number;
        let baseRevisionId: number | null;
        let baseVersion: number;
        if (loaded.type === 'draft') {
            await db.prepare('UPDATE mcp_drafts SET content = ?, updated_at = unixepoch() WHERE id = ?')
                .bind(newContent, loaded.draftId!).run();
            draftId = loaded.draftId!;
            const meta = await db.prepare('SELECT base_revision_id, base_version FROM mcp_drafts WHERE id = ?')
                .bind(draftId).first<{ base_revision_id: number | null; base_version: number }>();
            baseRevisionId = meta!.base_revision_id;
            baseVersion = meta!.base_version;
        } else {
            // type === 'seeded' — 페이지 메타로부터 draft seed
            const ins = await db.prepare(
                `INSERT INTO mcp_drafts (user_id, slug, action, base_revision_id, base_version, content, category, redirect_to, editor_note)
                 VALUES (?, ?, 'update', ?, ?, ?, ?, ?, ?)`
            ).bind(
                user.id, slug, loaded.page!.last_revision_id, loaded.page!.version,
                newContent, loaded.page!.category, loaded.page!.redirect_to, loaded.page!.editor_note ?? null
            ).run();
            draftId = ins.meta.last_row_id;
            baseRevisionId = loaded.page!.last_revision_id;
            baseVersion = loaded.page!.version;
        }

        return asTextResult(JSON.stringify({
            draft_id: draftId,
            slug,
            replaced: 1,
            base_revision_id: baseRevisionId,
            base_version: baseVersion,
            content_length: newContent.length,
            note: loaded.type === 'seeded' ? DRAFT_FIRST_ISSUE_NOTE : DRAFT_UPDATE_NOTE,
        }, null, 2));
    }

    if (toolName === 'edit_section') {
        if (!rbac.can(user.role, 'wiki:edit')) {
            return asTextResult(ui("m_eaf5dbfe425cfa3f"), true);
        }
        const slug = String(args.title || '').trim();
        if (!slug) return asTextResult(ui("m_8ab6728713ad8858"), true);
        if (slug.startsWith('이미지:')) return asTextResult(ui("m_b553e7b7164d38ae"), true);
        if (slug.startsWith('map:')) return asTextResult(ui("m_51f6566a2dc68dac"), true);        const sectionNumber = String(args.section_number || '').trim();
        if (!sectionNumber) return asTextResult(ui("m_bf29c154ae523703"), true);
        if (typeof args.new_content !== 'string') {
            return asTextResult(ui("m_1be69df5082dfc07"), true);
        }

        const newSectionContent = (args.new_content as string).replace(/\r\n?/g, '\n');

        const loaded = await loadDraftOrSeedFromPage(c, user, slug);
        if (loaded.type === 'not_found') {
            return asTextResult(ui("m_06adfdb126ca2f2d"), true);
        }
        if (loaded.type === 'submitted') {
            return asTextResult(ui("m_da391d05579986b7"), true);
        }
        // edit_acl 검사 — 기존 페이지가 있을 때만 (draft 만 있는 케이스도 일치 페이지 재조회).
        {
            const pageRow = loaded.page
                ? { id: loaded.page.id }
                : await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL')
                    .bind(slug)
                    .first<{ id: number }>();
            if (pageRow) {
                const aclErr = await enforceMcpEditAcl(db, user, rbac, pageRow, null);
                if (aclErr) return asTextResult('Error: ' + aclErr, true);
            }
        }

        const currentContent = loaded.content;

        const newContent = replaceSection(currentContent, sectionNumber, newSectionContent);
        if (newContent === null) {
            return asTextResult(
                ui("m_6c36b8c1eeb7f782", [sectionNumber]) +
                ui("m_d6939b8ab743c3cb"),
                true
            );
        }
        if (newContent === currentContent) {
            return asTextResult(ui("m_5ee1357c836e3265"), true);
        }

        let draftId: number;
        let baseRevisionId: number | null;
        let baseVersion: number;
        if (loaded.type === 'draft') {
            await db.prepare('UPDATE mcp_drafts SET content = ?, updated_at = unixepoch() WHERE id = ?')
                .bind(newContent, loaded.draftId!).run();
            draftId = loaded.draftId!;
            const meta = await db.prepare('SELECT base_revision_id, base_version FROM mcp_drafts WHERE id = ?')
                .bind(draftId).first<{ base_revision_id: number | null; base_version: number }>();
            baseRevisionId = meta!.base_revision_id;
            baseVersion = meta!.base_version;
        } else {
            const ins = await db.prepare(
                `INSERT INTO mcp_drafts (user_id, slug, action, base_revision_id, base_version, content, category, redirect_to, editor_note)
                 VALUES (?, ?, 'update', ?, ?, ?, ?, ?, ?)`
            ).bind(
                user.id, slug, loaded.page!.last_revision_id, loaded.page!.version,
                newContent, loaded.page!.category, loaded.page!.redirect_to, loaded.page!.editor_note ?? null
            ).run();
            draftId = ins.meta.last_row_id;
            baseRevisionId = loaded.page!.last_revision_id;
            baseVersion = loaded.page!.version;
        }

        return asTextResult(JSON.stringify({
            draft_id: draftId,
            slug,
            section_number: sectionNumber,
            base_revision_id: baseRevisionId,
            base_version: baseVersion,
            content_length: newContent.length,
            note: loaded.type === 'seeded' ? DRAFT_FIRST_ISSUE_NOTE : DRAFT_UPDATE_NOTE,
        }, null, 2));
    }

    if (toolName === 'commit_edit') {
        if (!rbac.can(user.role, 'wiki:edit')) {
            return asTextResult(ui("m_eaf5dbfe425cfa3f"), true);
        }
        const draftId = Number(args.draft_id);
        if (!Number.isFinite(draftId) || draftId <= 0) {
            return asTextResult(ui("m_b61bfa2e7e9f6307"), true);
        }
        const summary = (typeof args.summary === 'string' && args.summary.length > 0) ? args.summary : null;
        const summaryLengthError = validateMcpSummaryLength(summary);
        if (summaryLengthError) {
            return asTextResult(summaryLengthError, true);
        }
        const draft = await db.prepare(
            `SELECT id, user_id, slug, action, base_revision_id, base_version,
                    content, category, redirect_to, title, has_title_change, editor_note, submitted_at
             FROM mcp_drafts WHERE id = ?`
        ).bind(draftId).first<{
            id: number; user_id: number; slug: string; action: string;
            base_revision_id: number | null; base_version: number; content: string;
            category: string | null; redirect_to: string | null;
            title: string | null; has_title_change: number; editor_note: string | null;
            submitted_at: number | null;
        }>();
        if (!draft) return asTextResult(ui("m_1e2db7eab1f0eda0"), true);
        if (draft.user_id !== user.id) return asTextResult(ui("m_06ef274dccd56546"), true);
        // 이미 승인 대기로 제출된 draft 는 사람이 검토 중이므로 AI 가 재제출/재커밋 불가.
        // 다시 편집하려면 사람이 거부(reject) 하거나 AI 가 discard_edit 후 새로 시작.
        if (draft.submitted_at !== null) {
            return asTextResult(
                ui("m_0c9d736ef7c1be1c"),
                true
            );
        }

        const slug = draft.slug;

        if (draft.action === 'update') {
            const page = await db.prepare(
                'SELECT id, version, content, category, last_revision_id, title FROM pages WHERE slug = ? AND deleted_at IS NULL'
            ).bind(slug).first<{ id: number; version: number; content: string; category: string | null; last_revision_id: number | null; title: string | null }>();
            if (!page) {
                return asTextResult(JSON.stringify({
                    error: "conflict",
                    reason: "page_missing",
                    message: ui("m_96a6516836c03caf"),
                }, null, 2), true);
            }
            if (page.last_revision_id !== draft.base_revision_id || page.version !== draft.base_version) {
                return asTextResult(JSON.stringify({
                    error: "conflict",
                    reason: "concurrent_modification",
                    message: ui("m_90150790f9c7a71e"),
                    base_revision_id: draft.base_revision_id,
                    base_version: draft.base_version,
                    current_revision_id: page.last_revision_id,
                    current_version: page.version,
                }, null, 2), true);
            }

            // edit_acl 최종 검사 (commit 시점 — race 안전망, admin_only 포함).
            {
                const aclErr = await enforceMcpEditAcl(db, user, rbac, { id: page.id }, null);
                if (aclErr) return asTextResult('Error: ' + aclErr, true);
            }

            // draft 가 title 변경을 요청한 경우, 즉시 커밋 시점에 다른 페이지가 그 title 을
            // 이미 가져갔는지 재검증 — idx_pages_title_unique UNIQUE 위반으로 R2/revision 쓰기 후
            // 무특정 실패가 나는 것을 방지.
            if (draft.has_title_change && draft.title) {
                const titleConflict = await findConflictingPage(db, draft.title, page.id);
                if (titleConflict) {
                    const deletedSuffix = titleConflict.isDeleted ? ui("m_498cdf7a4578a46f") : '';
                    return asTextResult(
                        titleConflict.matchedColumn === 'slug'
                            ? ui("m_90b56fb3e80e056e", [draft.title, deletedSuffix])
                            : ui("m_9eeaa6a50cf56682", [draft.title, deletedSuffix]),
                        true,
                    );
                }
            }

            // commit 직후 diff 통계(+추가/-삭제 라인)를 응답에 포함하기 위해 이전 본문을 로드한다.
            // R2 전용 네임스페이스 페이지는 pages.content 가 빈 문자열로 저장되므로, 마지막 리비전을 R2 에서 읽어온다.
            // CRLF→LF 정규화 후 비교해 줄바꿈 형식 차이로 인한 가짜 변경을 제거한다.
            // ⚠️ 이전 본문 로드(D1/R2)가 실패하더라도 본 commit 자체는 막지 않는다 — 새 본문은 이미 검증되어
            // 저장 가능한 상태이며, diff 통계는 부수 정보일 뿐이다. 실패 시 마커/응답 필드만 생략한다.
            const enabledExtForDiff = getEnabledExtensions(c.env);
            let diffStats: { added: number; removed: number } | null = null;
            try {
                let prevContent = page.content || '';
                if (isR2OnlyNamespace(slug, enabledExtForDiff) && prevContent === '' && page.last_revision_id) {
                    const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?')
                        .bind(page.last_revision_id)
                        .first<{ content: string; r2_key: string | null }>();
                    if (lastRev) {
                        prevContent = await getRevisionContent(c.env.MEDIA, lastRev, new URL(c.req.url).origin);
                    }
                }
                diffStats = computeLineDiffStats(
                    prevContent.replace(/\r\n?/g, '\n'),
                    draft.content.replace(/\r\n?/g, '\n')
                );
            } catch (e) {
                console.error('admin-mcp commit_edit diff stats failed (commit will proceed without marker):', e);
                diffStats = null;
            }
            // 즉시 리비전을 만들지 않고 본인(OAuth 토큰 소유자) 의 승인 대기로 제출한다.
            // 잠금/충돌 검증은 이미 통과한 상태이므로 같은 정책으로 mypage 에서 다시 확인된다.
            const submittedAtRow = await markDraftSubmittedAndNotify(c, draft.id, slug, summary);
            if (!submittedAtRow) {
                return asTextResult(
                    ui("m_f2a2c84b1393640d"),
                    true
                );
            }
            return asTextResult(JSON.stringify({
                slug,
                submitted: true,
                submitted_at: submittedAtRow.iso,
                draft_id: draft.id,
                action: 'update',
                base_revision_id: draft.base_revision_id,
                base_version: draft.base_version,
                ...(diffStats ? { lines_added: diffStats.added, lines_removed: diffStats.removed } : {}),
                notice: ui("m_4f58ec5b5e4730aa"),
            }, null, 2));
        }

        if (draft.action === 'create') {
            const livePage = await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL').bind(slug).first();
            if (livePage) {
                return asTextResult(JSON.stringify({
                    error: "conflict",
                    reason: "slug_taken",
                    message: ui("m_87e7f7a96beea8fb"),
                }, null, 2), true);
            }
            const deletedConflict = await db.prepare('SELECT id FROM pages WHERE slug = ? AND deleted_at IS NOT NULL').bind(slug).first();
            if (deletedConflict) {
                return asTextResult(
                    ui("m_1305aec62a88f8a3") +
                    ui("m_f5ce6ee4e62e8de6"),
                    true
                );
            }

            // 신규 슬러그 자체 또는 draft 가 변경 요청한 title 이 다른 페이지와 충돌하는지 재검증.
            // (draft 작성 시점 검사만으로는 race 를 막을 수 없고 UNIQUE 위반으로 무특정 500 이 나올 수 있다.)
            const slugTitleConflict = await findConflictingPage(db, slug, null);
            if (slugTitleConflict && slugTitleConflict.matchedColumn === 'title') {
                return asTextResult(
                    ui("m_45e2704a9530e5f8", [slug]),
                    true,
                );
            }
            if (draft.has_title_change && draft.title) {
                const titleConflict = await findConflictingPage(db, draft.title, null);
                if (titleConflict) {
                    return asTextResult(
                        titleConflict.matchedColumn === 'slug'
                            ? ui("m_5797a6d9c5ecfc15", [draft.title])
                            : ui("m_2a061c6193cd4033", [draft.title]),
                        true,
                    );
                }
            }

            // edit_acl 최종 검사 — 신규 문서: prefix 룰 ACL.
            // 평가 통과한 ACL 은 새 페이지에 그대로 기록해, 생성 이후 편집도 같은 정책을 적용한다.
            // (관리자: enforceMcpEditAcl 가 즉시 통과시키지만, prefix 룰은 관리자 생성 페이지에도
            // 동일하게 자동 적용되는 것이 /api/w/:slug 흐름과 일관된다.)
            let createEditAclSerialized: string | null = null;
            {
                const aclErr = await enforceMcpEditAcl(db, user, rbac, null, slug);
                if (aclErr) return asTextResult('Error: ' + aclErr, true);
                const prefixAcl = await findPrefixRuleEditAcl(db, slug);
                if (prefixAcl && prefixAcl.flags.length > 0) {
                    createEditAclSerialized = serializeEditAcl(prefixAcl);
                }
            }

            // 신규 페이지는 이전 본문이 없으므로 모든 라인이 추가로 카운트된다.
            // 빈 본문 입력에서는 computeLineDiffStats 가 DP 를 거치지 않고 즉시 반환하지만,
            // 시그니처상 null 가능성이 있으므로 동일하게 fallback 처리한다.
            const createDiffStats = computeLineDiffStats('', draft.content.replace(/\r\n?/g, '\n'));

            const submittedAtRow = await markDraftSubmittedAndNotify(c, draft.id, slug, summary);
            if (!submittedAtRow) {
                return asTextResult(
                    ui("m_f2a2c84b1393640d"),
                    true
                );
            }
            return asTextResult(JSON.stringify({
                slug,
                submitted: true,
                submitted_at: submittedAtRow.iso,
                draft_id: draft.id,
                action: 'create',
                ...(createDiffStats ? { lines_added: createDiffStats.added, lines_removed: createDiffStats.removed } : {}),
                notice: ui("m_d43fc755953e8e89"),
            }, null, 2));
        }

        return asTextResult(ui("m_d8488b87a42a88f5", [draft.action]), true);
    }

    if (toolName === 'discard_edit') {
        const draftId = Number(args.draft_id);
        if (!Number.isFinite(draftId) || draftId <= 0) {
            return asTextResult(ui("m_b61bfa2e7e9f6307"), true);
        }
        const draft = await db.prepare('SELECT id, user_id, slug, submitted_at FROM mcp_drafts WHERE id = ?')
            .bind(draftId).first<{ id: number; user_id: number; slug: string; submitted_at: number | null }>();
        if (!draft) return asTextResult(ui("m_71a4c23be8db3690"), true);
        if (draft.user_id !== user.id) return asTextResult(ui("m_a5438b3b7fb76bf4"), true);
        // 승인 대기 상태였다면 알림도 같이 정리한다 — mypage 목록에서 사라지므로 알림만 남으면 dead link 가 된다.
        await db.batch([
            db.prepare("DELETE FROM notifications WHERE type = 'mcp_submission' AND ref_id = ?").bind(draftId),
            db.prepare('DELETE FROM mcp_drafts WHERE id = ?').bind(draftId),
        ]);
        return asTextResult(JSON.stringify({
            draft_id: draftId,
            slug: draft.slug,
            discarded: true,
            was_submitted: draft.submitted_at !== null,
        }, null, 2));
    }

    if (toolName === 'revert_page') {
        if (!rbac.can(user.role, 'wiki:revert')) return asTextResult(ui('permissions.denied'), true);
        if (!rbac.can(user.role, 'wiki:revert')) {
            return asTextResult(ui("m_eaf5dbfe425cfa3f"), true);
        }
        const slug = String(args.title || '').trim();
        const revisionId = Number(args.revision_id);
        if (!slug) return asTextResult(ui("m_8ab6728713ad8858"), true);
        if (!Number.isFinite(revisionId) || revisionId <= 0) {
            return asTextResult(ui("m_342d2c21b9f70059"), true);
        }

        const page = await db
            .prepare('SELECT id, version, content, category, is_private FROM pages WHERE slug = ? AND deleted_at IS NULL')
            .bind(slug)
            .first<{ id: number; version: number; content: string; category: string | null; is_private: number }>();
        if (!page) return asTextResult(ui("m_d023ab691dff7bd9"), true);

        // 비공개 문서 가시성 게이트 — 웹 POST /w/:slug/revert 와 동일. wiki:private 권한이 없으면
        // 문서가 존재하지 않는 것처럼 가린다 (revert 로 비공개 본문을 끌어오는 것을 막는다).
        if (page.is_private === 1 && !rbac.can(user.role, 'wiki:private')) {
            return asTextResult(ui("m_d023ab691dff7bd9"), true);
        }

        // edit_acl 검사 — 되돌리기도 편집의 일종. admin_only 가 있으면 비관리자 차단.
        {
            const aclErr = await enforceMcpEditAcl(db, user, rbac, { id: page.id }, null);
            if (aclErr) return asTextResult('Error: ' + aclErr, true);
        }

        // 리비전이 정말로 이 페이지에 속하는지 검증 — 다른 페이지 리비전 id 를 입력해
        // 본문을 끌어오는 것을 막는다.
        // 레거시 DB(is_virtual 컬럼 부재) 대비 idempotent 마이그레이션 보장 후 쿼리.
        await ensureRevisionsVirtualMigration(db);
        const rev = await db
            .prepare('SELECT id, page_id, page_version, content, r2_key, deleted_at, purged_at, is_virtual FROM revisions WHERE id = ?')
            .bind(revisionId)
            .first<{ id: number; page_id: number; page_version: number | null; content: string; r2_key: string | null; deleted_at: number | null; purged_at: number | null; is_virtual: number }>();
        if (!rev) return asTextResult(ui("m_1c0d1ec937005f23"), true);
        if (rev.page_id !== page.id) {
            return asTextResult(ui("m_79a074aac12f4b03"), true);
        }
        // 본문 없는/가려진 리비전으로의 되돌리기 차단 — HTTP POST /w/:slug/revert 와 동일 정책.
        //  - 가상 리비전(is_virtual)/하드 삭제(purged_at): content='' 이라 되돌리면 본문이 빈 페이지로
        //    덮어써진다(데이터 손실). 명시적으로 거부.
        //  - 소프트 삭제(deleted_at): 의도적으로 가려진 본문이므로 redaction 우회를 막기 위해 거부.
        if (rev.is_virtual) {
            return asTextResult(ui("m_d365748ab682796b"), true);
        }
        if (rev.purged_at) {
            return asTextResult(ui("m_59a499ddfeccdc0d"), true);
        }
        if (rev.deleted_at) {
            return asTextResult(ui("m_55c56ac0928877ec"), true);
        }

        const origin = new URL(c.req.url).origin;
        // wiki.ts 의 POST /w/:slug/revert 와 동일하게 CRLF→LF 정규화 후 저장한다.
        // 레거시 리비전이 CRLF 로 남아 있을 수 있어 정규화하지 않으면 새 리비전에 혼합 라인엔딩이
        // 다시 들어가 다운스트림 파싱/편집이 어긋난다.
        const revContent = (await getRevisionContent(c.env.MEDIA, { content: rev.content, r2_key: rev.r2_key }, origin))
            .replace(/\r\n?/g, '\n');

        const summary = (typeof args.summary === 'string' && args.summary.length > 0)
            ? args.summary
            : `reverted to revision #${revisionId}`;
        const summaryLengthError = validateMcpSummaryLength(summary);
        if (summaryLengthError) return asTextResult(summaryLengthError, true);

        try {
            const result = await applyExistingPageUpdate(c, user, page, revContent, {
                requiredPermission: 'wiki:revert',
                summary,
                slug,
            });
            return asTextResult(JSON.stringify({
                slug,
                version: result.new_version,
                revision_id: result.revision_id,
                reverted_to: revisionId,
                rows: result.rows,
                characters: result.characters,
            }, null, 2));
        } catch (e: any) {
            if (e?.code === 'CONCURRENT_MODIFICATION') {
                return asTextResult(JSON.stringify({
                    error: "conflict",
                    reason: "concurrent_modification",
                    message: ui("m_694af6f9095a9def"),
                }, null, 2), true);
            }
            return asTextResult(ui("m_aa3a49af02c77e8c", [e?.message || e]), true);
        }
    }

    if (toolName === 'delete_page') {
        const slug = String(args.title || '').trim();
        if (!slug) return asTextResult(ui("m_8ab6728713ad8858"), true);
        const hard = args.hard === true;

        const page = await db
            .prepare('SELECT id, edit_acl, is_private FROM pages WHERE slug = ? AND deleted_at IS NULL')
            .bind(slug)
            .first<{ id: number; edit_acl: string | null; is_private: number }>();
        if (!page) return asTextResult(ui("m_f4ec1684e2260eeb"), true);
        if (page.is_private && !rbac.can(user.role, 'wiki:private')) return asTextResult(ui('permissions.denied'), true);

        if (hard) {
            if (!rbac.can(user.role, '*')) return asTextResult(ui("m_a1dbee63d898ee47"), true);
            const revisionKeys = await db.prepare('SELECT r2_key FROM revisions WHERE page_id = ? AND r2_key IS NOT NULL').bind(page.id).all<{ r2_key: string }>();
            if (revisionKeys.results.length > 0) {
                await Promise.all(revisionKeys.results.map(r => c.env.MEDIA.delete(r.r2_key)));
            }
            await db.batch([
                // source_type='page' + blog=0 양쪽 — legacy 블로그 행 (source_type='page' + blog=1)
                // 이 같은 id 일 때 잘못 삭제되지 않도록.
                db.prepare(
                    "DELETE FROM page_links WHERE source_page_id = ? AND source_type = 'page' AND blog = 0"
                ).bind(page.id),
                db.prepare('DELETE FROM page_categories WHERE page_id = ?').bind(page.id),
                db.prepare('DELETE FROM revisions WHERE page_id = ?').bind(page.id),
                db.prepare('DELETE FROM pages WHERE id = ?').bind(page.id),
            ]);
            c.executionCtx.waitUntil(
                db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                    .bind('hard_delete', ui("m_c8a7907ff37ab3c3", [slug]), user.id)
                    .run().catch(() => {})
            );
            // RAG 미러 정리: 영구 삭제는 D1 에서 완전히 사라지므로 인덱스 위생을 위해 R2 객체도 제거.
            // (소프트 삭제는 R2 를 건드리지 않는다 — 검색 결과의 deleted_at 사후 필터가 가려주고,
            //  복원 시 즉시 다시 검색 가능해야 하기 때문.)
            removePageMirror(c.env, c.executionCtx, slug);
        } else {
            if (!rbac.can(user.role, 'wiki:delete')) return asTextResult(ui("m_67fc323a30e1f44d"), true);
            // 소프트 삭제도 본문을 무력화하는 편집의 일종이므로 웹 DELETE /w/:slug 와 동일한 edit_acl
            // 게이트를 적용한다. admin_only 뿐 아니라 aged/page_editor 등 모든 ACL 규칙을 evaluate 한다
            // (enforceMcpEditAcl 가 page.edit_acl 로 판정). wiki:delete 를 비관리자 역할에 부여한
            // 커스텀 RBAC 에서 ACL 잠금을 우회해 삭제하는 것을 막는다.
            {
                const aclErr = await enforceMcpEditAcl(db, user, rbac, { id: page.id, edit_acl: page.edit_acl }, null);
                if (aclErr) return asTextResult('Error: ' + aclErr, true);
            }
            await db.prepare('UPDATE pages SET deleted_at = unixepoch() WHERE id = ?').bind(page.id).run();
            c.executionCtx.waitUntil(
                db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                    .bind('soft_delete', ui("m_b80e25642871183c", [slug]), user.id)
                    .run().catch(() => {})
            );
        }
        c.executionCtx.waitUntil(Promise.allSettled([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, slug, db),
        ]));
        return asTextResult(JSON.stringify({ slug, deleted: true, hard }, null, 2));
    }

    if (toolName === 'restore_page') {
        if (!rbac.can(user.role, 'wiki:restore')) return asTextResult(ui('permissions.denied'), true);
        const slug = String(args.title || '').trim();
        if (!slug) return asTextResult(ui("m_8ab6728713ad8858"), true);
        if (!rbac.can(user.role, 'wiki:restore')) return asTextResult(ui("m_e71689f947fff666"), true);
        if (slug.startsWith('이미지:')) return asTextResult(ui("m_c0cae7a74ebe04c8"), true);
        if (slug.startsWith('map:')) return asTextResult(ui("m_0c5192f5f86de2aa"), true);

        const page = await db.prepare('SELECT id, deleted_at, is_private FROM pages WHERE slug = ?').bind(slug).first<{ id: number; deleted_at: number | null; is_private: number }>();
        if (!page) return asTextResult(ui("m_36f26fa461c07fd6"), true);
        if (page.is_private && !rbac.can(user.role, 'wiki:private')) return asTextResult(ui('permissions.denied'), true);
        if (!page.deleted_at) return asTextResult(ui("m_f3cd5840152553ef"), true);

        await db.prepare('UPDATE pages SET deleted_at = NULL WHERE id = ?').bind(page.id).run();
        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('restore', ui("m_2f067521b8876bdb", [slug]), user.id)
                .run().catch(() => {})
        );
        c.executionCtx.waitUntil(Promise.allSettled([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, slug, db),
        ]));
        return asTextResult(JSON.stringify({ slug, restored: true }, null, 2));
    }

    if (toolName === 'move_page') {
        if (!rbac.can(user.role, 'wiki:move')) return asTextResult(ui('permissions.denied'), true);
        const oldSlug = String(args.title || '').trim();
        const newSlug = String(args.new_title || '').trim();
        if (!oldSlug || !newSlug) return asTextResult(ui("m_14e60317e5fae82c"), true);
        if (oldSlug === newSlug) return asTextResult(ui("m_cb1a1e273aea7b04"), true);
        if (SLUG_FORBIDDEN_CHARS.test(newSlug)) return asTextResult(ui("m_856dd2df08c4246a"), true);
        if (oldSlug.startsWith('이미지:') || newSlug.startsWith('이미지:')) {
            return asTextResult(ui("m_cc9846e90f9e828a"), true);
        }
        if (oldSlug.startsWith('map:') || newSlug.startsWith('map:')) {
            return asTextResult(ui("m_1cc7261dc2df7fdf"), true);
        }

        // 네임스페이스 이동 제한: 콜론이 포함된 문서(틀:, template:, 카테고리: 등)는
        // 동일 네임스페이스 내에서만 이동할 수 있다. wiki.ts 의 POST /w/:slug/move 와 동일 정책.
        const isNamespaceDocument = oldSlug.includes(':');
        const currentNamespace = isNamespaceDocument ? oldSlug.split(':')[0] : '';
        const newNamespace = newSlug.includes(':') ? newSlug.split(':')[0] : '';
        if (isNamespaceDocument && currentNamespace !== newNamespace) {
            return asTextResult(ui("m_0146467f26ec73c6"), true);
        }

        // 기본값 true — 명시적으로 false 가 지정된 경우에만 백링크 갱신을 건너뛴다.
        // (boolean 이외의 값은 무시하고 기본 true 로 처리.)
        const updateBacklinks = args.update_backlinks !== false;

        const page = await db
            .prepare('SELECT id, version, content, category, last_revision_id, edit_acl FROM pages WHERE slug = ? AND deleted_at IS NULL')
            .bind(oldSlug)
            .first<{ id: number; version: number; content: string; category: string | null; last_revision_id: number | null; edit_acl: string | null }>();
        if (!page) return asTextResult(ui("m_d023ab691dff7bd9"), true);

        // admin_only ACL 문서 이동은 관리자만 가능 (구 wiki:lock 검사 대체).
        const movePageIsAdmin = rbac.can(user.role, 'admin:access');
        if (!movePageIsAdmin) {
            const aclMove = parseEditAcl(page.edit_acl);
            if (aclMove && aclMove.flags.includes('admin_only')) {
                return asTextResult(ui("m_0b5af618752913e3"), true);
            }
        }

        // 새 슬러그가 다른 문서의 slug 또는 title 과 충돌하는지 검사. 소프트 삭제 행도 포함.
        const moveConflict = await findConflictingPage(db, newSlug, page.id);
        if (moveConflict) {
            const deletedSuffix = moveConflict.isDeleted ? ui("m_498cdf7a4578a46f") : '';
            const msg = moveConflict.matchedColumn === 'slug'
                ? ui("m_fdfa5a2d5f78e542", [deletedSuffix])
                : ui("m_5c8f76d6c556ba92", [newSlug, deletedSuffix]);
            return asTextResult(msg, true);
        }

        const enabledExt = getEnabledExtensions(c.env);
        const isR2Only = isR2OnlyNamespace(oldSlug, enabledExt);
        let currentContent = page.content;
        if (isR2Only && (!currentContent || currentContent === '') && page.last_revision_id) {
            const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(page.last_revision_id).first<{ content: string; r2_key: string | null }>();
            if (lastRev) currentContent = await getRevisionContent(c.env.MEDIA, lastRev, new URL(c.req.url).origin);
        }

        const rewritten = rewriteContentForRename(currentContent, oldSlug, newSlug);
        const contentChanged = rewritten !== currentContent;
        // 본문 재작성이 필요할 때만 새 리비전을 만들고 version 을 올린다. 자기 자신을 참조하지
        // 않는 문서는 슬러그만 바뀌므로 version/last_revision_id 가 그대로 유지되며,
        // 응답에서도 보고된 version 이 실제 저장 상태와 일치해야 optimistic locking 이 깨지지 않는다.
        let newVersion = page.version;
        let newRevisionId = page.last_revision_id;

        try {
            if (contentChanged) {
                newVersion = page.version + 1;
                const r2Key = await uploadRevisionToR2(c.env.MEDIA, page.id, newVersion, rewritten);
                const revResult = await db
                    .prepare('INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)')
                    .bind(page.id, newVersion, '', r2Key, withMcpPrefix(`[move] ${oldSlug} → ${newSlug}`), user.id)
                    .run();
                newRevisionId = revResult.meta.last_row_id;
                const newIsR2Only = isR2OnlyNamespace(newSlug, enabledExt);
                const contentToStore = newIsR2Only ? '' : rewritten;
                const metrics = computePageMetricsTracked(rewritten, newIsR2Only);
                try {
                    await db
                        .prepare('UPDATE pages SET slug = ?, content = ?, last_revision_id = ?, version = ?, rows = ?, characters = ?, updated_at = unixepoch() WHERE id = ?')
                        .bind(newSlug, contentToStore, newRevisionId, newVersion, metrics.rows, metrics.characters, page.id)
                        .run();
                } catch (e) {
                    // 트리거/UNIQUE 위반 시 막 만든 리비전 + R2 객체 정리.
                    await db.prepare('DELETE FROM revisions WHERE id = ?').bind(newRevisionId).run().catch(() => {});
                    await c.env.MEDIA.delete(r2Key).catch(() => {});
                    throw e;
                }
                const linkCatStmts = buildLinkAndCategoryStatements(db, page.id, rewritten, page.category);
                c.executionCtx.waitUntil(db.batch(linkCatStmts).catch(e => console.error('admin-mcp move link/cat batch failed:', e)));
            } else {
                await db.prepare('UPDATE pages SET slug = ?, updated_at = unixepoch() WHERE id = ?').bind(newSlug, page.id).run();
                // 본문 재작성이 없는 슬러그 전용 이동도 편집 이력에 가상 리비전으로 남긴다
                // (HTTP POST /w/:slug/move · 대량 이동과 동일). 본문이 바뀌는 분기는 위에서
                // 이미 [move] 본문 리비전을 만들므로 별도 가상 리비전이 필요 없다.
                try {
                    await insertVirtualRevision(db, page.id, withMcpPrefix(ui("m_f9b2c39ea47d991a", [oldSlug, newSlug])), user.id);
                } catch (e) {
                    console.error('Failed to write virtual revision for MCP slug-only move:', e);
                }
            }
        } catch (e: any) {
            const msg = String(e?.message || e);
            if (/UNIQUE|constraint/i.test(msg)) {
                return asTextResult(ui("m_8f525ba61830ea2f"), true);
            }
            throw e;
        }

        const updatedSlugs: string[] = [];
        const skippedLockedSlugs: string[] = [];
        if (updateBacklinks) {
            const { results: backlinks } = await db
                .prepare(`
                    SELECT DISTINCT p.id, p.slug, p.version, p.content, p.category, p.last_revision_id, p.edit_acl
                    FROM page_links pl
                    JOIN pages p ON pl.source_page_id = p.id
                    WHERE pl.blog = 0 AND pl.source_type = 'page'
                      AND pl.link_type IN ('wikilink', 'template', 'extension')
                      AND pl.target_slug = ? AND p.deleted_at IS NULL AND p.id != ?
                `)
                .bind(oldSlug, page.id)
                .all<{ id: number; slug: string; version: number; content: string; category: string | null; last_revision_id: number | null; edit_acl: string | null }>();

            for (const bl of backlinks) {
                // admin_only ACL 역링크 문서는 관리자만 재작성 가능 (구 wiki:lock 검사 대체).
                if (!movePageIsAdmin) {
                    const blAcl = parseEditAcl(bl.edit_acl);
                    if (blAcl && blAcl.flags.includes('admin_only')) {
                        skippedLockedSlugs.push(bl.slug);
                        continue;
                    }
                }
                const blIsR2 = isR2OnlyNamespace(bl.slug, enabledExt);
                let blContent = bl.content;
                if (blIsR2 && (!blContent || blContent === '') && bl.last_revision_id) {
                    const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(bl.last_revision_id).first<{ content: string; r2_key: string | null }>();
                    if (lastRev) blContent = await getRevisionContent(c.env.MEDIA, lastRev, new URL(c.req.url).origin);
                }
                const blRewritten = rewriteContentForRename(blContent, oldSlug, newSlug);
                if (blRewritten === blContent) continue;
                const blNewVer = bl.version + 1;
                const blR2Key = await uploadRevisionToR2(c.env.MEDIA, bl.id, blNewVer, blRewritten);
                const blRev = await db
                    .prepare('INSERT INTO revisions (page_id, page_version, content, r2_key, summary, author_id) VALUES (?, ?, ?, ?, ?, ?)')
                    .bind(bl.id, blNewVer, '', blR2Key, withMcpPrefix(`[move-backlink] ${oldSlug} → ${newSlug}`), user.id)
                    .run();
                const blMetrics = computePageMetricsTracked(blRewritten, blIsR2);
                const blContentToStore = blIsR2 ? '' : blRewritten;
                await db
                    .prepare('UPDATE pages SET content = ?, last_revision_id = ?, version = ?, rows = ?, characters = ?, updated_at = unixepoch() WHERE id = ?')
                    .bind(blContentToStore, blRev.meta.last_row_id, blNewVer, blMetrics.rows, blMetrics.characters, bl.id)
                    .run();
                const stmts = buildLinkAndCategoryStatements(db, bl.id, blRewritten, bl.category);
                c.executionCtx.waitUntil(db.batch(stmts).catch(e => console.error('admin-mcp move backlink batch failed:', e)));
                updatedSlugs.push(bl.slug);
            }
        }

        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('move', ui("m_ff744d061f41f00f", [oldSlug, newSlug, updateBacklinks ? ui("m_dd24a86b62797590", [updatedSlugs.length]) : '']), user.id)
                .run().catch(() => {})
        );
        c.executionCtx.waitUntil(Promise.allSettled([
            invalidatePageCache(c, oldSlug),
            invalidatePageCache(c, newSlug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, oldSlug, db),
            invalidateBacklinkCaches(c, newSlug, db),
            ...updatedSlugs.map(s => invalidatePageCache(c, s)),
        ]));

        return asTextResult(JSON.stringify({
            old_slug: oldSlug,
            new_slug: newSlug,
            content_rewritten: contentChanged,
            new_version: newVersion,
            updated_backlinks: updatedSlugs.length,
            updated_backlink_slugs: updatedSlugs,
            skipped_locked_backlinks: skippedLockedSlugs,
        }, null, 2));
    }

    // ────────────────────────────────────────────────────────────────
    // 블로그 CRUD (admin 전용, 즉시 적용 — draft 모델 미사용).
    // routes/blog.ts 의 POST/PUT/DELETE /api/blog 엔드포인트와 동일한 동작을 수행한다.
    // ────────────────────────────────────────────────────────────────

    if (toolName === 'create_blog_post' || toolName === 'update_blog_post'
        || toolName === 'delete_blog_post' || toolName === 'restore_blog_post') {
        if (!rbac.can(user.role, 'admin:access')) {
            return asTextResult(ui("m_b525ffd5499fc86d"), true);
        }
    }

    if (toolName === 'create_blog_post') {
        if (typeof args.title !== 'string') return asTextResult(ui("m_2f1b7032fa67d995"), true);
        if (typeof args.content !== 'string') return asTextResult(ui("m_b3104adc425b92b3"), true);
        const title = args.title.trim();
        if (!title) return asTextResult(ui("m_9952e26982704b4f"), true);
        if (title.length > 500) return asTextResult(ui("m_e602bd6e22f66637"), true);

        // routes/blog.ts 와 동일하게 CRLF → LF 정규화. 줄 수/글자 수도 동일 기준으로 계산.
        const content = (args.content as string).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const rows = content ? content.split('\n').length : 0;
        const characters = content ? content.length : 0;
        const thumbnail = extractFirstThumbnail(content);

        const result = await db
            .prepare('INSERT INTO blog_posts (title, content, rows, characters, thumbnail) VALUES (?, ?, ?, ?, ?)')
            .bind(title, content, rows, characters, thumbnail)
            .run();
        const newId = Number(result.meta?.last_row_id || 0);
        if (!newId) return asTextResult(ui("m_455e32fcc4e8b0c4"), true);

        c.executionCtx.waitUntil(rebuildBlogImageLinks(db, newId, content));
        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('blog_create', ui("m_9e203cd85a24d16a", [title]), user.id)
                .run().catch((e: any) => console.error('admin-mcp blog_create admin_log write failed:', e))
        );

        return asTextResult(JSON.stringify({
            id: newId,
            title,
            rows,
            characters,
            thumbnail,
            created: true,
        }, null, 2));
    }

    if (toolName === 'update_blog_post') {
        const id = Number(args.id);
        if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
            return asTextResult(ui("m_6dcf73d828a63cfe"), true);
        }
        const wantsTitle = args.title !== undefined;
        const wantsContent = args.content !== undefined;
        if (!wantsTitle && !wantsContent) {
            return asTextResult(ui("m_a2251307d59448a7"), true);
        }
        if (wantsTitle && typeof args.title !== 'string') {
            return asTextResult(ui("m_2f1b7032fa67d995"), true);
        }
        if (wantsContent && typeof args.content !== 'string') {
            return asTextResult(ui("m_b3104adc425b92b3"), true);
        }

        const existing = await db
            .prepare('SELECT id, title FROM blog_posts WHERE id = ? AND deleted_at IS NULL')
            .bind(id)
            .first<{ id: number; title: string }>();
        if (!existing) return asTextResult(ui("m_6eec2c670cd0b15c"), true);

        const newTitle = wantsTitle ? (args.title as string).trim() : existing.title;
        if (!newTitle) return asTextResult(ui("m_9952e26982704b4f"), true);
        if (newTitle.length > 500) return asTextResult(ui("m_e602bd6e22f66637"), true);

        if (wantsContent) {
            const content = (args.content as string).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            const rows = content ? content.split('\n').length : 0;
            const characters = content ? content.length : 0;
            const thumbnail = extractFirstThumbnail(content);

            await db.prepare(
                'UPDATE blog_posts SET title = ?, content = ?, rows = ?, characters = ?, thumbnail = ?, updated_at = unixepoch() WHERE id = ?'
            ).bind(newTitle, content, rows, characters, thumbnail, id).run();
            c.executionCtx.waitUntil(rebuildBlogImageLinks(db, id, content));

            c.executionCtx.waitUntil(
                db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                    .bind('blog_update', ui("m_c0149a7404a737ca", [newTitle]), user.id)
                    .run().catch((e: any) => console.error('admin-mcp blog_update admin_log write failed:', e))
            );

            return asTextResult(JSON.stringify({
                id, title: newTitle, rows, characters, thumbnail,
                content_updated: true,
            }, null, 2));
        }

        // title 만 변경.
        await db.prepare(
            'UPDATE blog_posts SET title = ?, updated_at = unixepoch() WHERE id = ?'
        ).bind(newTitle, id).run();
        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('blog_update', ui("m_c0149a7404a737ca", [newTitle]), user.id)
                .run().catch((e: any) => console.error('admin-mcp blog_update admin_log write failed:', e))
        );
        return asTextResult(JSON.stringify({
            id, title: newTitle, content_updated: false,
        }, null, 2));
    }

    if (toolName === 'delete_blog_post') {
        const id = Number(args.id);
        if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
            return asTextResult(ui("m_6dcf73d828a63cfe"), true);
        }
        const existing = await db
            .prepare('SELECT id, title, deleted_at FROM blog_posts WHERE id = ?')
            .bind(id)
            .first<{ id: number; title: string; deleted_at: number | null }>();
        if (!existing) return asTextResult(ui("m_2387e771a93389a0"), true);
        if (existing.deleted_at) return asTextResult(ui("m_a92db503150b6878"), true);

        await db.prepare('UPDATE blog_posts SET deleted_at = unixepoch() WHERE id = ?').bind(id).run();

        // 역링크 정리 — routes/blog.ts 의 DELETE /api/blog/:id 와 동일 (blog=1 로 legacy 호환).
        c.executionCtx.waitUntil(
            db.prepare('DELETE FROM page_links WHERE source_page_id = ? AND blog = 1')
                .bind(id).run()
                .catch((e: any) => console.error('admin-mcp blog page_links cleanup failed:', e))
        );

        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('blog_delete', ui("m_f0f10112368b9417", [existing.title]), user.id)
                .run().catch((e: any) => console.error('admin-mcp blog_delete admin_log write failed:', e))
        );

        // 공지로 발행되어 있던 포스트가 삭제되면 해당 공지도 자동 제거. routes/blog.ts 와 동일.
        c.executionCtx.waitUntil(
            removeAnnouncementByPostId(db, id)
                .catch((e: any) => console.error('admin-mcp blog announcement clear failed:', e))
        );

        return asTextResult(JSON.stringify({ id, title: existing.title, deleted: true }, null, 2));
    }

    if (toolName === 'restore_blog_post') {
        const id = Number(args.id);
        if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
            return asTextResult(ui("m_6dcf73d828a63cfe"), true);
        }
        const existing = await db
            .prepare('SELECT id, title, content, deleted_at FROM blog_posts WHERE id = ?')
            .bind(id)
            .first<{ id: number; title: string; content: string; deleted_at: number | null }>();
        if (!existing) return asTextResult(ui("m_2387e771a93389a0"), true);
        if (!existing.deleted_at) return asTextResult(ui("m_a27088cdebc322b3"), true);

        await db.prepare('UPDATE blog_posts SET deleted_at = NULL, updated_at = unixepoch() WHERE id = ?').bind(id).run();

        // delete_blog_post 가 page_links 를 비웠으므로 본문 기준으로 다시 채워둔다.
        c.executionCtx.waitUntil(rebuildBlogImageLinks(db, id, existing.content || ''));

        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('blog_restore', ui("m_43d079b80e1d56b8", [existing.title]), user.id)
                .run().catch((e: any) => console.error('admin-mcp blog_restore admin_log write failed:', e))
        );

        return asTextResult(JSON.stringify({ id, title: existing.title, restored: true }, null, 2));
    }

    if (toolName === 'set_page_status') {
        if (!rbac.can(user.role, 'wiki:manage')) return asTextResult(ui('permissions.denied'), true);
        const slug = String(args.title || '').trim();
        if (!slug) return asTextResult(ui("m_8ab6728713ad8858"), true);

        if (typeof args.category !== 'string') {
            return asTextResult(ui("m_f16fe8e4ae090a74"), true);
        }

        // 이미지 네임스페이스는 별도 미디어 문서이므로 admin-mcp 메타 변경에서도 제외한다.
        if (slug.startsWith('이미지:')) {
            return asTextResult(ui("m_f0c82c07ff59de9e"), true);
        }
        // map 네임스페이스는 가상 트리 뷰 전용이므로 메타 변경 대상이 아니다.
        if (slug.startsWith('map:')) {
            return asTextResult(ui("m_42d48256ecd34d50"), true);
        }

        const trimmedCategory = (args.category as string).trim();
        const newCategory = trimmedCategory ? trimmedCategory : null;
        if (newCategory && !/^[\p{Script=Han}가-힣a-zA-Z0-9\s,]+$/u.test(newCategory)) {
            return asTextResult(ui("m_ecc6b4ed43d3fa11"), true);
        }

        const page = await db
            .prepare('SELECT id, category, edit_acl FROM pages WHERE slug = ? AND deleted_at IS NULL')
            .bind(slug)
            .first<{ id: number; category: string | null; edit_acl: string | null }>();
        if (!page) return asTextResult(ui("m_d023ab691dff7bd9"), true);

        // admin_only ACL 문서의 메타데이터 변경은 관리자만 가능 (구 wiki:lock 검사 대체).
        if (!rbac.can(user.role, 'admin:access')) {
            const aclSet = parseEditAcl(page.edit_acl);
            if (aclSet && aclSet.flags.includes('admin_only')) {
                return asTextResult(ui("m_78742118a5af3c36"), true);
            }
        }

        // 관리자 전용 카테고리 검증 — 웹 PUT /w/:slug 와 동일하게 비관리자의 admin_only 카테고리 적용 차단.
        {
            const catErr = await enforceAdminOnlyCategories(db, rbac, user, newCategory);
            if (catErr) return asTextResult('Error: ' + catErr, true);
        }

        const finalCategory = newCategory;
        const categoryChanged = (finalCategory ?? null) !== (page.category ?? null);

        if (!categoryChanged) {
            return asTextResult(JSON.stringify({ slug, changed: false, note: ui("m_83c94bc5f7b7e6de"), category: finalCategory }, null, 2));
        }

        // pages.category 와 page_categories 인덱스를 한 batch 로 묶어 트랜잭션으로 적용한다.
        // 분리해서 쓰면 두 번째 쓰기가 실패할 때 메타데이터와 카테고리 인덱스가 불일치하게 된다.
        // 본문은 손대지 않으므로 page_links 는 재구성하지 않는다 (링크 추출은 본문에서만 이루어짐).
        const txStmts: D1PreparedStatement[] = [
            db.prepare('UPDATE pages SET category = ?, updated_at = unixepoch() WHERE id = ?').bind(finalCategory, page.id),
            db.prepare('DELETE FROM page_categories WHERE page_id = ?').bind(page.id),
        ];
        if (finalCategory) {
            const cats = finalCategory.split(',').map(s => s.trim()).filter(Boolean);
            for (const cat of cats) {
                txStmts.push(
                    db.prepare('INSERT OR IGNORE INTO page_categories (page_id, category) VALUES (?, ?)')
                        .bind(page.id, cat)
                );
            }
        }
        await db.batch(txStmts);

        const changeDesc = `category: ${page.category ?? ui("m_2c5539adbf825ee1")} → ${finalCategory ?? ui("m_2c5539adbf825ee1")}`;

        c.executionCtx.waitUntil(
            db.prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('page_status', ui("m_d1d6083885279cd5", [slug, changeDesc]), user.id)
                .run().catch((e: any) => console.error('admin-mcp set_page_status admin_log write failed:', e))
        );

        c.executionCtx.waitUntil(Promise.allSettled([
            invalidatePageCache(c, slug),
            refreshRecentChangesCache(c),
            invalidateBacklinkCaches(c, slug, db),
        ]));

        return asTextResult(JSON.stringify({ slug, changed: true, changes: [changeDesc], category: finalCategory }, null, 2));
    }

    return null;
}

// 일반 유저(`wiki:edit`) 에게 추가로 노출되는 도구 묶음 (읽기 + draft 편집 + revert).
export const USER_TOOL_DEFS: McpToolDef[] = [
    ...USER_READ_TOOL_DEFS,
    ...USER_EDIT_TOOL_DEFS,
];

// 관리자(`admin:access`) 에게만 추가 노출되는 도구 묶음.
export const ADMIN_ONLY_TOOL_DEFS: McpToolDef[] = [
    ...ADMIN_ONLY_READ_TOOL_DEFS,
    ...ADMIN_ONLY_EDIT_TOOL_DEFS,
];

// /api/mcp 의 information 도구가 일반 유저(`wiki:edit`) 에게 추가로 덧붙여 보여줄 가이드.
// 관리자에게도 동일하게 노출된다.
// enabledNames 가 주어지면 Off 처리된 도구는 목록에서 제외한다 — 핸드셰이크에서
// 아예 없는 것처럼 취급하기 위함. 해당 계층의 도구가 하나도 남지 않으면 빈 문자열.
export function buildUserEditInformationSuffix(userName: string, enabledNames?: Set<string>): string {
    const visibleRead = enabledNames
        ? USER_READ_TOOL_DEFS.filter(t => enabledNames.has(t.name))
        : USER_READ_TOOL_DEFS;
    const visibleEdit = enabledNames
        ? USER_EDIT_TOOL_DEFS.filter(t => enabledNames.has(t.name))
        : USER_EDIT_TOOL_DEFS;
    if (visibleRead.length === 0 && visibleEdit.length === 0) return '';
    // 비어 있는 하위 섹션은 헤더째 생략한다 — Off된 도구의 이름이 안내문에 남지 않도록.
    const parts: string[] = [];
    if (visibleRead.length > 0) {
        parts.push(ui("m_52ab88f8136b6083", [userName, visibleRead.map(t => `- ${t.name}`).join('\n')]));
    }
    if (visibleEdit.length > 0) {
        // 장문 prose 가 하드코딩으로 언급하는 도구들. 하나라도 Off 면 Off된 이름이
        // 안내문에 잔류하므로, 최소 안내(켜져 있는 도구 목록만)로 대체한다.
        const PROSE_NAMED_TOOLS = [
            'create_or_update_page', 'patch_page', 'edit_section',
            'commit_edit', 'discard_edit', 'read_document',
            'list_drafts', 'read_draft',
        ];
        const fullProse = !enabledNames || PROSE_NAMED_TOOLS.every(n => enabledNames.has(n));
        if (!fullProse) {
            parts.push(ui("m_52daaee07eb4aa72") +
                visibleEdit.map(t => `- ${t.name}`).join('\n') +
                ui("m_a995ff0df25d25e8"));
        } else {
        // revert_page 가 Off 면 즉시 적용 안내 문장도 함께 생략한다.
        const instantApplyNote = visibleEdit.some(t => t.name === 'revert_page')
            ? ui("m_eaecb784ae99da46")
            : '';
        parts.push(ui("m_784c7704a3a2f0ae") +
            ui("m_1e1c4a998b7b2f1c") +
            ui("m_da4c2b335f807689") +
            ui("m_dde3f09c6f760e12") +
            ui("m_a1d93a929874828a") +
            ui("m_df9d818634c94050") +
            ui("m_924ee1d025cc7457") +
            ui("m_edb211a446241a10") +
            ui("m_2364117719f3a8b3") +
            ui("m_6bd1943582da2fb4") +
            ui("m_3018916d76962e2b") +
            instantApplyNote +
            visibleEdit.map(t => `- ${t.name}`).join('\n') +
            ui("m_a995ff0df25d25e8"));
        }
    }
    return parts.join('');
}

// /api/mcp 의 information 도구가 관리자에게만 추가로 덧붙여 보여줄 가이드.
// enabledNames 가 주어지면 Off 처리된 도구는 목록에서 제외한다. 남는 도구가 없으면 빈 문자열.
export function buildAdminOnlyInformationSuffix(userName: string, enabledNames?: Set<string>): string {
    const visibleRead = enabledNames
        ? ADMIN_ONLY_READ_TOOL_DEFS.filter(t => enabledNames.has(t.name))
        : ADMIN_ONLY_READ_TOOL_DEFS;
    const visibleEdit = enabledNames
        ? ADMIN_ONLY_EDIT_TOOL_DEFS.filter(t => enabledNames.has(t.name))
        : ADMIN_ONLY_EDIT_TOOL_DEFS;
    if (visibleRead.length === 0 && visibleEdit.length === 0) return '';
    // 비어 있는 하위 섹션은 헤더째 생략한다.
    const parts: string[] = [];
    if (visibleRead.length > 0) {
        parts.push(ui("m_6bb8551b26be9ae0", [userName, visibleRead.map(t => `- ${t.name}`).join('\n')]));
    }
    if (visibleEdit.length > 0) {
        parts.push(ui("m_7434f1ab7d74a574") +
            visibleEdit.map(t => `- ${t.name}`).join('\n'));
    }
    return parts.join('');
}
