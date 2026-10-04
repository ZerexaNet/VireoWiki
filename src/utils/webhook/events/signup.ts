// 가입 신청 / 거부 / 가입 완료(open + approved) Discord 이벤트 빌더.

import { ui } from '../../../i18n/server';
import type { Env } from '../../../types';
import type { WebhookEvent } from '../discord';
import { absoluteUrl, escapeMd, nowIso, truncate } from '../format';

const COLOR_PENDING = 0xFFA500; // 주황 — admin 액션 필요
const COLOR_REJECTED = 0x9B59B6; // 보라 — 감사
const COLOR_JOINED = 0x2ECC71; // 초록 — 환영

export function signupPending(args: {
    requestId: number;
    name: string;
    email: string;
    provider: string;
    env: Env['Bindings'];
}): WebhookEvent {
    const { requestId, name, email, provider, env } = args;
    const adminUrl = absoluteUrl(env, '/admin#signup-requests');
    const description = adminUrl
        ? ui("m_4d07a4b5339c6e9d", [escapeMd(name), adminUrl])
        : ui("m_59802849b7e95cc3", [escapeMd(name)]);

    return {
        channel: 'admin',
        type: 'signup_pending',
        embed: {
            color: COLOR_PENDING,
            title: ui("m_9990d458ebd03b13"),
            description,
            fields: [
                { name: ui("m_3b7dbc4c0c4cebca"), value: `\`${escapeMd(email)}\``, inline: true },
                { name: ui("m_b84abfbe481c6010"), value: escapeMd(provider), inline: true },
            ],
            footer: { text: ui("m_9cd880d519c81b65", [requestId]) },
            timestamp: nowIso(),
        },
    };
}

export function signupRejected(args: {
    name: string;
    email: string;
    actorName: string;
    reason?: string | null;
}): WebhookEvent {
    const { name, email, actorName, reason } = args;
    const fields = reason
        ? [{ name: ui("m_ab9442a23e772cce"), value: truncate(escapeMd(reason), 200) }]
        : undefined;

    return {
        channel: 'admin',
        type: 'signup_rejected',
        embed: {
            color: COLOR_REJECTED,
            title: ui("m_f722391e108aee57"),
            description: ui("m_fc9929c6d6a254fb", [escapeMd(name), escapeMd(email)]),
            author: { name: `by ${actorName}` },
            fields,
            timestamp: nowIso(),
        },
    };
}

export function userJoined(args: {
    user: { id: number; name: string; picture?: string | null };
    env: Env['Bindings'];
}): WebhookEvent {
    const { user, env } = args;
    const profileUrl = absoluteUrl(env, `/profile/${encodeURIComponent(String(user.id))}`);
    const thumbnailUrl = user.picture ? absoluteUrl(env, user.picture) : undefined;

    return {
        channel: 'community',
        type: 'user_joined',
        embed: {
            color: COLOR_JOINED,
            title: ui("m_67f12481a97255e5"),
            description: ui("m_31b3cbb904761ba4", [escapeMd(user.name)]),
            url: profileUrl,
            thumbnail: thumbnailUrl ? { url: thumbnailUrl } : undefined,
            timestamp: nowIso(),
        },
    };
}
