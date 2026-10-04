import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale, translate, type Locale } from './core';

export function getLocale(): Locale {
    // Shared helpers can also be imported in Workers and service workers.
    if (typeof document === 'undefined') return DEFAULT_LOCALE;
    return normalizeLocale(document.documentElement.lang) ?? DEFAULT_LOCALE;
}

export function ui(key: string, values: readonly unknown[] = []): string {
    return translate(key, getLocale(), values);
}

export function setLocale(locale: Locale): void {
    if (typeof document === 'undefined') return;
    document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
    const url = new URL(location.href);
    url.searchParams.set('lang', locale);
    location.assign(url.href);
}

export function initI18n(): void {
    (globalThis as typeof globalThis & { VireoI18n?: { ui: typeof ui; getLocale: typeof getLocale } }).VireoI18n = { ui, getLocale };
    document.querySelectorAll<HTMLSelectElement>('[data-language-selector]').forEach(select => {
        select.value = getLocale();
        select.addEventListener('change', () => {
            const locale = normalizeLocale(select.value);
            if (locale) setLocale(locale);
        });
    });
}
