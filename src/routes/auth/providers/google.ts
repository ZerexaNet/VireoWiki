import { ui } from '../../../i18n/server';
import type { Context } from 'hono';
import type { Env } from '../../../types';
import type { OAuthProvider, OAuthCallbackResult, OAuthStateData } from './base';

export const googleProvider: OAuthProvider = {
    name: 'google',
    label: ui("m_ce770667e5f9b0d8"),

    async handleLogin(c: Context<Env>, stateData?: Partial<OAuthStateData>): Promise<Response> {
        if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_REDIRECT_URI) {
            return c.redirect('/?error=oauth_not_configured&provider=google');
        }

        const rawRedirect = c.req.query('redirect');
        const safeRedirectUrl = (rawRedirect && rawRedirect.startsWith('/') && !rawRedirect.startsWith('//') && !/[\x00-\x1f\x7f]/.test(rawRedirect))
            ? rawRedirect
            : undefined;

        const state = crypto.randomUUID();
        const payload: OAuthStateData = {
            provider: 'google',
            intent: stateData?.intent ?? 'login',
            userId: stateData?.userId,
            expectedUid: stateData?.expectedUid,
            redirectUrl: stateData?.redirectUrl ?? safeRedirectUrl,
            remember: stateData?.remember ?? (c.req.query('remember') === '1'),
        };
        await c.env.KV.put(`oauth_state:${state}`, JSON.stringify(payload), { expirationTtl: 300 });

        const params = new URLSearchParams({
            client_id: c.env.GOOGLE_CLIENT_ID,
            redirect_uri: c.env.GOOGLE_REDIRECT_URI,
            response_type: 'code',
            scope: 'openid email profile',
            access_type: 'offline',
            prompt: 'consent',
            state,
        });
        return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
    },

    async handleCallback(c: Context<Env>): Promise<OAuthCallbackResult | Response> {
        const code = c.req.query('code');
        const state = c.req.query('state');

        // CSRF 검증
        if (!state) {
            return c.redirect('/error?reason=' + encodeURIComponent(ui("m_c19f90377ab6e2c9")));
        }
        const storedRaw = await c.env.KV.get(`oauth_state:${state}`);
        if (!storedRaw) {
            return c.redirect('/error?reason=' + encodeURIComponent(ui("m_bbb52cca8cca84f1")));
        }

        // 구 포맷(단순 'google' 문자열) 폴백: 배포 전환 시점에 이미 진행 중이던 로그인 호환용
        let stateData: OAuthStateData;
        if (storedRaw === 'google') {
            stateData = { provider: 'google', intent: 'login' };
        } else {
            try {
                stateData = JSON.parse(storedRaw) as OAuthStateData;
            } catch {
                await c.env.KV.delete(`oauth_state:${state}`);
                return c.redirect('/error?reason=' + encodeURIComponent(ui("m_fbfc48924eda24a4")));
            }
        }
        if (stateData.provider !== 'google') {
            await c.env.KV.delete(`oauth_state:${state}`);
            return c.redirect('/error?reason=' + encodeURIComponent(ui("m_dd3940b67e5e416c")));
        }
        await c.env.KV.delete(`oauth_state:${state}`);

        if (!code) {
            return c.redirect('/?error=auth_missing_code&provider=google');
        }

        // 1. code → access_token 교환
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: c.env.GOOGLE_CLIENT_ID,
                client_secret: c.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: c.env.GOOGLE_REDIRECT_URI,
                grant_type: 'authorization_code',
            }),
        });

        if (!tokenRes.ok) {
            const err = await tokenRes.text();
            console.error('Google token exchange failed:', err);
            return c.redirect('/?error=auth_token_exchange_failed&provider=google');
        }

        const tokenData = (await tokenRes.json()) as { access_token: string };

        // 2. access_token → userinfo 조회
        const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });

        if (!userRes.ok) {
            return c.redirect('/?error=auth_user_info_failed&provider=google');
        }

        const userInfo = (await userRes.json()) as {
            id: string;
            email: string;
            name: string;
            picture: string;
            verified_email?: boolean;
            email_verified?: boolean;
        };

        if (!userInfo.verified_email && !userInfo.email_verified) {
            return c.redirect('/?error=email_not_verified&provider=google');
        }

        return {
            profile: {
                provider: 'google',
                uid: userInfo.id,
                email: userInfo.email,
                name: userInfo.name,
                picture: userInfo.picture,
            },
            state: stateData,
        };
    },
};
