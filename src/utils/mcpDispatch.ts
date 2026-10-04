// MCP 도구 정의 + 디스패처 공용 모듈.
//
// 통합 MCP 엔드포인트(/api/mcp) 가 인증된 사용자(일반/관리자) 모두에게 노출하는 읽기
// 도구를 정의한다. 도구 디스패치는 JSON-RPC 외피(jsonrpc/id) 를 포함하지 않고
// result content 만 반환한다 — 호출자가 envelope 을 씌운다.
//
// 일반 사용자 노출 도구는 MCP_TOOL_DEFS_ALL 에 정의하고, 관리자 전용 도구는
// src/routes/admin-mcp.ts 에서 ADMIN_TOOL_DEFS 로 별도 정의되어 호출 시점에 합류된다.
import { ui } from '../i18n/server';
import type { Context } from 'hono';
import type { Env } from '../types';
import { renderForAI, extractTOC, extractSection, findSectionsForQuery, expandTemplates } from './aiParser';
import { normalizeSlug, isR2OnlyNamespace, isMcpReadableSlug, subtreeSlugRange } from './slug';
import { sqlContains, sqlStartsWith } from './sqlText';
import { getEnabledExtensions } from './extensions';
import { getRevisionContent } from './r2';
import { isRagSearchEnabled, ragSearchBody } from './rag';
import type { RBAC } from './role';

// ────────────────────────────────────────────────────────────────
// 공용 헬퍼
// ────────────────────────────────────────────────────────────────

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_CODES = (() => {
    const codes = new Uint8Array(64);
    for (let i = 0; i < 64; i++) codes[i] = BASE64_ALPHABET.charCodeAt(i);
    return codes;
})();
const BASE64_PAD = 0x3d;

export function bytesToBase64(bytes: Uint8Array): string {
    const len = bytes.length;
    const fullTriples = (len / 3) | 0;
    const remainder = len - fullTriples * 3;
    const outLen = fullTriples * 4 + (remainder ? 4 : 0);
    const out = new Uint8Array(outLen);

    let inIdx = 0;
    let outIdx = 0;
    for (let i = 0; i < fullTriples; i++) {
        const b0 = bytes[inIdx++];
        const b1 = bytes[inIdx++];
        const b2 = bytes[inIdx++];
        out[outIdx++] = BASE64_CODES[b0 >> 2];
        out[outIdx++] = BASE64_CODES[((b0 & 0x03) << 4) | (b1 >> 4)];
        out[outIdx++] = BASE64_CODES[((b1 & 0x0f) << 2) | (b2 >> 6)];
        out[outIdx++] = BASE64_CODES[b2 & 0x3f];
    }
    if (remainder === 1) {
        const b0 = bytes[inIdx];
        out[outIdx++] = BASE64_CODES[b0 >> 2];
        out[outIdx++] = BASE64_CODES[(b0 & 0x03) << 4];
        out[outIdx++] = BASE64_PAD;
        out[outIdx++] = BASE64_PAD;
    } else if (remainder === 2) {
        const b0 = bytes[inIdx];
        const b1 = bytes[inIdx + 1];
        out[outIdx++] = BASE64_CODES[b0 >> 2];
        out[outIdx++] = BASE64_CODES[((b0 & 0x03) << 4) | (b1 >> 4)];
        out[outIdx++] = BASE64_CODES[(b1 & 0x0f) << 2];
        out[outIdx++] = BASE64_PAD;
    }
    return new TextDecoder().decode(out);
}

export function formatRelativeTime(unixSec: number | null | undefined, nowSec: number): string {
    if (unixSec === null || unixSec === undefined || !Number.isFinite(unixSec)) return '';
    const diff = Math.max(0, Math.floor(nowSec - unixSec));
    if (diff < 60) return ui("m_2fd9e7d411752b46");
    if (diff < 3600) return ui("m_f467a4024cb27ee2", [Math.floor(diff / 60)]);
    if (diff < 86400) {
        const hours = Math.floor(diff / 3600);
        const minutes = Math.floor((diff % 3600) / 60);
        return minutes > 0 ? ui("m_3a303b18f9b646c2", [hours, minutes]) : ui("m_b101f92f6c467d74", [hours]);
    }
    const days = Math.floor(diff / 86400);
    if (days < 30) return ui("m_e1655b60987cbfd4", [days]);
    if (days < 365) return ui("m_783d60738fd55f9d", [Math.floor(days / 30)]);
    return ui("m_fd305f0b56565a13", [Math.floor(days / 365)]);
}

// ────────────────────────────────────────────────────────────────
// 도구 정의
// ────────────────────────────────────────────────────────────────

export interface McpToolDef {
    name: string;
    description: string;
    inputSchema: any;
}

export const MCP_TOOL_DEFS_ALL: McpToolDef[] = [
    {
        name: 'search_title',
        description: ui("m_7466ca263ca1b8e0"),
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: ui("m_bda397fc5b2a3711") } }, required: ['query'] }
    },
    {
        name: 'search_fts',
        description: ui("m_5360cddf64b641a4"),
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: ui("m_bda397fc5b2a3711") } }, required: ['query'] }
    },
    {
        name: 'search_rag',
        description: ui("m_d8628e79d9242ca8"),
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: ui("m_117bcb3a4635e6ec") }, max: { type: 'number', description: ui("m_6268e49bf3392fd2") } }, required: ['query'] }
    },
    {
        name: 'get_toc',
        description: ui("m_6f58d16cf7366f57"),
        inputSchema: { type: 'object', properties: { title: { type: 'string', description: ui("m_e01a35a4bdb5e329") }, raw: { type: 'boolean', description: ui("m_2a34a83055a956d0") } }, required: ['title'] }
    },
    {
        name: 'read_document',
        description: ui("m_f48db6e7d1b019e2"),
        inputSchema: { type: 'object', properties: { title: { type: 'string', description: ui("m_e01a35a4bdb5e329") }, raw: { type: 'boolean' } }, required: ['title'] }
    },
    {
        name: 'read_section',
        description: ui("m_dfc10bcd0c19ab35"),
        inputSchema: { type: 'object', properties: { title: { type: 'string', description: ui("m_e01a35a4bdb5e329") }, section_number: { type: 'string', description: ui("m_ee5600524374a4b0") }, raw: { type: 'boolean', description: ui("m_519be1bbef197558") } }, required: ['title', 'section_number'] }
    },
    {
        name: 'get_tree',
        description: ui("m_7d3cb0c9eecf0798"),
        inputSchema: { type: 'object', properties: { title: { type: 'string', description: ui("m_5455a9d896a17ebe") } }, required: ['title'] }
    },
    {
        name: 'read_document_batch',
        description: ui("m_1f0e3b8c7cb34e46"),
        inputSchema: {
            type: 'object',
            properties: {
                titles: { type: 'array', items: { type: 'string' }, description: ui("m_be6ca15da180391b") },
                parent_title: { type: 'string', description: ui("m_7b1b4061a9d93728") },
                page: { type: 'number', description: ui("m_f5d76cd0078d3708") },
                raw: { type: 'boolean' }
            },
            required: []
        }
    },
    {
        name: 'get_map',
        description: ui("m_a03e8ae307459459"),
        inputSchema: {
            type: 'object',
            properties: {
                titles: { type: 'array', items: { type: 'string' }, description: ui("m_be6ca15da180391b") },
                parent_title: { type: 'string', description: ui("m_7e31d414de4babd4") },
                page: { type: 'number', description: ui("m_f5d76cd0078d3708") }
            },
            required: []
        }
    },
    {
        name: 'search_category',
        description: ui("m_a2bfebb02edf8fad"),
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: ui("m_4c4a27420a7aacaf") } }, required: ['query'] }
    },
    {
        name: 'get_category_info',
        description: ui("m_be7ce819a1d2eec9"),
        inputSchema: { type: 'object', properties: { category: { type: 'string', description: ui("m_2a0a4a92c35e6110") }, raw: { type: 'boolean' } }, required: ['category'] }
    },
    {
        name: 'get_document_category',
        description: ui("m_909a66569c8d31a8"),
        inputSchema: { type: 'object', properties: { title: { type: 'string', description: ui("m_b9aa91f27eb4194c") } }, required: ['title'] }
    },
    {
        // Deprecated alias kept for backward compatibility (rename of get_document_categoty).
        // Will be removed in a future major version. Use get_document_category instead.
        name: 'get_document_categoty',
        description: ui("m_7324061da6dacbb7"),
        inputSchema: { type: 'object', properties: { title: { type: 'string', description: ui("m_b9aa91f27eb4194c") } }, required: ['title'] }
    },
    {
        name: 'get_backlinks',
        description: ui("m_ad994dbc23c4c990"),
        inputSchema: { type: 'object', properties: { title: { type: 'string', description: ui("m_639d520572cd50f7") } }, required: ['title'] }
    },
    {
        name: 'get_recent_changes',
        description: ui("m_baa7da4dc29d1bde"),
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: ui("m_2c2360ccdb1288bf") },
                since: { type: 'string', description: ui("m_1c5ac590ca42742f") },
                author: { type: 'string', description: ui("m_9d55cf684346d177") },
                category: { type: 'string', description: ui("m_526e538baffd5c3a") },
                namespace: { type: 'string', description: ui("m_73d79401118b9f44") }
            },
            required: []
        }
    },
    {
        name: 'list_discussions',
        description: ui("m_d9ffd0b16262fc2b"),
        inputSchema: { type: 'object', properties: { title: { type: 'string', description: ui("m_e01a35a4bdb5e329") } }, required: ['title'] }
    },
    {
        name: 'read_discussion',
        description: ui("m_b33174b918700b9b"),
        inputSchema: { type: 'object', properties: { discussion_id: { type: 'number', description: ui("m_cbffdc5c8d59c830") } }, required: ['discussion_id'] }
    },
    {
        name: 'view_image',
        description: ui("m_757d8d1e4210db88"),
        inputSchema: { type: 'object', properties: { filename: { type: 'string', description: ui("m_aa2b1fba52dee466") } }, required: ['filename'] }
    },
    {
        name: 'list_blog_posts',
        description: ui("m_f8ac6d1e08a80948"),
        inputSchema: {
            type: 'object',
            properties: {
                page: { type: 'number', description: ui("m_03e894d94ff38499") }
            },
            required: []
        }
    },
    {
        name: 'read_blog_post',
        description: ui("m_e6dc125b6303f6e8"),
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number', description: ui("m_f89f48c07ea32b06") },
                raw: { type: 'boolean' }
            },
            required: ['id']
        }
    },
    {
        name: 'get_blog_toc',
        description: ui("m_906675307ca26a8a"),
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number', description: ui("m_f89f48c07ea32b06") }
            },
            required: ['id']
        }
    },
    {
        name: 'read_blog_section',
        description: ui("m_0ea92e2a21f5d480"),
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'number', description: ui("m_f89f48c07ea32b06") },
                section_number: { type: 'string', description: ui("m_8ffbe10218de0ebf") },
                raw: { type: 'boolean' }
            },
            required: ['id', 'section_number']
        }
    }
];

// 환경에 따라 노출할 공용(read) 도구 목록을 반환한다. RAG 검색이 비활성이면 search_rag 를 숨긴다.
export function getSharedToolDefs(env: Env['Bindings']): McpToolDef[] {
    return isRagSearchEnabled(env)
        ? MCP_TOOL_DEFS_ALL
        : MCP_TOOL_DEFS_ALL.filter((t) => t.name !== 'search_rag');
}

export function buildInformationIntro(c: Context<Env>, toolDefs: McpToolDef[] = MCP_TOOL_DEFS_ALL): string {
    const wikiName = c.env.WIKI_NAME;
    const syntaxNote = c.env.WIKI_SYNTAX ? ui("m_0169b14d9e0774bd", [c.env.WIKI_SYNTAX]) : '';
    // 블로그 안내문은 전달된 정의에 실제 포함된 이름만으로 동적 구성한다 — Off된 이름이
    // 잔류하거나, 가시 블로그 도구가 있는데 안내가 통째로 사라지지 않도록.
    const BLOG_TOOL_NAMES = ['list_blog_posts', 'read_blog_post', 'get_blog_toc', 'read_blog_section'];
    const visibleBlogTools = BLOG_TOOL_NAMES.filter(n => toolDefs.some(t => t.name === n));
    const blogNote = visibleBlogTools.length > 0
        ? ui("m_516b6531ac86d0c6", [visibleBlogTools.join(' / ')])
        : '';
    return ui("m_c73abcd53e225fb1", [wikiName, syntaxNote, blogNote]);
}

// ────────────────────────────────────────────────────────────────
// 디스패처
// ────────────────────────────────────────────────────────────────

export type ToolResult = { content: any[]; isError?: boolean };

export async function dispatchReadTool(
    c: Context<Env>,
    toolName: string,
    args: any,
    toolDefs: McpToolDef[] = MCP_TOOL_DEFS_ALL
): Promise<ToolResult | null> {
    const db = c.env.DB;
    const rbac = c.get('rbac') as RBAC | undefined;
    const user = c.get('user') as { role: string } | undefined;
    const role = user ? user.role : 'guest';
    const canSeePrivate = rbac ? rbac.can(role, 'wiki:private') : false;
    const privateFilter = canSeePrivate ? '' : ' AND is_private = 0';
    const pPrivateFilter = canSeePrivate ? '' : ' AND p.is_private = 0';

    if (toolName === 'information') {
        const intro = buildInformationIntro(c, toolDefs);
        const toolDetails = toolDefs.map(t => `## ${t.name}\n${t.description}`).join('\n\n');
        const text = ui("m_8c306ae2749ce518", [intro, toolDetails]);
        return { content: [{ type: 'text', text }] };
    }

    if (toolName === 'search_title') {
        // slug 와 대체 title 양쪽에서 부분 매칭. title 은 표시용이라 모든 호출 도구의 인자(title 파라미터) 는 slug 를 받지만,
        // 디스커버리 단계에서는 사용자가 기억하는 표시 이름(특수문자 포함) 으로도 검색이 가능해야 하므로 함께 매칭한다.
        // LIKE 대신 instr() — 긴 질의에서 D1 의 50바이트 패턴 한도에 걸리지 않는다 (sqlContains 주석).
        const results = await db.prepare(
            `SELECT slug, title, rows, characters FROM pages
             WHERE (${sqlContains('slug')} OR ${sqlContains('title')}) AND deleted_at IS NULL${privateFilter} LIMIT 15`,
        ).bind(String(args.query ?? ''), String(args.query ?? '')).all();
        return { content: [{ type: 'text', text: JSON.stringify(results.results, null, 2) }] };
    }

    if (toolName === 'search_fts') {
        const rawQuery = String(args.query || '').trim();
        if (!rawQuery) return { content: [{ type: 'text', text: '[]' }] };

        type FtsRow = { slug: string; content: string; last_revision_id: number | null; rows: number | null; characters: number | null };
        // 트라이그램 미스(<3자) 와 FTS5 파싱 오류 양쪽에서 쓰는 공용 폴백.
        // LIKE 대신 instr() — 긴 질의에서 D1 의 50바이트 패턴 한도에 걸리지 않고, 질의에 포함된
        // 와일드카드가 해석되지도 않는다 (sqlContains 주석 참고).
        const runFallback = async (): Promise<FtsRow[]> => {
            const fbSql = `SELECT p.slug, p.content, p.last_revision_id, p.rows, p.characters FROM pages p WHERE (${sqlContains('p.slug')} OR ${sqlContains('p.content')}) AND p.deleted_at IS NULL${pPrivateFilter} ORDER BY (CASE WHEN ${sqlContains('p.slug')} THEN 0 ELSE 1 END), p.updated_at DESC LIMIT 10`;
            const fbRes = await db.prepare(fbSql).bind(rawQuery, rawQuery, rawQuery).all<FtsRow>();
            return fbRes.results;
        };

        let rows: FtsRow[] = [];
        if ([...rawQuery].length < 3) {
            rows = await runFallback();
        } else {
            const safeMatchQuery = '"' + rawQuery.replace(/"/g, '""') + '"';
            try {
                const ftsSql = `SELECT slug, content, last_revision_id, rows, characters
                                FROM pages
                                WHERE id IN (SELECT rowid FROM pages_fts WHERE pages_fts MATCH ?)
                                  AND deleted_at IS NULL${privateFilter}
                                LIMIT 10`;
                const ftsRes = await db.prepare(ftsSql).bind(safeMatchQuery).all<FtsRow>();
                rows = ftsRes.results;
            } catch (ftsErr: any) {
                const msg = String(ftsErr?.message || '');
                if (!/fts5.*(syntax|parse)/i.test(msg)) throw ftsErr;
                rows = await runFallback();
            }
        }

        const origin = new URL(c.req.url).origin;
        const enabledExt = getEnabledExtensions(c.env);
        const output = await Promise.all(rows.map(async (row) => {
            let actualContent = row.content;
            if (isR2OnlyNamespace(row.slug, enabledExt) && (!actualContent || actualContent === '')) {
                if (row.last_revision_id) {
                    const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(row.last_revision_id).first<{ content: string, r2_key: string | null }>();
                    if (lastRev) actualContent = await getRevisionContent(c.env.MEDIA, lastRev, origin);
                }
            }
            return {
                title: row.slug,
                rows: row.rows,
                characters: row.characters,
                sections: findSectionsForQuery(actualContent, rawQuery),
            };
        }));
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    }

    if (toolName === 'search_rag') {
        if (!isRagSearchEnabled(c.env)) {
            return { content: [{ type: 'text', text: ui("m_7fa8a1e0dbc5c616") }], isError: true };
        }
        const rawQuery = String(args.query || '').trim();
        if (!rawQuery) return { content: [{ type: 'text', text: '[]' }] };
        const maxN = Math.min(50, Math.max(1, Number(args.max) || 30));

        let hits;
        try {
            // 비공개/삭제 사후 필터로 줄어들 분을 보전하기 위해 상한(50)까지 과다 조회.
            hits = await ragSearchBody(c.env, rawQuery, 50);
        } catch (e: any) {
            return { content: [{ type: 'text', text: ui("m_6609e2b894160aca") + String(e?.message || e) }], isError: true };
        }
        if (hits.length === 0) return { content: [{ type: 'text', text: '[]' }] };

        // ACL 무관 전 문서가 인덱싱돼 있으므로, D1 로 다시 조회하며 가시성(privateFilter)+삭제 사후 필터.
        const placeholders = hits.map(() => '?').join(',');
        const rows = await db.prepare(
            `SELECT slug, title, rows, characters FROM pages WHERE slug IN (${placeholders}) AND deleted_at IS NULL${privateFilter}`,
        ).bind(...hits.map((h) => h.slug)).all<{ slug: string; title: string | null; rows: number | null; characters: number | null }>();
        const valid = new Map(rows.results.map((r) => [r.slug, r]));

        const output: unknown[] = [];
        for (const h of hits) {
            const r = valid.get(h.slug);
            if (!r) continue; // 비공개/삭제/비존재 → 제거
            output.push({ slug: r.slug, title: r.title, score: h.score, rows: r.rows, characters: r.characters, snippet: h.snippet });
            if (output.length >= maxN) break;
        }
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    }

    if (toolName === 'get_toc' || toolName === 'read_document' || toolName === 'read_section') {
        const slug = normalizeSlug(args.title || '');
        if (!isMcpReadableSlug(slug)) {
            return { content: [{ type: 'text', text: ui("m_1ed6ec4afa33ec94") }], isError: true };
        }
        const page = await db.prepare(`SELECT slug, content, last_revision_id FROM pages WHERE slug = ? AND deleted_at IS NULL${privateFilter}`).bind(slug).first<{ slug: string, content: string, last_revision_id: number | null }>();
        if (!page) return { content: [{ type: 'text', text: ui("m_3c8aaba9778dff5f") }], isError: true };

        let actualContent = page.content;
        const origin = new URL(c.req.url).origin;
        const enabledExt = getEnabledExtensions(c.env);
        if (isR2OnlyNamespace(page.slug, enabledExt) && (!actualContent || actualContent === '')) {
            if (page.last_revision_id) {
                const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(page.last_revision_id).first<{ content: string, r2_key: string | null }>();
                if (lastRev) actualContent = await getRevisionContent(c.env.MEDIA, lastRev, origin);
            }
        }

        if (toolName === 'get_toc') {
            // raw=true: 트랜스클루전을 펼치지 않은 원본 기준 — edit_section 의 번호와 일치.
            const sourceForToc = args.raw === true
                ? actualContent
                : await expandTemplates(actualContent, db, 0, slug);
            const tocText = (extractTOC(sourceForToc) || '')
                .split('\n')
                .map(line => line.replace(/\{[^}]*\}/g, '').replace(/[ \t]+/g, ' ').trimEnd())
                .join('\n');
            return { content: [{ type: 'text', text: tocText || ui("m_9cf50c843d60bb0c") }] };
        }
        if (toolName === 'read_document') {
            const text = args.raw === true ? actualContent : await renderForAI(actualContent, db, 0, slug);
            return { content: [{ type: 'text', text: text || ui("m_77453d7811852f91") }] };
        }
        // read_section
        // raw=true: 트랜스클루전을 펼치지 않은 원본 기준의 섹션 번호를 사용해 추출. get_toc(raw=true)
        // 및 edit_section 의 번호 체계와 일치한다. 템플릿이 헤딩을 추가하는 페이지에서 raw=false 와
        // 같은 번호로 다른 섹션을 가리키지 않도록 한다.
        // raw=false: 기존 동작 — 트랜스클루전을 펼친 뒤 추출, AI 용 렌더링까지 적용.
        const sourceForSection = args.raw === true
            ? actualContent
            : await expandTemplates(actualContent, db, 0, slug);
        const sectionContent = extractSection(sourceForSection, args.section_number || '');
        const text = args.raw === true ? sectionContent : await renderForAI(sectionContent, db, 0, slug);
        return { content: [{ type: 'text', text: text || ui("m_8fb588328fcea157") }] };
    }

    if (toolName === 'get_tree') {
        const rootSlug = normalizeSlug(args.title || '');
        if (!rootSlug) {
            return { content: [{ type: 'text', text: ui("m_6d994f307ce24bc5") }], isError: true };
        }
        // LIKE 대신 prefix 범위 비교 — 근거는 subtreeSlugRange 주석 참고.
        // rootSlug 는 위에서 비어 있지 않음이 보장되므로 range 는 항상 non-null.
        const { lower: prefixLower, upper: prefixUpper } = subtreeSlugRange(rootSlug)!;

        const [subdocs, rootPage] = await Promise.all([
            db.prepare(`SELECT slug, rows, characters FROM pages WHERE deleted_at IS NULL${privateFilter} AND slug > ? AND slug < ? ORDER BY slug ASC LIMIT 200`).bind(prefixLower, prefixUpper).all<{ slug: string; rows: number | null; characters: number | null }>(),
            db.prepare(`SELECT slug, rows, characters FROM pages WHERE slug = ? AND deleted_at IS NULL${privateFilter}`).bind(rootSlug).first<{ slug: string; rows: number | null; characters: number | null }>()
        ]);

        const formatStats = (r: number | null, ch: number | null) => ui("m_1565658bee898960", [r ?? 0, ch ?? 0]);

        if (subdocs.results.length === 0) {
            const rootMarker = rootPage ? formatStats(rootPage.rows, rootPage.characters) : ui("m_5f16df86699bf330");
            return { content: [{ type: 'text', text: ui("m_c024e5d390be2e9d", [rootSlug, rootMarker]) }] };
        }

        const tree: any = {};
        for (const doc of subdocs.results) {
            const relative = doc.slug.substring(rootSlug.length + 1);
            const parts = relative.split('/');
            let node = tree;
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                if (!node[part]) node[part] = { _children: {}, _exists: false, _rows: null, _characters: null };
                if (i === parts.length - 1) {
                    node[part]._exists = true;
                    node[part]._rows = doc.rows;
                    node[part]._characters = doc.characters;
                }
                node = node[part]._children;
            }
        }

        const missingDocs: string[] = [];
        if (!rootPage) missingDocs.push(rootSlug);

        function annotateDescendants(children: any): number {
            let total = 0;
            for (const key of Object.keys(children)) {
                const sub = annotateDescendants(children[key]._children);
                children[key]._descendants = sub;
                total += 1 + sub;
            }
            return total;
        }
        annotateDescendants(tree);

        function renderTree(nodes: any, parentPrefix: string, slugPrefix: string): string {
            const entries = Object.keys(nodes).sort((a, b) => {
                const ca = nodes[a]._descendants;
                const cb = nodes[b]._descendants;
                if (ca !== cb) return ca - cb;
                return a.localeCompare(b);
            });
            let text = '';
            entries.forEach((key, idx) => {
                const node = nodes[key];
                const isLast = idx === entries.length - 1;
                const hasChildren = Object.keys(node._children).length > 0;
                const connector = isLast ? '└── ' : '├── ';
                const childPrefix = parentPrefix + (isLast ? '    ' : '│   ');
                const fullSlug = `${slugPrefix}/${key}`;
                const marker = node._exists ? formatStats(node._rows, node._characters) : ui("m_5f16df86699bf330");
                if (!node._exists) missingDocs.push(fullSlug);

                text += `${parentPrefix}${connector}${key}${marker}\n`;
                if (hasChildren) text += renderTree(node._children, childPrefix, fullSlug);
            });
            return text;
        }

        const rootMarker = rootPage ? formatStats(rootPage.rows, rootPage.characters) : ui("m_5f16df86699bf330");
        const treeText = `${rootSlug}${rootMarker}\n` + renderTree(tree, '', rootSlug);
        const missingSection = missingDocs.length > 0
            ? ui("m_73837db939871074", [missingDocs.length, missingDocs.map(s => `- ${s}`).join('\n')])
            : '';
        return { content: [{ type: 'text', text: treeText + missingSection }] };
    }

    if (toolName === 'search_category') {
        const results = await db.prepare(`SELECT DISTINCT category FROM page_categories WHERE ${sqlContains('category')} ORDER BY category ASC LIMIT 15`)
            .bind(String(args.query ?? '')).all<{ category: string }>();
        return { content: [{ type: 'text', text: JSON.stringify(results.results.map(r => r.category), null, 2) }] };
    }

    if (toolName === 'get_category_info') {
        const docs = await db.prepare(`SELECT p.slug, p.rows, p.characters FROM page_categories pc JOIN pages p ON pc.page_id = p.id WHERE pc.category = ? AND p.deleted_at IS NULL${pPrivateFilter} ORDER BY p.slug ASC LIMIT 50`)
            .bind(args.category).all<{ slug: string; rows: number | null; characters: number | null }>();

        const catSlug = normalizeSlug(`카테고리:${args.category}`);
        const catPage = await db.prepare(`SELECT slug, content, last_revision_id FROM pages WHERE slug = ? AND deleted_at IS NULL${privateFilter}`).bind(catSlug).first<{ slug: string, content: string, last_revision_id: number | null }>();

        let renderedCatContent = ui("m_7caa694effdba08e");
        if (catPage) {
            let actualContent = catPage.content;
            const origin = new URL(c.req.url).origin;
            const enabledExt = getEnabledExtensions(c.env);
            if (isR2OnlyNamespace(catPage.slug, enabledExt) && (!actualContent || actualContent === '')) {
                if (catPage.last_revision_id) {
                    const lastRev = await db.prepare('SELECT content, r2_key FROM revisions WHERE id = ?').bind(catPage.last_revision_id).first<{ content: string, r2_key: string | null }>();
                    if (lastRev) actualContent = await getRevisionContent(c.env.MEDIA, lastRev, origin);
                }
            }
            const categoryText = args.raw === true
                ? actualContent
                : await renderForAI(actualContent, db, 0, catSlug);
            renderedCatContent = categoryText || ui("m_77453d7811852f91");
        }

        const output = {
            documents: docs.results.map(r => ({ slug: r.slug, rows: r.rows, characters: r.characters })),
            categoryContent: renderedCatContent
        };
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    }

    if (toolName === 'get_document_category' || toolName === 'get_document_categoty') {
        const slug = normalizeSlug(args.title || '');
        const cats = await db.prepare(`SELECT pc.category FROM page_categories pc JOIN pages p ON pc.page_id = p.id WHERE p.slug = ? AND p.deleted_at IS NULL${pPrivateFilter} ORDER BY pc.category ASC`)
            .bind(slug).all<{ category: string }>();
        return { content: [{ type: 'text', text: JSON.stringify(cats.results.map(r => r.category), null, 2) }] };
    }

    if (toolName === 'get_backlinks') {
        const slug = normalizeSlug(args.title || '');
        const targetSlugs: string[] = [slug];
        const templatePrefixes = ['틀:', 'template:', '템플릿:'];
        for (const prefix of templatePrefixes) {
            if (slug.startsWith(prefix)) {
                targetSlugs.push(slug.substring(prefix.length));
                break;
            }
        }
        const placeholders = targetSlugs.map(() => '?').join(', ');
        const query = `
            SELECT DISTINCT p.slug, p.rows, p.characters, p.updated_at
            FROM page_links pl
            JOIN pages p ON pl.source_page_id = p.id
            WHERE p.slug != ?
              AND pl.blog = 0
              AND pl.source_type = 'page'
              AND pl.link_type IN ('wikilink', 'template', 'extension')
              AND pl.target_slug IN (${placeholders})
              AND p.deleted_at IS NULL${pPrivateFilter}
            ORDER BY p.updated_at DESC LIMIT 100
        `;
        const backlinks = await db.prepare(query).bind(slug, ...targetSlugs).all<{ slug: string; rows: number | null; characters: number | null }>();
        return { content: [{ type: 'text', text: JSON.stringify(backlinks.results.map(r => ({ slug: r.slug, rows: r.rows, characters: r.characters })), null, 2) }] };
    }

    if (toolName === 'get_recent_changes') {
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 10));
        const wheres: string[] = ['p.deleted_at IS NULL'];
        if (!canSeePrivate) wheres.push('p.is_private = 0');
        const binds: any[] = [];

        if (args.since && typeof args.since === 'string') {
            // ISO 8601 date or datetime → unix epoch seconds. 잘못된 입력은 명시적 오류.
            const parsed = Date.parse(args.since);
            if (Number.isNaN(parsed)) {
                return { content: [{ type: 'text', text: ui("m_35456c06c2ad2c05", [args.since]) }], isError: true };
            }
            wheres.push('p.updated_at >= ?');
            binds.push(Math.floor(parsed / 1000));
        }
        if (args.author && typeof args.author === 'string') {
            wheres.push('u.name = ?');
            binds.push(args.author);
        }
        if (args.namespace && typeof args.namespace === 'string') {
            // LIKE 대신 instr() — 와일드카드 해석이 없어 이스케이프가 불필요하고,
            // 긴 네임스페이스에서 D1 의 50바이트 패턴 한도에도 걸리지 않는다 (sqlStartsWith 주석).
            wheres.push(sqlStartsWith('p.slug'));
            binds.push(args.namespace);
        }
        if (args.category && typeof args.category === 'string') {
            wheres.push('p.id IN (SELECT page_id FROM page_categories WHERE category = ?)');
            binds.push(args.category);
        }

        // author_name/summary 및 author 필터(u.name)는 '가장 최근 리비전(가상 포함, created_at 기준)'
        // 기준으로 도출한다 — HTTP /api/w/recent-changes 와 동일. last_revision_id 는 가상 리비전
        // (ACL 변경·이동 등)에서 갱신되지 않아, 그 기준으로는 직전 본문 편집자/요약으로 오귀속되고
        // author 필터도 실제 변경자(예: 관리자)를 놓친다.
        // 단, revision_id 는 읽기 가능한 본문 리비전 핸들로서 p.last_revision_id 를 그대로 노출한다
        // (가상 리비전은 read_revision 등 열람 경로에서 차단되므로 핸들로 부적합).
        const sql = `
            SELECT p.slug, p.updated_at, p.last_revision_id, u.name as author_name, r.summary
            FROM pages p
            LEFT JOIN revisions r ON r.id = (
                SELECT id FROM revisions
                WHERE page_id = p.id AND deleted_at IS NULL AND purged_at IS NULL
                ORDER BY created_at DESC, id DESC LIMIT 1
            )
            LEFT JOIN users u ON r.author_id = u.id
            WHERE ${wheres.join(' AND ')}
            ORDER BY p.updated_at DESC LIMIT ?
        `;
        binds.push(limit);
        const { results } = await db.prepare(sql).bind(...binds).all<{ slug: string; updated_at: number | null; last_revision_id: number | null; author_name: string | null; summary: string | null }>();
        const nowSec = Math.floor(Date.now() / 1000);
        const formatted = results.map(r => ({
            slug: r.slug,
            time_ago: formatRelativeTime(r.updated_at, nowSec),
            author_name: r.author_name,
            summary: r.summary,
            revision_id: r.last_revision_id,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }] };
    }

    if (toolName === 'list_discussions') {
        const slug = normalizeSlug(args.title || '');
        const page = await db.prepare(`SELECT id FROM pages WHERE slug = ? AND deleted_at IS NULL${privateFilter}`).bind(slug).first<{ id: number }>();
        if (!page) return { content: [{ type: 'text', text: ui("m_3c8aaba9778dff5f") }], isError: true };
        const { results } = await db.prepare(`
            SELECT d.id, d.title, d.status, d.created_at, d.updated_at,
                   u.name as author_name,
                   (SELECT COUNT(*) FROM discussion_comments dc WHERE dc.discussion_id = d.id AND dc.deleted_at IS NULL) as comment_count
            FROM discussions d
            LEFT JOIN users u ON d.author_id = u.id
            WHERE d.page_id = ? AND d.deleted_at IS NULL
            ORDER BY d.updated_at DESC LIMIT 50
        `).bind(page.id).all();
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }

    if (toolName === 'read_discussion') {
        const dId = Number(args.discussion_id);
        if (!Number.isFinite(dId)) {
            return { content: [{ type: 'text', text: ui("m_f74b6c1d51b564ad") }], isError: true };
        }
        const discussion = await db.prepare(`
            SELECT d.id, d.title, d.status, d.created_at, d.updated_at,
                   u.name as author_name,
                   p.slug as page_title
            FROM discussions d
            LEFT JOIN users u ON d.author_id = u.id
            JOIN pages p ON d.page_id = p.id
            WHERE d.id = ? AND d.deleted_at IS NULL AND p.deleted_at IS NULL${pPrivateFilter}
        `).bind(dId).first();
        if (!discussion) return { content: [{ type: 'text', text: ui("m_4330b1647ece8efb") }], isError: true };
        const { results: comments } = await db.prepare(`
            SELECT dc.id, dc.content, dc.parent_id, dc.created_at, dc.deleted_at,
                   u.name as author_name
            FROM discussion_comments dc
            LEFT JOIN users u ON dc.author_id = u.id
            WHERE dc.discussion_id = ?
            ORDER BY dc.created_at ASC
        `).bind(dId).all<{ id: number; content: string; parent_id: number | null; created_at: number; deleted_at: number | null; author_name: string | null }>();
        const cleanedComments = comments.map(dc => ({
            id: dc.id,
            author_name: dc.deleted_at ? null : dc.author_name,
            content: dc.deleted_at ? ui("m_76e10614f8d4e406") : dc.content,
            parent_id: dc.parent_id,
            created_at: dc.created_at
        }));
        return { content: [{ type: 'text', text: JSON.stringify({ discussion, comments: cleanedComments }, null, 2) }] };
    }

    if (toolName === 'view_image') {
        const filename = String(args.filename || '').trim();
        if (!filename) {
            return { content: [{ type: 'text', text: ui("m_f9e850c4ce13164f") }], isError: true };
        }

        let row = await db.prepare(
            `SELECT r2_key, filename, mime_type, size FROM media WHERE filename = ? AND mime_type LIKE 'image/%' LIMIT 1`
        ).bind(filename).first<{ r2_key: string; filename: string; mime_type: string; size: number }>();

        if (!row) {
            const matches = await db.prepare(
                `SELECT r2_key, filename, mime_type, size FROM media WHERE ${sqlContains('filename')} AND mime_type LIKE 'image/%' ORDER BY filename ASC LIMIT 10`
            ).bind(filename).all<{ r2_key: string; filename: string; mime_type: string; size: number }>();

            if (matches.results.length === 0) {
                return { content: [{ type: 'text', text: ui("m_7a637fcd3a575c69", [filename]) }], isError: true };
            }
            if (matches.results.length > 1) {
                const list = matches.results.map(r => r.filename).join(', ');
                return { content: [{ type: 'text', text: ui("m_ecdb75297ff61dac", [list]) }], isError: true };
            }
            row = matches.results[0];
        }

        const MAX_IMAGE_RESPONSE_SIZE = 5 * 1024 * 1024;
        if (row.size > MAX_IMAGE_RESPONSE_SIZE) {
            return { content: [{ type: 'text', text: ui("m_f046f1182d1ba03d", [(row.size / 1024 / 1024).toFixed(1)]) }], isError: true };
        }

        const obj = await c.env.MEDIA.get(row.r2_key);
        if (!obj) {
            return { content: [{ type: 'text', text: ui("m_98b7a2103a408bb5") }], isError: true };
        }

        const buffer = await obj.arrayBuffer();
        const base64 = bytesToBase64(new Uint8Array(buffer));
        const mimeType = obj.httpMetadata?.contentType || row.mime_type || 'image/png';

        return { content: [{ type: 'image', data: base64, mimeType }] };
    }

    return null;
}
