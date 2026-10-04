import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import sources from '../packages/wiki-shared/src/i18n/source.json';
import { catalogs, normalizeLocale, translate, translateLiteral } from '../packages/wiki-shared/src/i18n/core';
import { localeMiddleware, getLocale, withLocale } from '../src/i18n/server';

test('every catalog key exists in both languages and preserves interpolation slots', () => {
    assert.deepEqual(Object.keys(catalogs.en).sort(), Object.keys(sources).sort());
    assert.deepEqual(Object.keys(catalogs['zh-CN']).sort(), Object.keys(sources).sort());
    const slots = (text: string) => [...text.matchAll(/__VIREO_SLOT_\d+__/g)].map(m => m[0]).sort();
    for (const [key, source] of Object.entries(sources)) {
        for (const locale of ['zh-CN', 'en'] as const) {
            assert.ok(catalogs[locale][key].length, `${locale}: ${key}`);
            assert.deepEqual(slots(catalogs[locale][key]), slots(source), `${locale}: ${key}`);
        }
    }
});

test('literal translation leaves user text and unsupported locale input intact', () => {
    assert.equal(translateLiteral('저장', 'en'), 'Save');
    assert.equal(translateLiteral('저장', 'zh-CN'), '保存');
    assert.equal(translateLiteral('My own page: 저장', 'en'), 'My own page: 저장');
    assert.equal(normalizeLocale('en-GB'), 'en');
    assert.equal(normalizeLocale('zh-Hans'), 'zh-CN');
    assert.equal(normalizeLocale('<script>alert(1)</script>'), null);
});

test('interpolated values never undergo recursive replacement or translation', () => {
    const key = Object.keys(sources).find(k => sources[k as keyof typeof sources] === '팔레트 편집: __VIREO_SLOT_0__')!;
    assert.ok(key);
    const value = '저장 __VIREO_SLOT_0__ <b>owned</b>';
    assert.ok(translate(key, 'en', [value]).endsWith(value));
});

test('asynchronous locale contexts remain isolated', async () => {
    const results = await Promise.all([
        withLocale('en', async () => { await new Promise(r => setTimeout(r, 20)); return getLocale(); }),
        withLocale('zh-CN', async () => { await new Promise(r => setTimeout(r, 5)); return getLocale(); }),
    ]);
    assert.deepEqual(results, ['en', 'zh-CN']);
    assert.equal(getLocale(), 'zh-CN');
});

test('language query and cookie negotiate independently and prevent shared-cache leakage', async () => {
    const app = new Hono();
    app.use('*', localeMiddleware as any);
    app.get('/', async c => {
        await new Promise(r => setTimeout(r, getLocale() === 'en' ? 10 : 1));
        return c.json({ locale: getLocale() });
    });
    const env = { DEFAULT_LOCALE: 'zh-CN' };
    const [english, chinese] = await Promise.all([
        app.request('/?lang=en', {}, env),
        app.request('/', { headers: { Cookie: 'vireo_locale=zh-CN' } }, env),
    ]);
    assert.deepEqual(await english.json(), { locale: 'en' });
    assert.deepEqual(await chinese.json(), { locale: 'zh-CN' });
    assert.match(english.headers.get('Set-Cookie')!, /vireo_locale=en/);
    assert.equal(english.headers.get('Content-Language'), 'en');
    assert.match(english.headers.get('Vary')!, /Cookie/);
    assert.equal(english.headers.get('Cache-Control'), 'private, no-cache');
    const cookie = await app.request('/', { headers: { Cookie: 'vireo_locale=en' } }, env);
    assert.deepEqual(await cookie.json(), { locale: 'en' });
});

test('translated templates preserve HTML structure and behavioral attributes', async () => {
    const { parseFragment } = await import('parse5');
    const presentation = new Set(['title', 'alt', 'placeholder', 'aria-label', 'content']);
    const shape = (node: any): any => ({
        name: node.nodeName,
        attrs: (node.attrs ?? []).filter((a: any) => !presentation.has(a.name)),
        children: (node.childNodes ?? []).filter((n: any) => n.nodeName !== '#text').map(shape),
        template: node.content ? shape(node.content) : undefined,
    });
    for (const [key, source] of Object.entries(sources)) {
        if (!/<[a-zA-Z][\s>]/.test(source) && !/<[a-zA-Z][\w-]*[\s>]/.test(source)) continue;
        const original = shape(parseFragment(source));
        for (const locale of ['zh-CN', 'en'] as const) {
            assert.deepEqual(shape(parseFragment(catalogs[locale][key])), original, `${locale}: ${key}`);
        }
    }
});
