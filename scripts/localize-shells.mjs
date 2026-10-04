import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, serialize } from 'parse5';

const root = fileURLToPath(new URL('../', import.meta.url));
const catalogRoot = resolve(root, 'packages/wiki-shared/src/i18n');
const sources = JSON.parse(await readFile(resolve(catalogRoot, 'source.json'), 'utf8'));
const lookup = new Map(Object.entries(sources).map(([key, value]) => [value, key]));
const attrs = new Set(['title', 'alt', 'placeholder', 'aria-label', 'content']);

export function localizeShell(html, locale, catalog) {
    const document = parse(html);
    const text = (value, title = false) => {
        const key = lookup.get(value.trim());
        if (!key) {
            // Static layouts substitute the configured site name before localization.
            // Translate only known title labels and preserve that user-provided name.
            if (title) for (const [source, titleKey] of lookup) {
                const suffix = 'VireoWiki';
                const translated = catalog[titleKey];
                if (source.endsWith(suffix) && translated?.endsWith(suffix)) {
                    const prefix = source.slice(0, -suffix.length);
                    if (prefix && value.trim().startsWith(prefix)) return translated.slice(0, -suffix.length) + value.trim().slice(prefix.length);
                }
            }
            return value;
        }
        return (value.match(/^\s*/)?.[0] ?? '') + (catalog[key] ?? value.trim()) + (value.match(/\s*$/)?.[0] ?? '');
    };
    function visit(node, excluded = false) {
        const protectedContent = excluded || ['script', 'style', 'pre', 'code'].includes(node.tagName) ||
            (node.attrs ?? []).some(a => a.name === 'data-no-i18n');
        if (node.nodeName === '#text' && !protectedContent) node.value = text(node.value, node.parentNode?.tagName === 'title');
        for (const attr of node.attrs ?? []) {
            if (node.tagName === 'html' && attr.name === 'lang') attr.value = locale;
            else if (attrs.has(attr.name) && !protectedContent) {
                if (attr.name === 'aria-label' && (node.attrs ?? []).some(a => a.name === 'data-language-selector')) attr.value = locale === 'en' ? 'Interface language' : '界面语言';
                else attr.value = text(attr.value);
            }
        }
        for (const child of node.childNodes ?? []) visit(child, protectedContent);
        if (node.content) visit(node.content, protectedContent);
    }
    visit(document);
    return serialize(document);
}

export async function buildLocalizedShells() {
    const pages = (await readdir(resolve(root, '.astro-dist'))).filter(name => name.endsWith('.html'));
    for (const locale of ['zh-CN', 'en']) {
        const catalog = JSON.parse(await readFile(resolve(catalogRoot, locale + '.json'), 'utf8'));
        const destination = resolve(root, 'public/_i18n', locale);
        await mkdir(destination, { recursive: true });
        for (const page of pages) {
            const html = await readFile(resolve(root, '.astro-dist', page), 'utf8');
            const localized = localizeShell(html, locale, catalog);
            await writeFile(resolve(destination, page), localized);
            // Direct .html requests and asset-only hosting use the default Chinese shell.
            if (locale === 'zh-CN') await writeFile(resolve(root, 'public', page), localized);
        }
    }
    console.log(`Localized ${pages.length} shells in Chinese and English.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildLocalizedShells();
