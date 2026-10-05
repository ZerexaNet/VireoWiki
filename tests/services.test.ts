import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Hono} from 'hono';
import {recordLocalAnalytics,localTrending,localPageViews,ensureLocalAnalytics,localDashboard} from '../src/utils/localAnalytics';
import analyticsRoutes from '../src/routes/analytics';
import mcpRoutes from '../src/routes/mcp';
import {RBAC} from '../src/utils/role';
function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec('CREATE TABLE pages(id INTEGER PRIMARY KEY,slug TEXT,is_private INTEGER DEFAULT 0,deleted_at INTEGER);INSERT INTO pages(id,slug,is_private) VALUES(1,\'Public\',0),(2,\'Secret\',1);');
 const db:any={prepare(query:string){let params:any[]=[];const s={bind(...args:any[]){params=args;return s},async first(){return sql.prepare(query).get(...params)||null},async all(){return{results:sql.prepare(query).all(...params)}},async run(){return{meta:{changes:Number(sql.prepare(query).run(...params).changes)}}}};return s},async batch(items:any[]){sql.exec('BEGIN');try{const result=[];for(const item of items)result.push(await item.run());sql.exec('COMMIT');return result}catch(error){sql.exec('ROLLBACK');throw error}}};
 const c:any={env:{DB:db},req:{header:(name:string)=>name==='Referer'?'https://example.com/path?token=private':name==='User-Agent'?'Browser':'',raw:{cf:{country:'CN'}}}};
 return{sql,db,c};
}
test('D1 counts reads, updates trending immediately, and excludes private/deleted pages',async()=>{
 const {sql,db,c}=fixture();await recordLocalAnalytics(c,'pageview','Public',42);await recordLocalAnalytics(c,'pageview','Public',100);await recordLocalAnalytics(c,'pageview','Secret');await recordLocalAnalytics(c,'pageview','missing');
 assert.deepEqual(JSON.parse(JSON.stringify(await localPageViews(db,'Public'))),{total:2,recent:2});
 assert.equal((await localTrending(db))[0].views,2);assert.equal((await localTrending(db)).length,1);
 assert.equal((sql.prepare('SELECT referrer FROM wiki_analytics_hourly LIMIT 1').get() as any).referrer,'https://example.com');
 sql.exec('UPDATE pages SET slug=\'Moved\' WHERE id=1');assert.equal((await localPageViews(db,'Moved')).total,2);
 sql.exec('UPDATE pages SET is_private=1 WHERE id=1');assert.deepEqual(await localTrending(db),[]);assert.equal((await localPageViews(db,'Moved')).total,0);
 sql.exec('UPDATE pages SET is_private=0,deleted_at=1 WHERE id=1');assert.deepEqual(await localTrending(db),[]);
});
test('hourly retention preserves lifetime counts',async()=>{
 const {sql,db,c}=fixture();await ensureLocalAnalytics(db);await recordLocalAnalytics(c,'pageview','Public');sql.exec('UPDATE wiki_analytics_hourly SET hour=1');
 assert.equal((await localPageViews(db,'Public')).total,1);assert.equal((await localPageViews(db,'Public')).recent,0);assert.deepEqual(await localTrending(db),[]);
});
test('admin statistics work without external analytics credentials and remain protected',async()=>{
 const {db,c}=fixture();await recordLocalAnalytics(c,'pageview','Public',40);await recordLocalAnalytics(c,'search','query');await recordLocalAnalytics(c,'error','/missing?secret=x',20,404,'Not found');
 const app=new Hono<any>();app.use('*',async(c,next)=>{c.set('user',{role:c.req.header('X-Test-Role')||'admin'});c.set('rbac',new RBAC());await next()});app.route('/api/admin/analytics',analyticsRoutes);
 for(const endpoint of ['overview','pages','trending','referrers','countries','devices','searches','errors','performance','page/Public']){const response=await app.request('/api/admin/analytics/'+endpoint,{}, {DB:db});assert.equal(response.status,200,endpoint);assert.ok(await response.json());}
 assert.equal((await app.request('/api/admin/analytics/overview',{headers:{'X-Test-Role':'user'}},{DB:db})).status,403);
});
test('MCP open mode initializes and lists public tools; disabled mode stays denied',async()=>{
 const app=new Hono<any>();app.use('*',async(c,next)=>{c.set('user',null);c.set('rbac',new RBAC());await next()});app.route('/api/mcp',mcpRoutes);
 const request=(method:string,mode='open')=>app.request('/api/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}})},{MCP_MODE:mode,WIKI_VISIBILITY:'open'});
 const initialized=await request('initialize');assert.equal(initialized.status,200);assert.ok((await initialized.json() as any).result.capabilities.tools);
 const tools=await request('tools/list');assert.equal(tools.status,200);assert.ok((await tools.json() as any).result.tools.length>0);
 assert.equal((await request('initialize','disabled')).status,403);
});
