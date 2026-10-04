import { ui } from '../i18n/server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { RBAC } from '../utils/role';
import { requireAdmin } from '../middleware/session';
import { BULK_MANAGE_MAX } from './admin';

//
// ── AdminJobDO 잡 제출/상태/중지 라우트 (최고 관리자 전용) ──────────────────
//
// 과거 동기 대량 API(`POST /api/admin/bulk-manage/delete`·`move`)를 대체한다. 검증 후
// 싱글턴 AdminJobDO(`src/durable/adminJob.ts`)에 잡을 위임하고, 상태/중지 호출은 DO 로
// 프록시한다. 전역 session/rbac 미들웨어가 user/rbac 를 주입하므로 mount 만으로 가드 가능.
//
// `src/index.ts` 에서 `app.route('/api/admin', adminJobRoutes)` 로 마운트한다.
//

const adminJobRoutes = new Hono<Env>();

// 별도 Hono 인스턴스라 adminRoutes 의 requireAdmin 가드를 상속받지 않는다.
// 1차로 requireAdmin(banned/비관리자 차단) → 각 핸들러에서 super_admin(`*`) 세분화.
adminJobRoutes.use('*', requireAdmin);

// 가드: 최고 관리자(`*`) 전용. (과거 reindex 구현이 `wiki:edit` 로 잘못 가드했던 버그 교정.)
function requireSuperAdmin(c: Context<Env>): Response | null {
    const user = c.get('user');
    const rbac = c.get('rbac') as RBAC | undefined;
    if (!user || !rbac || !rbac.can(user.role, '*')) {
        return c.json({ error: ui("m_1276de4f2ff69f84") }, 403);
    }
    return null;
}

// DO 바인딩이 없으면(=기능 비활성) 503. 있으면 싱글턴 DO 스텁을 반환.
function getDoStub(c: Context<Env>): DurableObjectStub | Response {
    const ns = c.env.ADMIN_JOB_DO;
    if (!ns) {
        return c.json({
            error: ui("m_41a6a0a71ad6255d"),
        }, 503);
    }
    return ns.get(ns.idFromName('global'));
}

// DO 응답을 그대로 클라이언트로 전달(409/503 포함).
function passthrough(res: Response): Response {
    return new Response(res.body, {
        status: res.status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
    });
}

// ids 검증(정수·양수·중복 제거 → BULK_MANAGE_MAX 상한). 잘못된 값은 무시한다.
function normalizeIds(raw: unknown): number[] {
    const ids: number[] = [];
    const seen = new Set<number>();
    if (Array.isArray(raw)) {
        for (const v of raw) {
            const n = typeof v === 'number' ? v : Number(v);
            if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
            seen.add(n);
            ids.push(n);
        }
    }
    return ids;
}

interface JobSubmitBody {
    type?: unknown;
    resume?: unknown;
    ids?: unknown;
    mode?: unknown;
    find?: unknown;
    replace?: unknown;
    update_backlinks?: unknown;
}

/**
 * POST /bulk-manage/jobs
 * 대량 잡(reindex-backlinks / bulk-move / bulk-delete)을 검증 후 AdminJobDO 에 제출한다.
 * resume=true 면 직전 error/idle 상태에서 같은 type 잡을 이어서 재개한다(payload 불요).
 */
adminJobRoutes.post('/bulk-manage/jobs', async (c) => {
    const denied = requireSuperAdmin(c);
    if (denied) return denied;
    const stub = getDoStub(c);
    if (stub instanceof Response) return stub;

    const currentUser = c.get('user')!;
    const body = await c.req.json<JobSubmitBody>().catch(() => ({} as JobSubmitBody));

    const type = body.type;
    if (type !== 'reindex-backlinks' && type !== 'bulk-move' && type !== 'bulk-delete' && type !== 'rag-backfill') {
        return c.json({ error: ui("m_3a0a5279aa52b485") }, 400);
    }
    const resume = body.resume === true;

    // resume 은 페이로드 없이 마지막 커서부터 재개한다(검증 생략).
    let startBody: Record<string, unknown> = { type, resume };

    if (!resume) {
        if (type === 'bulk-delete') {
            const mode = body.mode === 'hard' ? 'hard' : body.mode === 'soft' ? 'soft' : null;
            if (!mode) return c.json({ error: ui("m_de2dcb8236fb280d") }, 400);
            const ids = normalizeIds(body.ids);
            if (ids.length === 0) return c.json({ error: ui("m_154745f0cb57b53e") }, 400);
            if (ids.length > BULK_MANAGE_MAX) {
                return c.json({ error: ui("m_b3caf5b30c7fbe72", [BULK_MANAGE_MAX]) }, 400);
            }
            startBody = {
                type,
                resume: false,
                payload: { ids, mode, actor: { id: currentUser.id, role: currentUser.role } },
            };
        } else if (type === 'bulk-move') {
            const find = typeof body.find === 'string' ? body.find : '';
            const replace = typeof body.replace === 'string' ? body.replace : '';
            if (!find) return c.json({ error: ui("m_e6a33083a9e9c7ac") }, 400);
            if (find === replace) return c.json({ error: ui("m_9ff821ce3db62627") }, 400);
            const updateBacklinks = body.update_backlinks === true;
            const ids = normalizeIds(body.ids);
            if (ids.length === 0) return c.json({ error: ui("m_bd77cc3b242f9d7b") }, 400);
            if (ids.length > BULK_MANAGE_MAX) {
                return c.json({ error: ui("m_b3caf5b30c7fbe72", [BULK_MANAGE_MAX]) }, 400);
            }

            // 제출 시점 id→slug 1회 조회로 items 생성(예약 네임스페이스 제외, slug ASC 정렬).
            // 실제 이동 시점에는 DO 가 id 로 재해석하므로 여기 slug 는 정렬·표시용 스냅샷이다.
            const db = c.env.DB;
            const items: { id: number; slug: string }[] = [];
            const SCAN_CHUNK = 90; // D1 100 bind 제한.
            for (let i = 0; i < ids.length; i += SCAN_CHUNK) {
                const chunkIds = ids.slice(i, i + SCAN_CHUNK);
                const ph = chunkIds.map(() => '?').join(',');
                const { results } = await db
                    .prepare(
                        `SELECT id, slug FROM pages
                          WHERE id IN (${ph})
                            AND slug NOT LIKE '이미지:%'
                            AND slug NOT LIKE 'map:%'`,
                    )
                    .bind(...chunkIds)
                    .all<{ id: number; slug: string }>();
                for (const r of results) items.push({ id: r.id, slug: r.slug });
            }
            if (items.length === 0) return c.json({ error: ui("m_51ddd7ceb38ce1db") }, 400);
            items.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

            startBody = {
                type,
                resume: false,
                payload: {
                    items,
                    find,
                    replace,
                    updateBacklinks,
                    actor: { id: currentUser.id, role: currentUser.role },
                },
            };
        } else if (type === 'rag-backfill') {
            // RAG 백필: 전 문서를 RAG_BUCKET 에 미러링하는 일회성 잡. actor 만 전달(감사용).
            startBody = {
                type,
                resume: false,
                payload: { actor: { id: currentUser.id, role: currentUser.role } },
            };
        } else {
            // reindex-backlinks: 페이로드 없음.
            startBody = { type, resume: false, payload: {} };
        }
    }

    const res = await stub.fetch('https://do/start', {
        method: 'POST',
        body: JSON.stringify(startBody),
    });

    // 시작 성공 시 admin_log 1건(비동기). 409(already_running)/4xx 는 기록하지 않는다.
    if (res.ok) {
        const count = Array.isArray((startBody.payload as { ids?: unknown[]; items?: unknown[] })?.ids)
            ? (startBody.payload as { ids: unknown[] }).ids.length
            : Array.isArray((startBody.payload as { items?: unknown[] })?.items)
            ? (startBody.payload as { items: unknown[] }).items.length
            : 0;
        c.executionCtx.waitUntil(
            c.env.DB
                .prepare('INSERT INTO admin_log (type, log, user) VALUES (?, ?, ?)')
                .bind('bulk_job_start', ui("m_38dafb8bfccdd2b3", [type, count ? ui("m_9f9ae346568f9372", [count]) : '', resume ? ui("m_562eb6e6e08ecf12") : '']), currentUser.id)
                .run()
                .catch((e: unknown) => console.error('admin log failed:', e)),
        );
    }

    return passthrough(res);
});

/**
 * GET /bulk-manage/jobs/status
 * 현재 잡 상태(meta + result 병합 JSON)를 조회한다.
 */
adminJobRoutes.get('/bulk-manage/jobs/status', async (c) => {
    const denied = requireSuperAdmin(c);
    if (denied) return denied;
    const stub = getDoStub(c);
    if (stub instanceof Response) return stub;
    const res = await stub.fetch('https://do/status', { method: 'GET' });
    return passthrough(res);
});

/**
 * POST /bulk-manage/jobs/stop
 * 진행 중 잡을 일시정지(alarm 삭제 + idle)한다. resume 으로 이어서 재개 가능.
 */
adminJobRoutes.post('/bulk-manage/jobs/stop', async (c) => {
    const denied = requireSuperAdmin(c);
    if (denied) return denied;
    const stub = getDoStub(c);
    if (stub instanceof Response) return stub;
    const res = await stub.fetch('https://do/stop', { method: 'POST' });
    return passthrough(res);
});

export default adminJobRoutes;
