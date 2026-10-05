import type { Env } from '../types';
import { normalizeSlug } from './slug';

/** The regular home document and optional configured landing document are not ranked. */
export function trendingHomeSlugs(env: Pick<Env['Bindings'], 'WIKI_NAME' | 'WIKI_HOME_PAGE'>): string[] {
    return [...new Set([env.WIKI_NAME || 'CloudWiki', env.WIKI_HOME_PAGE || ''].map(normalizeSlug).filter(Boolean))];
}

/** Analytics Engine uses SQL literals; escape configured names before interpolation. */
export function analyticsTrendingFilter(env: Pick<Env['Bindings'], 'WIKI_NAME' | 'WIKI_HOME_PAGE'>): string {
    const literal = (s: string) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
    return `NOT (blob2 >= 'Wiki/' AND blob2 < 'Wiki0')` + trendingHomeSlugs(env).map(slug => ` AND blob2 != ${literal(slug)}`).join('');
}
