import { AsyncLocalStorage } from 'node:async_hooks';
import { getCookie, setCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types';
import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale, translate, type Locale } from '../../packages/wiki-shared/src/i18n/core';

const locales = new AsyncLocalStorage<Locale>();
export function getLocale(): Locale { return locales.getStore() ?? DEFAULT_LOCALE; }
export function ui(key: string, values: readonly unknown[] = []): string {
    return translate(key, getLocale(), values);
}
export function withLocale<T>(locale: Locale, callback: () => T): T { return locales.run(locale, callback); }

/** Locale is isolated per request, including interleaved asynchronous handlers. */
export const localeMiddleware: MiddlewareHandler<Env> = async (c, next) => {
    const explicit = normalizeLocale(c.req.query('lang'));
    const locale = explicit ?? normalizeLocale(getCookie(c, LOCALE_COOKIE)) ??
        normalizeLocale(c.env.DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
    await withLocale(locale, async () => {
        await next();
        if (explicit) setCookie(c, LOCALE_COOKIE, locale, {
            path: '/', maxAge: 31536000, sameSite: 'Lax', secure: new URL(c.req.url).protocol === 'https:',
        });
        const type = c.res.headers.get('Content-Type') ?? '';
        if (type.includes('text/html') || type.includes('application/json')) {
            c.header('Content-Language', locale);
            const vary = new Set((c.res.headers.get('Vary') ?? '').split(',').map(s => s.trim()).filter(Boolean));
            vary.add('Cookie');
            c.header('Vary', [...vary].join(', '));
            // Public shared-cache entries must not leak one visitor's language to another.
            c.header('Cache-Control', 'private, no-cache');
        }
    });
};
