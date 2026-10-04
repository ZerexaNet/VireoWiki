// 편집 요청(내부적으로 pending_edits) 생성 Discord 이벤트 빌더 (admin 채널).
// 신뢰되지 않은 사용자의 편집이 편집 요청으로 보류될 때 관리자 채널에 알린다.
// 비공개 문서의 요청은 호출부에서 필터링한다(본문/제목 노출 방지).

import { ui } from '../../../i18n/server';
import type { Env } from '../../../types';
import type { WebhookEvent } from '../discord';
import { absoluteUrl, escapeMd, nowIso, truncate } from '../format';

const COLOR_PENDING = 0x38BDF8;

export function pendingEditCreated(args: {
    slug: string;
    action: 'create' | 'update';
    actor: { name: string; picture?: string | null };
    summary?: string | null;
    env: Env['Bindings'];
}): WebhookEvent {
    const { slug, action, actor, summary, env } = args;
    // 검토는 문서 열람 페이지(편집 버튼 배지/드롭다운)에서 수행한다.
    const reviewUrl = absoluteUrl(env, `/w/${encodeURIComponent(slug)}`);
    const actionLabel = action === 'create' ? ui("m_a197030ed96f7990") : ui("m_9789d0dfbdbe37a3");
    const summaryLine = summary && summary.trim()
        ? `\n\n> ${truncate(escapeMd(summary), 200)}`
        : '';
    const description = reviewUrl
        ? ui("m_b2792dcfacf6f071", [escapeMd(slug), actionLabel, reviewUrl, summaryLine])
        : ui("m_028e9f3e58511e35", [escapeMd(slug), actionLabel, summaryLine]);

    return {
        channel: 'admin',
        type: 'pending_edit',
        embed: {
            color: COLOR_PENDING,
            title: ui("m_c260160bdcbc43b7"),
            description,
            author: {
                name: actor.name,
                icon_url: actor.picture ? absoluteUrl(env, actor.picture) : undefined,
            },
            timestamp: nowIso(),
        },
    };
}
