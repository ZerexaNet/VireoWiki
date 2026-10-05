import {findPrefixRuleEditAcl,evaluateEditAcl} from '../src/utils/editAcl';
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

test('system pages stay counted but are excluded from trending before the limit', async () => {
 const {sql,db,c}=fixture();
 sql.exec("INSERT INTO pages(id,slug) VALUES(3,'Wiki/服务条款'),(4,'Nodeloc Wiki'),(5,'Wiki/指南/子页'),(6,'WikiX/普通页面')");
 for(const slug of ['Wiki/服务条款','Nodeloc Wiki','Wiki/指南/子页']) for(let i=0;i<3;i++) await recordLocalAnalytics(c,'pageview',slug);
 await recordLocalAnalytics(c,'pageview','Public');await recordLocalAnalytics(c,'pageview','WikiX/普通页面');
 const rows=await localTrending(db,24,1,['Nodeloc Wiki']);assert.equal(rows.length,1);assert.equal(rows[0].slug,'Public');
 assert.equal((await localPageViews(db,'Wiki/服务条款')).total,3);
 assert.equal((await localPageViews(db,'Nodeloc Wiki')).total,3);
 const all=await localTrending(db,24,20,[],false);assert.equal(all.length,5);
 c.env.WIKI_NAME='Nodeloc Wiki';c.req.path='/api/admin/analytics/trending';c.req.query=()=>undefined;
 const dashboard:any=await localDashboard(c);assert.deepEqual(dashboard.trending.map((r:any)=>r.slug),['Public','WikiX/普通页面']);
});

test('Wiki prefix defaults deny ordinary editors and allow administrators', async () => {
 const {sql,db}=fixture();
 sql.exec(`CREATE TABLE doc_setting_prefix_rules(prefix TEXT,is_private INTEGER,edit_acl TEXT);INSERT INTO doc_setting_prefix_rules VALUES('Wiki',NULL,'{"flags":["admin_only"]}')`);
 const acl=await findPrefixRuleEditAcl(db,'Wiki/新页面/子页面');assert.ok(acl);
 assert.equal((await evaluateEditAcl(db,acl!,{id:1,role:'user'} as any,null,0,false)).allowed,false);
 assert.equal((await evaluateEditAcl(db,acl!,{id:1,role:'admin'} as any,null,0,true)).allowed,true);
 assert.equal(await findPrefixRuleEditAcl(db,'WikiX/普通页面'),null);
});
