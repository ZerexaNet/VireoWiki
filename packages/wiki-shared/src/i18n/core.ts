import zh from './zh-CN.json';
import en from './en.json';
import source from './source.json';

export type Locale = 'zh-CN' | 'en';
export const DEFAULT_LOCALE: Locale = 'zh-CN';
export const LOCALE_COOKIE = 'vireo_locale';
export const catalogs: Record<Locale, Record<string, string>> = { 'zh-CN': zh, en };

export function normalizeLocale(value: string | null | undefined): Locale | null {
    const language = value?.trim().toLowerCase();
    if (language === 'en' || language?.startsWith('en-')) return 'en';
    if (language === 'zh' || language === 'zh-cn' || language === 'zh-hans') return 'zh-CN';
    return null;
}

/** Only catalogued application literals are translated. Values stay byte-for-byte intact. */
export function translate(key: string, locale: Locale, values: readonly unknown[] = []): string {
    const pattern = catalogs[locale][key] ?? catalogs[DEFAULT_LOCALE][key] ?? key;
    return pattern.replace(/__VIREO_SLOT_(\d+)__/g, (token, index: string) =>
        Number(index) < values.length ? String(values[Number(index)]) : token);
}

export function translateLiteral(value: string, locale: Locale): string {
    const sourceKeys = new Map(Object.entries(source).map(([key, value]) => [value, key]));
    const key = sourceKeys.get(value.trim());
    if (!key) return value;
    const leading = value.match(/^\s*/)?.[0] ?? '';
    const trailing = value.match(/\s*$/)?.[0] ?? '';
    return leading + translate(key, locale) + trailing;
}
