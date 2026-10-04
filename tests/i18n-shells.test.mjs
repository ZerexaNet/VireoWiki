import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { parse } from 'parse5';
import { localizeShell } from '../scripts/localize-shells.mjs';
const en = JSON.parse(await readFile(new URL('../packages/wiki-shared/src/i18n/en.json', import.meta.url), 'utf8'));

test('shell localization translates labels and preserves protected content', () => {
    const html = '<html lang="ko"><body><button title="저장">저장</button><pre>저장</pre><div data-no-i18n>저장</div><script>const text="저장"</script></body></html>';
    const result = localizeShell(html, 'en', en);
    assert.match(result, /lang="en"/);
    assert.match(result, /title="Save">Save/);
    assert.match(result, /<pre>저장<\/pre>/);
    assert.match(result, /data-no-i18n="">저장/);
    assert.match(result, /const text="저장"/);
});

test('language selector has the correct accessible label', () => {
    const result = localizeShell('<html lang="ko"><select data-language-selector aria-label="界面语言"></select></html>', 'en', en);
    assert.match(result, /aria-label="Interface language"/);
});

test('shell title localization preserves the configured site name', async () => {
    const en = JSON.parse(await readFile(new URL('../packages/wiki-shared/src/i18n/en.json', import.meta.url), 'utf8'));
    const localized = localizeShell('<html><head><title>블로그 - My Custom Wiki</title></head></html>', 'en', en);
    assert.match(localized, /Blog - My Custom Wiki/);
    assert.doesNotMatch(localized, /블로그/);
});

// Build verification is available after npm run build without coupling unit tests to generated files.
if (process.env.I18N_CHECK_BUILD === '1') test('all 42 generated shells use the requested language and an existing bootstrap', async () => {
    for (const locale of ['zh-CN', 'en']) {
        const folder = new URL(`../public/_i18n/${locale}/`, import.meta.url);
        const pages = await readdir(folder);
        assert.equal(pages.filter(p => p.endsWith('.html')).length, 21);
        for (const page of pages.filter(p => p.endsWith('.html'))) {
            const html = await readFile(new URL(page, folder), 'utf8');
            assert.match(html, new RegExp(`lang="${locale}"`));
            assert.match(html, /src="\/dist\/i18n.js"/);
            await access(new URL('../public/dist/i18n.js', import.meta.url));
            const doc = parse(html);
            function check(n, skip = false) {
                skip ||= ['script', 'style', 'code', 'pre'].includes(n.tagName);
                if (!skip && n.nodeName === '#text') assert.doesNotMatch(n.value, /[가-힣]/, page);
                for (const c of n.childNodes ?? []) check(c, skip);
            }
            check(doc);
        }
    }
});
