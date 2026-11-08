import { isMemberApi, handleMembersApi, handleRegister, ingestPpm } from './members.mjs';
import { handleMemberApp, handlePromotions } from './member-app.mjs';
import { handleStaff } from './staff.mjs';
import { handleOperation, recordTableRuns, handleTableRuns, handleAnnounce, handleLineupPublic } from './operation.mjs';
import { handleReport } from './report.mjs';
import { handleInsurance } from './insurance.mjs';
import { auditStmt, ppmChanges, handleAudit } from './audit.mjs';
const enc = new TextEncoder();
// Master accounts are fixed in wrangler.toml (MASTER_USERS) so nobody can grant themselves master from the console.
const isMaster=(env,u)=>!!u&&(env.MASTER_USERS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean).includes(String(u).toLowerCase());
async function digest(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value)))).map(v=>v.toString(16).padStart(2,'0')).join(''); }
async function pbkdf2(password,saltHex,iterations){const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:new Uint8Array(saltHex.match(/../g).map(h=>parseInt(h,16))),iterations},key,256);return Array.from(new Uint8Array(bits)).map(v=>v.toString(16).padStart(2,'0')).join('');}
async function equal(a,b){const x=await digest(a),y=await digest(b);let d=0;for(let i=0;i<x.length;i++)d|=x.charCodeAt(i)^y.charCodeAt(i);return d===0;}
const blinds=['25 / 50','50 / 50','50 / 100','100 / 100','100 / 200'], types=['NLH','PLO','Others'];
export const initial=()=>({queue:[],counters:Object.fromEntries(types.flatMap(t=>blinds.map(b=>[b+' '+t,1]))),occupied:Array.from({length:4},()=>Array(9).fill(0)),games:['50 / 100','50 / 100','100 / 200','25 / 50'],tableTypes:['NLH','NLH','NLH','NLH'],calls:{},count:'4'});
function validate(s){
 const keys=Object.keys(initial().counters);const person=p=>p&&keys.includes(p.game)&&Number.isSafeInteger(p.num)&&p.num>0&&typeof p.name==='string'&&p.name.trim().length>0&&p.name.length<=60&&(!p.seated||typeof p.seated==='string'&&p.seated.length<80);
 if(!s||!Array.isArray(s.queue)||s.queue.length>500||!s.queue.every(person))return false;
 if(!s.counters||!keys.every(k=>Number.isSafeInteger(s.counters[k])&&s.counters[k]>0))return false;
 if(new Set(s.queue.map(p=>p.game+':'+p.num)).size!==s.queue.length)return false;
 if(!Array.isArray(s.occupied)||s.occupied.length!==4||!s.occupied.every(a=>Array.isArray(a)&&a.length===9&&a.every(v=>[0,1,true,false].includes(v))))return false;
 if(!Array.isArray(s.games)||s.games.length!==4||!s.games.every(b=>blinds.includes(b)))return false;
 if(!Array.isArray(s.tableTypes)||s.tableTypes.length!==4||!s.tableTypes.every(t=>types.includes(t)))return false;
 if(!s.calls||typeof s.calls!=='object'||Array.isArray(s.calls)||!Object.entries(s.calls).every(([k,p])=>keys.includes(k)&&person(p)&&p.game===k))return false;
 if(!keys.every(k=>s.counters[k]>Math.max(0,...s.queue.filter(p=>p.game===k).map(p=>p.num),s.calls[k]?.num||0)))return false;
 return ['1','2','3','4'].includes(String(s.count));
}
// Safety net: every few minutes, copy any finished PPM session that a save could not record.
async function scheduledSync(env){const row=await env.DB.prepare('SELECT data FROM ppm WHERE id=1').first();if(!row)return;const now=Math.floor(Date.now()/1000);
 try{const r=await ingestPpm(env,JSON.parse(row.data),now);if(r.inserted)await auditStmt(env,now,'system','ppm.sync_retry','Recorded '+r.inserted+' finished session(s) on the automatic check').run();}
 catch(e){await auditStmt(env,now,'system','ppm.sync_error','Automatic check failed: '+String(e&&e.message||e).slice(0,200)).run();}}
export default {async scheduled(event,env,ctx){ctx.waitUntil(scheduledSync(env));},async fetch(req,env){
 const origin=req.headers.get('Origin');const allowed=(env.ALLOWED_ORIGINS||'https://everestpokerroom.com,https://www.everestpokerroom.com').split(',').map(s=>s.trim());
 const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin'};
 if(origin&&allowed.includes(origin))Object.assign(headers,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET,PUT,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'});
 const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
 if(origin&&!allowed.includes(origin))return reply({error:'Origin not allowed'},403);
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 try{
 const path=new URL(req.url).pathname.replace(/\/$/,'');const now=Math.floor(Date.now()/1000);
 if(path==='/login'&&req.method==='POST'){
  if(!env.ADMIN_PASSWORD)return reply({error:'Server password not configured'},503);
  const length=Number(req.headers.get('content-length'));if(length>2048)return reply({error:'Too large'},413);
  const ip=await digest(req.headers.get('CF-Connecting-IP')||'unknown');
  const attempt=await env.DB.prepare('INSERT INTO attempts (ip,started,count) VALUES (?,?,1) ON CONFLICT(ip) DO UPDATE SET count=CASE WHEN started<? THEN 1 ELSE count+1 END,started=CASE WHEN started<? THEN ? ELSE started END RETURNING count').bind(ip,now,now-900,now-900,now).first();
  if(attempt.count>10)return reply({error:'Too many attempts. Try again in 15 minutes.'},429);
  const body=await req.text();if(body.length>2048)return reply({error:'Too large'},413);const input=JSON.parse(body);
  const username=typeof input.username==='string'?input.username.trim():'';
  if(!username||username.length>60||typeof input.password!=='string'||input.password.length>200)return reply({error:'帳號或密碼不正確'},401);
  // Staff accounts live in D1. admin01 + ADMIN_PASSWORD keeps working only until an admin01 staff row exists.
  const staff=await env.DB.prepare('SELECT username,display_name,pw_hash,salt,iterations,active,role FROM staff WHERE username=?').bind(username).first();
  let user=null,role='admin';
  if(staff){if(staff.active&&await equal(await pbkdf2(input.password,staff.salt,staff.iterations),staff.pw_hash)){user=staff.display_name;role=isMaster(env,staff.username)?'master':staff.role==='staff'?'staff':'admin';}}
  else if(username.toLowerCase()==='admin01'&&env.ADMIN_PASSWORD&&await equal(input.password,env.ADMIN_PASSWORD)){user='admin01';role=isMaster(env,'admin01')?'master':'admin';}
  if(!user){try{await auditStmt(env,now,username.slice(0,60),'staff.login_failed','Wrong password or disabled account').run();}catch(e){}return reply({error:'帳號或密碼不正確'},401);}
  const bytes=crypto.getRandomValues(new Uint8Array(32));const token=Array.from(bytes).map(x=>x.toString(16).padStart(2,'0')).join('');const hashed=await digest(token);
  await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE expires<?').bind(now),env.DB.prepare('DELETE FROM session_users WHERE token NOT IN (SELECT token FROM sessions)'),env.DB.prepare('DELETE FROM attempts WHERE started<? OR ip=?').bind(now-900,ip),env.DB.prepare('INSERT INTO sessions(token,expires) VALUES(?,?)').bind(hashed,now+28800),env.DB.prepare('INSERT OR REPLACE INTO session_users(token,username,role) VALUES(?,?,?)').bind(hashed,user,role)]);
  try{await auditStmt(env,now,user,'staff.login','Signed in').run();}catch(e){}
  return reply({token,expires:now+28800,user,role});
 }
 if(path==='/lineup'&&req.method==='GET')return handleLineupPublic(req,env,now);
 if(path.startsWith('/member/')){
  if(Number(req.headers.get('content-length'))>5000)return reply({error:'Too large'},413);
  return handleMemberApp(req,env,path,now,reply,await digest('member:'+(req.headers.get('CF-Connecting-IP')||'unknown')));
 }
 if(path==='/register'&&req.method==='POST'){
  if(Number(req.headers.get('content-length'))>5000)return reply({error:'Too large'},413);
  // Online registration is turned off: members are added by staff in the console.
  return reply({error:'Online registration is closed. Please register at the counter.'},410);
 }
 if(path==='/state'&&req.method==='GET'){
  const row=await env.DB.prepare('SELECT version,data FROM room WHERE id=1').first();return reply({version:row.version,state:JSON.parse(row.data)});
 }
 if((path==='/state'&&req.method==='PUT')||(path==='/logout'&&req.method==='POST')||(path==='/ppm'&&['GET','PUT'].includes(req.method))||path==='/me'||path==='/promotions'||path.startsWith('/promotions/')||path==='/staff'||path.startsWith('/staff/')||path==='/operation'||path.startsWith('/operation/')||path==='/report'||path.startsWith('/report/')||path==='/audit'||path==='/announce'||path==='/insurance'||path.startsWith('/insurance/')||isMemberApi(path)){
  const bearer=req.headers.get('Authorization')||'';if(!/^Bearer [a-f0-9]{64}$/.test(bearer))return reply({error:'Login required'},401);
  const hashed=await digest(bearer.slice(7));const session=await env.DB.prepare('SELECT expires FROM sessions WHERE token=?').bind(hashed).first();if(!session||session.expires<=now)return reply({error:'Session expired'},401);
  if(path==='/logout'){await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(hashed),env.DB.prepare('DELETE FROM session_users WHERE token=?').bind(hashed)]);return reply({ok:true});}
  const owner=await env.DB.prepare('SELECT username,role FROM session_users WHERE token=?').bind(hashed).first();const user=owner?owner.username:null,role=isMaster(env,user)?'master':owner?owner.role:'admin';
  if(path==='/me')return reply({user,role});
  if(path==='/operation'&&req.method==='GET')return handleOperation(req,env,now,reply,role);
  if(path==='/announce'&&['GET','POST'].includes(req.method))return handleAnnounce(req,env,now,reply,user);
  if(path==='/audit'&&req.method==='GET')return handleAudit(req,env,now,reply,role);
  if(path.startsWith('/operation/')){const res=await handleTableRuns(req,env,path,now,reply,user,role);return res||reply({error:'Not found'},404);}
  if(path==='/insurance'||path.startsWith('/insurance/')){const res=await handleInsurance(req,env,path,now,reply,user,role);return res||reply({error:'Not found'},404);}
  if(path==='/report'||path.startsWith('/report/')){const res=await handleReport(req,env,path,now,reply,user,role);return res||reply({error:'Not found'},404);}
  if(path==='/staff'||path.startsWith('/staff/')){const res=await handleStaff(req,env,path,now,reply,user,role,u=>isMaster(env,u));return res||reply({error:'Not found'},404);}
  if(path==='/promotions'||path.startsWith('/promotions/')){const res=await handlePromotions(req,env,path,now,reply,role!=='staff',user);return res||reply({error:'Not found'},404);}
  if(isMemberApi(path)){const res=await handleMembersApi(req,env,path,now,reply,user,role);return res||reply({error:'Not found'},404);}
  if(path==='/ppm'){
   const row=await env.DB.prepare('SELECT version,data FROM ppm WHERE id=1').first();
   if(req.method==='GET')return reply({version:row.version,tables:JSON.parse(row.data)});
   const raw=await req.text();if(raw.length>2000000)return reply({error:'Too large'},413);
   const body=JSON.parse(raw),ts=body.tables;
   if(!Number.isSafeInteger(body.version)||!Array.isArray(ts)||ts.length!==4||!ts.every((t,i)=>t.id===i+1&&typeof t.isRunning==='boolean'&&blinds.includes(t.blinds)&&types.includes(t.gameType)&&Array.isArray(t.seats)&&t.seats.length===9&&t.seats.every((s,j)=>s.id===j+1&&['idle','seated','rest'].includes(s.status)&&typeof s.memberId==='string'&&s.memberId.length<=60)&&Array.isArray(t.sessions)))return reply({error:'Invalid PPM data'},400);
   const members=ts.flatMap(t=>t.seats.filter(s=>s.status!=='idle').map(s=>s.memberId));
   if(members.some(m=>!m.trim())||new Set(members).size!==members.length)return reply({error:'Member already seated or missing ID'},400);
   const room=await env.DB.prepare('SELECT version,data FROM room WHERE id=1').first();const state=JSON.parse(room.data);
   state.occupied=ts.map(t=>t.seats.map(s=>t.isRunning&&s.status!=='idle'?1:0));
   state.games=ts.map(t=>t.blinds);state.tableTypes=ts.map(t=>t.gameType);state.tableOpen=ts.map(t=>t.isRunning);state.count='4';
   const results=await env.DB.batch([
    env.DB.prepare('UPDATE ppm SET version=version+1,data=? WHERE id=1 AND version=? AND (SELECT version FROM room WHERE id=1)=?').bind(JSON.stringify(ts),body.version,room.version),
    env.DB.prepare('UPDATE room SET version=version+1,data=? WHERE id=1 AND changes()=1').bind(JSON.stringify(state))
   ]);
   if(!results[0].meta.changes)return reply({error:'Another staff member updated the room. Reload and retry.'},409);
   // Copy finished seat sessions into member play time. Never blocks the PPM save; missed rows are picked up on the next save.
   let sync={inserted:0};try{sync=await ingestPpm(env,ts,now);}catch(e){sync={error:String(e&&e.message||e).slice(0,200)};try{await auditStmt(env,now,user||'staff','ppm.sync_error','Could not copy finished PPM sessions: '+sync.error).run();}catch(e2){}}
   try{await recordTableRuns(env,ts,now);}catch(e){}
   try{const ch=ppmChanges(JSON.parse(row.data),ts);if(ch.length)await env.DB.batch(ch.slice(0,60).map(c=>auditStmt(env,now,user||'staff',c.action,c.detail)));}catch(e){}
   return reply({version:body.version+1,tables:ts,sync});
  }
  if(Number(req.headers.get('content-length'))>100000)return reply({error:'Too large'},413);
  const text=await req.text();if(text.length>100000)return reply({error:'Too large'},413);const body=JSON.parse(text);
  if(!Number.isSafeInteger(body.version)||body.version<0||!validate(body.state))return reply({error:'Invalid room data'},400);
  const ppm=await env.DB.prepare('SELECT version,data FROM ppm WHERE id=1').first();
  if(ppm&&ppm.version>0){const room=await env.DB.prepare('SELECT version,data FROM room WHERE id=1').first();const live=JSON.parse(room.data);for(const key of ['occupied','games','tableTypes','tableOpen','count'])body.state[key]=live[key];}
  const result=await env.DB.prepare('UPDATE room SET version=version+1,data=? WHERE id=1 AND version=? RETURNING version').bind(JSON.stringify(body.state),body.version).first();
  if(!result)return reply({error:'其他員工已更新資料，請查看最新狀態後重試。'},409);
  return reply({version:result.version});
 }
 return reply({error:'Not found'},404);
 }catch(e){if(e&&e.status===413)return reply({error:'Too large'},413);return reply({error:e instanceof SyntaxError?'Invalid JSON':'Service error'},e instanceof SyntaxError?400:500);}
}};

