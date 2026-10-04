import { ui } from '../../../i18n/server';
import type { Context } from 'hono';
import type { Env } from '../../../types';
import type { OAuthProvider, OAuthCallbackResult, OAuthStateData } from './base';

// NodeLoc OIDC discovery: https://www.nodeloc.com/oauth-provider/.well-known/openid-configuration
const AUTHORIZATION_URL = 'https://www.nodeloc.com/oauth-provider/authorize';
const TOKEN_URL = 'https://www.nodeloc.com/oauth-provider/token';
const USERINFO_URL = 'https://www.nodeloc.com/oauth-provider/userinfo';

export const nodelocProvider: OAuthProvider = {
    name: 'nodeloc',
    label: ui("m_d2b0e22ce6848f49"),

    async handleLogin(c: Context<Env>, stateData?: Partial<OAuthStateData>): Promise<Response> {
        if (!c.env.NODELOC_CLIENT_ID || !c.env.NODELOC_CLIENT_SECRET || !c.env.NODELOC_REDIRECT_URI) {
            return c.redirect('/?error=oauth_not_configured&provider=nodeloc');
        }

        const rawRedirect = c.req.query('redirect');
        const safeRedirectUrl = rawRedirect && rawRedirect.startsWith('/') && !rawRedirect.startsWith('//') && !/[\x00-\x1f\x7f]/.test(rawRedirect)
            ? rawRedirect : undefined;
        const state = crypto.randomUUID();
        const payload: OAuthStateData = {
            provider: 'nodeloc',
            intent: stateData?.intent ?? 'login',
            userId: stateData?.userId,
            expectedUid: stateData?.expectedUid,
            redirectUrl: stateData?.redirectUrl ?? safeRedirectUrl,
            remember: stateData?.remember ?? (c.req.query('remember') === '1'),
        };
        await c.env.KV.put(`oauth_state:${state}`, JSON.stringify(payload), { expirationTtl: 300 });

        const params = new URLSearchParams({
            response_type: 'code',
            client_id: c.env.NODELOC_CLIENT_ID,
            redirect_uri: c.env.NODELOC_REDIRECT_URI,
            scope: 'openid profile email',
            state,
        });
        return c.redirect(`${AUTHORIZATION_URL}?${params}`);
    },

    async handleCallback(c: Context<Env>): Promise<OAuthCallbackResult | Response> {
        const state = c.req.query('state');
        if (!state) return c.redirect('/?error=auth_invalid_state&provider=nodeloc');

        const stored = await c.env.KV.get(`oauth_state:${state}`);
        if (!stored) return c.redirect('/?error=auth_invalid_state&provider=nodeloc');
        await c.env.KV.delete(`oauth_state:${state}`);

        let stateData: OAuthStateData;
        try {
            stateData = JSON.parse(stored) as OAuthStateData;
        } catch {
            return c.redirect('/?error=auth_invalid_state&provider=nodeloc');
        }
        if (stateData.provider !== 'nodeloc' || !['login', 'refresh_picture'].includes(stateData.intent)) {
            return c.redirect('/?error=auth_invalid_state&provider=nodeloc');
        }

        const code = c.req.query('code');
        if (!code) return c.redirect('/?error=auth_missing_code&provider=nodeloc');

        try {
            const tokenRes = await fetch(TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: c.env.NODELOC_REDIRECT_URI,
                    client_id: c.env.NODELOC_CLIENT_ID,
                    client_secret: c.env.NODELOC_CLIENT_SECRET,
                }),
            });
            if (!tokenRes.ok) return c.redirect('/?error=auth_token_exchange_failed&provider=nodeloc');
            const token = await tokenRes.json() as { access_token?: unknown };
            if (typeof token.access_token !== 'string' || !token.access_token) {
                return c.redirect('/?error=auth_token_exchange_failed&provider=nodeloc');
            }

            const userRes = await fetch(USERINFO_URL, {
                headers: { Authorization: `Bearer ${token.access_token}` },
            });
            if (!userRes.ok) return c.redirect('/?error=auth_user_info_failed&provider=nodeloc');
            const user = await userRes.json() as Record<string, unknown>;
            if (typeof user.sub !== 'string' || !user.sub || typeof user.email !== 'string' || !user.email) {
                return c.redirect('/?error=auth_user_info_failed&provider=nodeloc');
            }
            if (user.email_verified !== true) {
                return c.redirect('/?error=email_not_verified&provider=nodeloc');
            }

            return {
                profile: {
                    provider: 'nodeloc',
                    uid: user.sub,
                    email: user.email,
                    name: (typeof user.preferred_username === 'string' && user.preferred_username) ||
                        (typeof user.name === 'string' && user.name) || user.sub,
                    picture: typeof user.picture === 'string' ? user.picture : undefined,
                },
                state: stateData,
            };
        } catch (error) {
            console.error('NodeLoc OAuth request failed:', error);
            return c.redirect('/?error=auth_user_info_failed&provider=nodeloc');
        }
    },
};
