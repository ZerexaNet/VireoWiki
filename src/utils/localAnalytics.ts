import type { Context } from 'hono';
import type { Env } from '../types';
import { trendingHomeSlugs } from './trendingPolicy';
const schema = [
`CREATE TABLE IF NOT EXISTS wiki_analytics_hourly (hour INTEGER NOT NULL, key TEXT NOT NULL, type TEXT NOT NULL, page_id INTEGER NOT NULL DEFAULT 0, referrer TEXT NOT NULL, country TEXT NOT NULL, device TEXT NOT NULL, query TEXT NOT NULL, error_message TEXT NOT NULL, path TEXT NOT NULL, status_code INTEGER NOT NULL, duration_bucket INTEGER NOT NULL, events INTEGER NOT NULL DEFAULT 1, duration_sum REAL NOT NULL DEFAULT 0, PRIMARY KEY(hour,key))`,
`CREATE INDEX IF NOT EXISTS wiki_analytics_time ON wiki_analytics_hourly(type,hour)`,
`CREATE INDEX IF NOT EXISTS wiki_analytics_expiration ON wiki_analytics_hourly(hour)`,
`CREATE TABLE IF NOT EXISTS wiki_page_view_totals (page_id INTEGER PRIMARY KEY, views INTEGER NOT NULL DEFAULT 0)`,
];
const pruned = new WeakMap<D1Database, number>();
const ready = new WeakMap<D1Database, Promise<void>>();
export function ensureLocalAnalytics(db: D1Database) {
    let promise = ready.get(db);
    if (!promise) { promise = db.batch(schema.map(sql => db.prepare(sql))).then(() => {}); ready.set(db, promise); promise.catch(() => ready.delete(db)); }
    return promise;
}
function referrerOrigin(value: string) { try { return new URL(value).origin.slice(0,160); } catch { return ''; } }
export async function recordLocalAnalytics(c: Context<Env>, type: 'pageview'|'search'|'error', value: string, duration = 0, status = 200, message = '') {
    const db = c.env.DB; await ensureLocalAnalytics(db);
    let pageId = 0;
    if (type === 'pageview') {
        const page = await db.prepare('SELECT id FROM pages WHERE slug=? AND is_private=0 AND deleted_at IS NULL').bind(value).first<{id:number}>();
        if (!page) return; pageId = page.id;
    }
    const ua = c.req.header('User-Agent') || '';
    if (type === 'pageview' && /bot|crawler|spider|preview/i.test(ua)) return;
    const country = String((c.req.raw.cf as any)?.country || '').slice(0,2);
    const device = /mobile|android|iphone|ipad/i.test(ua) ? 'mobile' : 'desktop';
    const referrer = referrerOrigin(c.req.header('Referer') || '');
    const query = type === 'search' ? value.slice(0,200) : '';
    const path = type === 'error' ? value.split('?')[0].slice(0,300) : '';
    const error = type === 'error' ? message.slice(0,300) : '';
    const ms = Number.isFinite(duration) ? Math.min(60000,Math.max(0,duration)) : 0;
    const bucket = [25,50,100,250,500,1000,2500,5000,10000,30000,60000].find(b => ms <= b)!;
    const hour = Math.floor(Date.now()/3600000)*3600;
    if (pruned.get(db) !== hour) { pruned.set(db,hour); await db.prepare('DELETE FROM wiki_analytics_hourly WHERE hour<?').bind(hour-90*86400).run(); }
    const key = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([type,pageId,referrer,country,device,query,path,error,status,bucket]))))).map(b=>b.toString(16).padStart(2,'0')).join('');
    const write = db.prepare(`INSERT INTO wiki_analytics_hourly(hour,key,type,page_id,referrer,country,device,query,error_message,path,status_code,duration_bucket,duration_sum) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM pages WHERE id=? AND is_private=0 AND deleted_at IS NULL) ON CONFLICT(hour,key) DO UPDATE SET events=events+1,duration_sum=duration_sum+excluded.duration_sum`)
        .bind(hour,key,type,pageId,referrer,country,device,query,error,path,status,bucket,ms,pageId,pageId);
    const statements = [write];
    if (pageId) statements.push(db.prepare(`INSERT INTO wiki_page_view_totals(page_id,views) SELECT ?,1 WHERE EXISTS(SELECT 1 FROM pages WHERE id=? AND is_private=0 AND deleted_at IS NULL) ON CONFLICT(page_id) DO UPDATE SET views=views+1`).bind(pageId,pageId));
    await db.batch(statements);
}
const PUBLIC = `FROM wiki_analytics_hourly a JOIN pages p ON p.id=a.page_id WHERE a.type='pageview' AND p.is_private=0 AND p.deleted_at IS NULL`;
export async function localTrending(db: D1Database, hours=24, limit=10, excludedHomes: string[] = [], excludeSystemPages = true) {
    await ensureLocalAnalytics(db);
    const excluded = excludeSystemPages ? ` AND substr(p.slug,1,5)!='Wiki/'${excludedHomes.map(() => ' AND p.slug!=?').join('')}` : '';
    return (await db.prepare(`SELECT p.slug,SUM(a.events) AS views ${PUBLIC} AND a.hour>=?${excluded} GROUP BY p.id ORDER BY views DESC,p.slug LIMIT ?`).bind(Math.floor(Date.now()/3600000)*3600-hours*3600,...(excludeSystemPages ? excludedHomes : []),limit).all()).results;
}
export async function localPageViews(db:D1Database,slug:string) {
    await ensureLocalAnalytics(db);
    const total = await db.prepare(`SELECT COALESCE(t.views,0) AS total FROM pages p LEFT JOIN wiki_page_view_totals t ON t.page_id=p.id WHERE p.slug=? AND p.is_private=0 AND p.deleted_at IS NULL`).bind(slug).first<{total:number}>();
    const recent = await db.prepare(`SELECT COALESCE(SUM(a.events),0) AS recent ${PUBLIC} AND p.slug=? AND a.hour>=?`).bind(slug,Math.floor(Date.now()/1000)-7*86400).first<{recent:number}>();
    return {total:total?.total||0,recent:recent?.recent||0};
}
export async function localDashboard(c: Context<Env>) {
    const db = c.env.DB; await ensureLocalAnalytics(db);
    const endpoint=c.req.path.split('/analytics/')[1], days=c.req.query('period')==='90d'?90:c.req.query('period')==='30d'?30:7;
    const since=Math.floor(Date.now()/1000)-days*86400,limit=Math.min(100,Math.max(1,Number(c.req.query('limit'))||30));
    const all=async(sql:string,params:any[]=[]) => (await db.prepare(sql).bind(...params).all()).results;
    const daily=()=>all(`SELECT date(a.hour,'unixepoch') AS date,SUM(a.events) AS views ${PUBLIC} AND a.hour>=? GROUP BY date ORDER BY date`,[since]);
    if(endpoint==='trending')return {trending:await localTrending(db,Math.min(72,Math.max(1,Number(c.req.query('hours'))||24)),20,trendingHomeSlugs(c.env))};
    if(endpoint==='overview')return {summary:await db.prepare(`SELECT COALESCE(SUM(a.events),0) AS total_views,COALESCE(SUM(a.events),0) AS sampled_views,COUNT(DISTINCT NULLIF(a.country,'')) AS unique_countries ${PUBLIC} AND a.hour>=?`).bind(since).first(),daily:await daily()};
    if(endpoint==='pages')return {pages:await localTrending(db,days*24,limit,[],false)};
    if(['referrers','countries','devices'].includes(endpoint)) {
        const column=endpoint==='referrers'?'referrer':endpoint==='countries'?'country':'device';
        return {[endpoint]:await all(`SELECT a.${column} AS ${column==='referrer'?'referer':column},SUM(a.events) AS views ${PUBLIC} AND a.hour>=? AND a.${column}!='' GROUP BY a.${column} ORDER BY views DESC LIMIT ?`,[since,limit])};
    }
    if(endpoint==='searches')return {searches:await all(`SELECT query,SUM(events) AS count FROM wiki_analytics_hourly WHERE type='search' AND hour>=? GROUP BY query ORDER BY count DESC LIMIT ?`,[since,limit])};
    if(endpoint==='errors')return {errors:await all(`SELECT path,error_message,status_code,SUM(events) AS count FROM wiki_analytics_hourly WHERE type='error' AND hour>=? GROUP BY path,error_message,status_code ORDER BY count DESC LIMIT ?`,[since,limit])};
    if(endpoint==='performance') {
        const histogram=await all(`SELECT a.duration_bucket,SUM(a.events) AS count ${PUBLIC} AND a.hour>=? GROUP BY a.duration_bucket ORDER BY a.duration_bucket`,[since]) as any[];
        const total=histogram.reduce((s,r)=>s+Number(r.count),0);
        const quantile=(fraction:number)=>{let sum=0;for(const row of histogram){sum+=Number(row.count);if(sum>=total*fraction)return row.duration_bucket;}return 0;};
        const avg=await db.prepare(`SELECT COALESCE(SUM(a.duration_sum)/NULLIF(SUM(a.events),0),0) AS avg_response_ms ${PUBLIC} AND a.hour>=?`).bind(since).first();
        return {summary:{...avg,p95_response_ms:quantile(.95),p99_response_ms:quantile(.99)},percentile_method:'histogram_upper_bound',daily:await all(`SELECT date(a.hour,'unixepoch') AS date,SUM(a.duration_sum)/SUM(a.events) AS avg_response_ms ${PUBLIC} AND a.hour>=? GROUP BY date ORDER BY date`,[since])};
    }
    if(endpoint?.startsWith('page/')) {
        const slug=c.req.param('slug') || '';return {slug,total:(await localPageViews(db,slug)).total,daily:await all(`SELECT date(a.hour,'unixepoch') AS date,SUM(a.events) AS views ${PUBLIC} AND p.slug=? AND a.hour>=? GROUP BY date ORDER BY date`,[slug,since])};
    }
    return null;
}
export const LOCAL_ANALYTICS_SCHEMA = schema;
