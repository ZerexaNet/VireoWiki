import worker from '../src/index';
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

test('personal token expiration validates input and keeps backward compatibility', async () => {
 const {personalTokenExpiry}=await import('../src/utils/personalTokens');
 assert.equal(personalTokenExpiry(undefined,100),100+30*86400);
 assert.equal(personalTokenExpiry(150,100),150);assert.equal(personalTokenExpiry(0,100),0);assert.equal(personalTokenExpiry(null,100),0);
 for(const value of [99,100,-1,150.1,'150',NaN,Infinity,253402300800])assert.throws(()=>personalTokenExpiry(value,100));
});

test('personal tokens authenticate API and MCP, honor current roles and expire/revoke immediately', async () => {
 const {readFile}=await import('node:fs/promises');
 const {authenticatePersonalToken}=await import('../src/utils/personalTokens');
 const {resolveBearerAuth}=await import('../src/utils/mcpAuth');
 const {sha256Hex}=await import('../src/utils/oauth');
 const sql=new DatabaseSync(':memory:');sql.exec(await readFile('migrations/schema.sql','utf8'));
 const db:any={prepare(query:string){let params:any[]=[];const s={bind(...args:any[]){params=args;return s},async first(){return sql.prepare(query).get(...params)||null},async all(){return{results:sql.prepare(query).all(...params)}},async run(){const r=sql.prepare(query).run(...params);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}};return s},async batch(items:any[]){sql.exec('BEGIN');try{const result=[];for(const item of items)result.push(await item.run());sql.exec('COMMIT');return result}catch(error){sql.exec('ROLLBACK');throw error}}};
 sql.exec("INSERT INTO users(id,provider,uid,email,name,role) VALUES(1,'nodeloc','1','token@example.com','API editor','user');INSERT INTO pages(id,slug,content,version) VALUES(1,'Public','hello',1)");
 const objects=new Map<string,string>();
 const env:any={DB:db,KV:{get:async()=>null,put:async()=>{},delete:async()=>{}},MEDIA:{put:async(key:string,value:string)=>{objects.set(key,value);return{}},get:async(key:string)=>objects.has(key)?{text:async()=>objects.get(key),arrayBuffer:async()=>new TextEncoder().encode(objects.get(key)).buffer}:null},WIKI_NAME:'Test Wiki',WIKI_VISIBILITY:'open',MCP_MODE:'open',SUPER_ADMIN_EMAILS:'',ENABLED_EXTENSIONS:'',EDIT_REQUEST_ENABLED:'false',ASSETS:{fetch:async()=>new Response('',{status:404})}};
 const waits:Promise<any>[]=[];const ctx:any={waitUntil:(p:Promise<any>)=>waits.push(p),passThroughOnException(){}};
 (globalThis as any).caches={default:{match:async()=>undefined,put:async()=>{},delete:async()=>true}};
 const now=Math.floor(Date.now()/1000);
 sql.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('browser',1,now+3600);
 const browser={Cookie:'wiki_session=browser',Origin:'https://example.com','Content-Type':'application/json'};
 const call=(path:string,init:any={})=>worker.fetch(new Request('https://example.com'+path,init),env,ctx);
 const tokenPage=await call('/tokens',{headers:browser});assert.equal(tokenPage.status,200);
 const html=await tokenPage.text();assert.ok(html.includes('datetime-local'));assert.ok(html.includes('value="never"'));
 const {Script}=await import('node:vm');new Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]);
 const generated=await call('/api/me/api-token',{method:'POST',headers:browser,body:JSON.stringify({expires_at:now+120})});assert.equal(generated.status,200);
 const data:any=await generated.json();assert.match(data.token,/^wiki_/);assert.equal(data.expires_at,now+120);
 const headers={Authorization:'Bearer '+data.token,'Content-Type':'application/json'};
 assert.equal((await call('/api/me',{headers})).status,200);
 assert.equal((await call('/api/me/mcp-instant-apply',{method:'PUT',headers,body:'{"enabled":true}'})).status,200);
 assert.equal((sql.prepare('SELECT mcp_instant_apply FROM users WHERE id=1').get() as any).mcp_instant_apply,1);
 assert.notEqual((sql.prepare('SELECT token_hash FROM git_tokens WHERE user_id=1').get() as any).token_hash,data.token);
 assert.equal((await call('/api/me/mcp-api-key',{method:'POST',headers})).status,403);
 assert.equal((await call('/api/me/api-token',{method:'POST',headers,body:'{}'})).status,403);
 assert.equal((await call('/api/me/git-token',{method:'DELETE',headers})).status,403);
 const mcp=await call('/api/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal(mcp.status,200);assert.ok((await mcp.json() as any).result.tools.some((t:any)=>t.name==='create_or_update_page'));
 const authContext:any={env,req:{header:()=>headers.Authorization},executionCtx:ctx};assert.equal((await resolveBearerAuth(authContext)).kind,'authenticated');
 const {DISAMBIGUATION_MARKER}=await import('../packages/wiki-shared/src/markup/disambiguation');
 env.TURNSTILE_SECRET_KEY='test-secret';
 const body=DISAMBIGUATION_MARKER+'\nName may refer to:\n- [[Meaning one]]\n- [[Meaning two]]';
 const updated=await call('/api/w/Public',{method:'PUT',headers,body:JSON.stringify({content:body,version:1,summary:'Mark disambiguation'})});assert.equal(updated.status,200,await updated.text());
 const readPage=await call('/api/w/Public?for_edit=true',{headers});assert.equal(readPage.status,200);const saved:any=await readPage.json();assert.equal(saved.is_disambiguation,true);assert.equal(saved.content,body);
 const conflict=await call('/api/w/Public',{method:'PUT',headers,body:JSON.stringify({content:body,version:2,redirect_to:'Other'})});assert.equal(conflict.status,400);
 const rev=sql.prepare('SELECT content,r2_key FROM revisions WHERE page_id=1 ORDER BY id DESC LIMIT 1').get() as any;assert.equal(rev.r2_key?objects.get(rev.r2_key):rev.content,body);
 // Bearer writes work without browser Origin; ordinary cookie writes still require same-origin.
 assert.equal((await call('/api/me/api-token',{method:'POST',headers:{Cookie:'wiki_session=browser',Origin:'https://evil.example','Content-Type':'text/plain'},body:'{}'})).status,403);
 const invalid=await call('/api/me/api-token',{method:'POST',headers:browser,body:JSON.stringify({expires_at:now-1})});assert.equal(invalid.status,400);assert.ok(await authenticatePersonalToken(env,data.token));
 sql.exec("UPDATE users SET role='admin' WHERE id=1");assert.equal((await authenticatePersonalToken(env,data.token))!.role,'admin');
 sql.exec("UPDATE users SET role='banned',banned_until=NULL WHERE id=1");assert.equal(await authenticatePersonalToken(env,data.token),null);assert.equal((await call('/api/me',{headers})).status,401);
 sql.exec("UPDATE users SET role='user' WHERE id=1;UPDATE git_tokens SET expires_at=unixepoch() WHERE user_id=1");assert.equal(await authenticatePersonalToken(env,data.token),null);
 const forever=await call('/api/me/api-token',{method:'POST',headers:browser,body:'{"expires_at":0}'});assert.equal(forever.status,200);const indefinite:any=await forever.json();assert.equal(indefinite.expires_at,0);assert.ok(await authenticatePersonalToken(env,indefinite.token));assert.equal(await authenticatePersonalToken(env,data.token),null);
 const legacy='git_'+'a'.repeat(64);sql.prepare('UPDATE git_tokens SET token_hash=?,expires_at=? WHERE user_id=1').run(await sha256Hex(legacy),now+120);assert.ok(await authenticatePersonalToken(env,legacy));
 assert.equal((await call('/api/me/git-token',{method:'DELETE',headers:browser})).status,200);assert.equal(await authenticatePersonalToken(env,legacy),null);
 await Promise.all(waits);sql.close();
});


test('disambiguation markers preserve source and ignore inline/code examples', async () => {
 const {DISAMBIGUATION_MARKER,isDisambiguation,setDisambiguation,stripDisambiguation}=await import('../packages/wiki-shared/src/markup/disambiguation');
 const body='- [[Meaning one]]\n- [[Meaning two]]';const marked=setDisambiguation(body,true);
 assert.equal(isDisambiguation(marked),true);assert.equal(stripDisambiguation(marked),body);assert.equal(setDisambiguation(marked,true),marked);assert.equal(setDisambiguation(marked,false),body);
 assert.equal(isDisambiguation('```html\n'+DISAMBIGUATION_MARKER+'\n```'),false);assert.equal(isDisambiguation('Example: '+DISAMBIGUATION_MARKER),false);
 assert.equal(isDisambiguation('\uFEFF\n'+marked.replace(/\n/g,'\r\n')),true);
 const {renderForAI}=await import('../src/utils/aiParser');const text=await renderForAI(marked,{} as any);assert.ok(!text.includes(DISAMBIGUATION_MARKER));assert.ok(text.includes('[[Meaning one]]'));assert.ok(text.length>body.length);
});
