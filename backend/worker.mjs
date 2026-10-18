const enc = new TextEncoder();
async function digest(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value)))).map(v=>v.toString(16).padStart(2,'0')).join(''); }
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
export default {async fetch(req,env){
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
  if(input.username!=='admin01'||typeof input.password!=='string'||!await equal(input.password,env.ADMIN_PASSWORD))return reply({error:'帳號或密碼不正確'},401);
  const bytes=crypto.getRandomValues(new Uint8Array(32));const token=Array.from(bytes).map(x=>x.toString(16).padStart(2,'0')).join('');
  await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE expires<?').bind(now),env.DB.prepare('DELETE FROM attempts WHERE started<?').bind(now-900),env.DB.prepare('INSERT INTO sessions(token,expires) VALUES(?,?)').bind(await digest(token),now+28800)]);
  return reply({token,expires:now+28800});
 }
 if(path==='/state'&&req.method==='GET'){
  const row=await env.DB.prepare('SELECT version,data FROM room WHERE id=1').first();return reply({version:row.version,state:JSON.parse(row.data)});
 }
 if((path==='/state'&&req.method==='PUT')||(path==='/logout'&&req.method==='POST')){
  const bearer=req.headers.get('Authorization')||'';if(!/^Bearer [a-f0-9]{64}$/.test(bearer))return reply({error:'Login required'},401);
  const hashed=await digest(bearer.slice(7));const session=await env.DB.prepare('SELECT expires FROM sessions WHERE token=?').bind(hashed).first();if(!session||session.expires<=now)return reply({error:'Session expired'},401);
  if(path==='/logout'){await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(hashed).run();return reply({ok:true});}
  if(Number(req.headers.get('content-length'))>100000)return reply({error:'Too large'},413);
  const text=await req.text();if(text.length>100000)return reply({error:'Too large'},413);const body=JSON.parse(text);
  if(!Number.isSafeInteger(body.version)||body.version<0||!validate(body.state))return reply({error:'Invalid room data'},400);
  const result=await env.DB.prepare('UPDATE room SET version=version+1,data=? WHERE id=1 AND version=? RETURNING version').bind(JSON.stringify(body.state),body.version).first();
  if(!result)return reply({error:'其他員工已更新資料，請查看最新狀態後重試。'},409);
  return reply({version:result.version});
 }
 return reply({error:'Not found'},404);
 }catch(e){return reply({error:e instanceof SyntaxError?'Invalid JSON':'Service error'},e instanceof SyntaxError?400:500);}
}};
