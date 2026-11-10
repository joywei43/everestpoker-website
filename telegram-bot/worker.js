// Pure notification rules. No credentials or Telegram calls belong here.
export const IDS = ['T1', 'T2', 'T3', 'T5'];
export const THANK_YOU = `THANK YOU FOR PLAYING AT EVEREST POKER! ♠️
A huge thank you to all our players who joined us and made tonight’s action exciting! 🔥
We truly appreciate your support and the great energy at the tables. 🙌
See you again for more big hands, big action, and great poker moments! 🃏`;
export function readTables(state) {
  if (!state || !Array.isArray(state.tableOpen) || state.tableOpen.length !== 4) throw new Error('Missing PPM table state');
  return IDS.map((id, i) => {
    const seats = state.occupied?.[i], game = state.tableTypes?.[i], stakes = state.games?.[i];
    if (typeof state.tableOpen[i] !== 'boolean' || !Array.isArray(seats) || seats.length !== 9 || !seats.every(v => [0, 1, true, false].includes(v)) || !['NLH','PLO','Others'].includes(game) || typeof stakes !== 'string') throw new Error('Invalid PPM table state');
    return { id, open: state.tableOpen[i], players: seats.filter(Boolean).length, game, stakes: stakes.replace(/\s/g, ''), capacity: 9 };
  });
}

// Commit the returned state only after the corresponding notification is accepted.
// A caller must serialize transitions and persist state across restarts.
export function transition(previous = {}, tables, now) {
  const before = previous.tables || [];
  const pending = new Set(previous.pending || []);
  const ready = new Set(previous.ready || []);
  const newlyReady = [], increases = [], full = [];
  for (const t of tables) {
    const old = before.find(x => x.id === t.id);
    if (!t.open) { pending.delete(t.id); ready.delete(t.id); continue; }
    if (!old?.open) { pending.add(t.id); ready.delete(t.id); }
    if (pending.has(t.id) && t.players >= 5) {
      pending.delete(t.id); ready.add(t.id); newlyReady.push(t.id);
      if (t.players === t.capacity) full.push(t.id);
    } else if (ready.has(t.id) && old?.open && t.players > old.players && t.players >= 5) {
      increases.push(t.id);
      if (t.players === t.capacity) full.push(t.id);
    }
  }
  const active = tables.some(t => t.open);
  const publishable = tables.some(t => t.open && t.players >= 5);
  const local = new Date((now + 8 * 3600) * 1000);
  const closingDay = local.toISOString().slice(0, 10);
  const lastTableClosed = before.some(t => t.open) && !active;
  // A closure before 04:00 persists until the first successful poll at/after 04:00.
  let pendingThanksDay = previous.pendingThanksDay === closingDay ? closingDay : null;
  if (active) pendingThanksDay = null;
  else if (lastTableClosed) pendingThanksDay = closingDay;
  const thankYou = !active && pendingThanksDay === closingDay && local.getUTCHours() >= 4 && previous.thankedDay !== closingDay;
  if (thankYou || previous.thankedDay === closingDay) pendingThanksDay = null;
  const groupDue = publishable && (newlyReady.length > 0 || (previous.groupAt != null && now - previous.groupAt >= 3600));
  const channelDue = publishable && (newlyReady.length > 0 || increases.length > 0 || (previous.channelAt != null && now - previous.channelAt >= 1800));
  return {
    // Common event, delivered once to each distinct configured destination.
    common: thankYou ? { reason: 'last-table-closed', key: `thanks:${closingDay}`, text: THANK_YOU } : null,
    group: groupDue ? { reason: newlyReady.length ? 'new-table' : 'periodic', tables: newlyReady } : null,
    channel: channelDue ? { reason: full.length ? 'full' : newlyReady.length ? 'new-table' : increases.length ? 'increase' : 'periodic', tables: [...newlyReady, ...increases], full } : null,
    state: { tables, pendingThanksDay, pending: [...pending], ready: [...ready], groupAt: groupDue ? now : previous.groupAt ?? null, channelAt: channelDue ? now : previous.channelAt ?? null, thankedDay: thankYou ? closingDay : previous.thankedDay ?? null }
  };
}

// The lineup post (same wording as the member system's Telegram post page). lineupTables comes from
// everest-waiting-api /lineup?format=json and only adds nationality counts; seats come from the PPM state.
export function lineupMessage(selected, lineupTables, tables) {
  const bl = (s) => String(s || '').replace(/\s/g, '').replace(/\//g, '-');
  const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'TH' : ({ 1: 'ST', 2: 'ND', 3: 'RD' })[n % 10] || 'TH');
  const open = tables.filter((t) => t.open);
  const allFull = open.length > 0 && open.every((t) => t.players >= t.capacity);
  // Level and game come from PPM (the live table) when the lineup has them; the waiting-list copy can lag behind a table move.
  selected = selected.map((t) => { const l = (lineupTables || []).find((x) => x.name === t.id); return l && l.blinds && l.game_type ? { ...t, stakes: l.blinds, game: l.game_type } : t; });
  const games = [...new Set(selected.map((t) => `${bl(t.stakes)} ${t.game}`))];
  const L = ['🔥 THE ACTION IS ON AT EVEREST POKER! 🃏🔥', 'Check our Latest Update on website:', 'www.everestpokerroom.com/waiting-list', '',
    ` ${selected.length} TABLE${selected.length === 1 ? '' : 'S'} ONGOING – ${games.join(' & ')}`, '👥 Current Lineup:'];
  for (const t of selected) {
    const l = (lineupTables || []).find((x) => x.name === t.id);
    const seats = Math.max(0, t.capacity - t.players);
    L.push('', ` TABLE ${t.id.slice(1)} ${bl(t.stakes)} ${t.game}`, '');
    if (l && Array.isArray(l.nationalities) && l.nationalities.length) {
      for (const n of l.nationalities) L.push(`${n.count} ${n.nationality ? n.nationality + ' ' : 'Other '}${n.count === 1 ? 'Player' : 'Players'}`);
    } else L.push(`${t.players} ${t.players === 1 ? 'Player' : 'Players'} Seated`);
    if (seats) L.push(`(${seats} ${seats === 1 ? 'SEAT' : 'SEATS'} OPEN )`);
    else {
      const waiting = l && l.waiting ? l.waiting : 0;
      L.push(`(TABLE FULL${waiting ? ` – ${waiting} ON THE WAITING LIST` : ' – JOIN THE WAITING LIST'} )`);
      if (allFull) L.push(`SEAT OPEN FOR ${ordinal(open.length + 1)} TABLE`);
    }
  }
  L.push('', '', '🔥 Reserve your seat, players!', 'Come join the action at Everest Poker!🃏♠️♥️♣️');
  return L.join('\n');
}

export function message(tables, now, { filter = 'all', full = [], minPlayers = 0, periodic = false, lineup = null } = {}) {
  const date = new Date(now * 1000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(p => [p.type,p.value]));
  const lines = ['EVEREST POKER LIVE TABLES', `TIME: ${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`, ''];
  const selected = tables.filter(t => t.open && t.players >= minPlayers && (filter === 'all' || t.game === filter));
  if (selected.length) return lineupMessage(selected, lineup, tables);
  if (periodic) {
    const games = new Map();
    for (const table of selected) {
      const game = `${table.stakes.replace(/\//g, '-')} ${table.game}`;
      games.set(game, (games.get(game) ?? 0) + 1);
    }
    return [
      '🔥 THE ACTION IS ON AT EVEREST POKER! 🃏🔥',
      'Check our Latest Update on website:',
      'https://www.everestpokerroom.com/waiting-list/',
      '',
      ...Array.from(games, ([game, count]) => `${count} ${count === 1 ? 'TABLE' : 'TABLES'} ONGOING – ${game}`),
      '👥 Current Lineup:',
      ...selected.flatMap(table => {
        const seats = table.capacity - table.players;
        return [
          '',
          `TABLE ${table.id.slice(1)} ${table.stakes.replace(/\//g, '-')} ${table.game}`,
          '',
          `${table.players} Players Seated`,
          `(${seats} ${seats === 1 ? 'SEAT' : 'SEATS'} OPEN)`,
        ];
      }),
      '',
      '🔥 Reserve your seat, players!',
      'Come join the action at Everest Poker! 🃏♠️❤️♣️',
      'Contact: @midoripokerroom',
    ].join('\n');
  }
  for (const t of selected) {
    lines.push(`${t.id} · ${t.game} ${t.stakes} · ${t.players}/${t.capacity} players${full.includes(t.id) ? ' · TABLE FULL' : ''}`);
  }
  if (!selected.length) lines.push('No tables currently open.');
  if (selected.some(t => full.includes(t.id) && !tables.some(other => other.id !== t.id && other.open && other.game === t.game && other.stakes === t.stakes))) lines.push('Reservations are now open for a second table.');
  lines.push('', 'https://www.everestpokerroom.com/waiting-list/', 'Contact : @midoripokerroom to reserve your seat');
  return lines.join('\n');
}


export function dailyInvitation(time) {
  const local = new Date((time + 8 * 3600) * 1000);
  // Catch a missed 16:00 tick during the same hour, without sending late-night catch-ups.
  if (local.getUTCHours() !== 16) return null;
  return {
    day: local.toISOString().slice(0, 10),
    text: `♠️ POKER TONIGHT AT EVEREST!

Get ready for tonight’s poker action! Join us at Everest Poker Room, Midori Clark, 2F.

Bring your friends and enjoy a great night at the tables!

Telegram: @MIDORIPOKER
Contact us for game details and seat reservations.
https://www.everestpokerroom.com/waiting-list/`
  };
}

export const SCHEMA = "CREATE TABLE IF NOT EXISTS bot_runtime (\n id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL DEFAULT '{}',\n lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0\n);\nINSERT OR IGNORE INTO bot_runtime(id) VALUES(1);\nCREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);\nCREATE TABLE IF NOT EXISTS bot_subscribers (id TEXT PRIMARY KEY,filter TEXT NOT NULL CHECK(filter IN ('all','NLH','PLO','off')));\nCREATE TABLE IF NOT EXISTS bot_destinations (id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('group','channel')),title TEXT NOT NULL DEFAULT '');\nCREATE TABLE IF NOT EXISTS bot_updates (id INTEGER PRIMARY KEY,created INTEGER NOT NULL);\nCREATE TABLE IF NOT EXISTS bot_jobs (\n id TEXT PRIMARY KEY, target TEXT NOT NULL, stream TEXT NOT NULL,\n method TEXT NOT NULL DEFAULT 'sendMessage', payload TEXT NOT NULL,\n created INTEGER NOT NULL, due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,\n status TEXT NOT NULL DEFAULT 'pending', error TEXT\n);\nCREATE INDEX IF NOT EXISTS bot_jobs_due ON bot_jobs(status,due);\n";


const SOURCE='https://everest-waiting-api.drumsjw47.workers.dev/state';
const USERNAME='EverestPokerRoomBot';
const now=()=>Math.floor(Date.now()/1000);
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const setting=async(db,key,fallback='')=>(await db.prepare('SELECT value FROM bot_settings WHERE key=?').bind(key).first())?.value??fallback;
const set=(db,key,value)=>db.prepare('INSERT INTO bot_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,String(value));

export async function source(env={},fetcher=fetch) {
  // Service bindings avoid public Worker-to-Worker routing restrictions.
  if(env.PPM_API && typeof env.PPM_API.fetch!=='function')throw new Error('SOURCE_BINDING_INVALID');
  const read=env.PPM_API ? (url,options)=>env.PPM_API.fetch(url,options) : fetcher;
  const r=await read(SOURCE,{headers:{Accept:'application/json','User-Agent':'EverestTelegramBot/2.0'},signal:AbortSignal.timeout(8000),cache:'no-store'});
  if(!r.ok)throw new Error('SOURCE_HTTP_'+r.status);
  const raw=await r.text();if(raw.length>200000)throw new Error('SOURCE_TOO_LARGE');
  return readTables(JSON.parse(raw).state);
}
const LINEUP='https://everest-waiting-api.drumsjw47.workers.dev/lineup?format=json';
// Nationality counts per table. Optional: if it fails, messages fall back to "N Players Seated".
export async function lineupSource(env={},fetcher=fetch) {
  try{
    const read=env.PPM_API && typeof env.PPM_API.fetch==='function' ? (url,options)=>env.PPM_API.fetch(url,options) : fetcher;
    const r=await read(LINEUP,{headers:{Accept:'application/json','User-Agent':'EverestTelegramBot/2.1'},signal:AbortSignal.timeout(8000),cache:'no-store'});
    if(!r.ok)return null;
    const j=await r.json();return Array.isArray(j.tables)?j.tables:null;
  }catch{return null;}
}
async function telegram(env,method,payload) {
  // Do not log request URLs or raw exceptions: the Telegram URL contains the bot token.
  try {
    const r=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
    const b=await r.json();
    if(!b.ok)return {ok:false,code:Number(b.error_code)||r.status,retry:Math.min(3600,Math.max(5,Number(b.parameters?.retry_after)||0))};
    return {ok:true,result:b.result};
  }catch{return {ok:false,code:0,retry:60};}
}
async function same(a,b) {
  const digest=async s=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
  const x=await digest(a),y=await digest(b);let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];return d===0;
}
function job(db,id,target,stream,text,time,extra={}) {
  const payload={chat_id:target,text,link_preview_options:{is_disabled:true},...extra};
  return db.prepare('INSERT OR IGNORE INTO bot_jobs(id,target,stream,payload,created,due) VALUES(?,?,?,?,?,?)').bind(id,String(target),stream,JSON.stringify(payload),time,time);
}
async function leased(db,fn) {
  const token=crypto.randomUUID(),time=now();
  const row=await db.prepare('UPDATE bot_runtime SET lease=?,lease_until=? WHERE id=1 AND lease_until<=? RETURNING id').bind(token,time+180,time).first();
  if(!row)return false;
  try{await fn();return true;}finally{await db.prepare('UPDATE bot_runtime SET lease=NULL,lease_until=0 WHERE id=1 AND lease=?').bind(token).run();}
}

export async function poll(env) {
  const db=env.DB;
  if(await setting(db,'connected')!=='1')return;
  await leased(db,async()=>{
    const time=now();
    if(await setting(db,'enabled')==='1') {
      const tables=await source(env);
      const lineup=await lineupSource(env);
      const previous=JSON.parse((await db.prepare('SELECT data FROM bot_runtime WHERE id=1').first()).data);
      const event=transition(previous,tables,time);
      const sequence=(previous.sequence||0)+1;
      event.state.sequence=sequence;
      const active=tables.some(t=>t.open);
      const subscribers=(await db.prepare("SELECT * FROM bot_subscribers WHERE filter!='off'").all()).results;
      const destinations=(await db.prepare('SELECT * FROM bot_destinations').all()).results;
      const statements=[];
      const invitation=dailyInvitation(time);
      if(invitation)for(const r of destinations)statements.push(job(db,`invitation:${invitation.day}:${r.id}`,r.id,'invitation',invitation.text,time));
      const pending=(await db.prepare("SELECT DISTINCT stream FROM bot_jobs WHERE status='pending'").all()).results.map(r=>r.stream);
      // Group clocks are updated on Telegram acceptance, rather than enqueue time.
      event.state.groupAt=previous.groupAt??null;
      event.state.channelAt=previous.channelAt??null;
      if(!active)statements.push(db.prepare("UPDATE bot_jobs SET status='cancelled' WHERE status='pending' AND stream IN ('group','channel')"));
      if(event.common) {
        const targets=new Set([...subscribers.map(r=>r.id),...destinations.map(r=>r.id)]);
        for(const target of targets)statements.push(job(db,`${event.common.key}:${target}`,target,'common',event.common.text,time));
      }
      const eligible=(e,stream)=>e && (e.reason!=='periodic'||!pending.includes(stream));
      if(eligible(event.group,'group')) {
        for(const r of subscribers) {
          if(!tables.some(t=>t.open&&t.players>=5&&(r.filter==='all'||r.filter===t.game)))continue;
          if(event.group.reason==='new-table'&&!tables.some(t=>event.group.tables.includes(t.id)&&(r.filter==='all'||r.filter===t.game)))continue;
          statements.push(job(db,`group:${sequence}:${r.id}`,r.id,'group',message(tables,time,{filter:r.filter,minPlayers:5,periodic:event.group.reason==='periodic',lineup}),time));
        }
        for(const r of destinations.filter(r=>r.kind==='group'))statements.push(job(db,`group:${sequence}:${r.id}`,r.id,'group',message(tables,time,{minPlayers:5,periodic:event.group.reason==='periodic',lineup}),time));
      }
      if(eligible(event.channel,'channel'))for(const r of destinations.filter(r=>r.kind==='channel'))statements.push(job(db,`channel:${sequence}:${r.id}`,r.id,'channel',message(tables,time,{...event.channel,minPlayers:5,periodic:event.channel.reason==='periodic',lineup}),time));
      statements.push(db.prepare('UPDATE bot_runtime SET data=? WHERE id=1').bind(JSON.stringify(event.state)));
      await db.batch(statements);
    }
    await flush(env);
    // Old-row cleanup once an hour, not every minute: each run scans the tables and D1 counts every row read.
    if(Math.floor(time/60)%60===0)await db.batch([db.prepare('DELETE FROM bot_updates WHERE created<?').bind(time-7*86400),db.prepare("DELETE FROM bot_jobs WHERE created<? AND status!='pending'").bind(time-7*86400)]);
  });
}

async function flush(env) {
  const db=env.DB,time=now();
  // Bounded sends keep a single run within its lease; remaining jobs persist for next tick.
  const rows=(await db.prepare("SELECT * FROM bot_jobs WHERE status='pending' AND due<=? ORDER BY created,id LIMIT 6").bind(time).all()).results;
  for(const r of rows) {
    if(time-r.created>(r.stream==='common'?21600:1800)) {
      await db.prepare("UPDATE bot_jobs SET status='expired' WHERE id=?").bind(r.id).run();continue;
    }
    const payload=JSON.parse(r.payload);
    if(['group','channel'].includes(r.stream)) {
      const snapshot=JSON.parse((await db.prepare('SELECT data FROM bot_runtime WHERE id=1').first()).data);
      const listed=[...payload.text.matchAll(/^\s*(?:T([1235]) ·|TABLE ([1235]) )/gm)].map(match=>`T${match[1] ?? match[2]}`);
      // Cancel stale queued snapshots when a listed table drops below the threshold.
      if(!listed.length || listed.some(id=>!snapshot.tables?.some(t=>t.id===id&&t.open&&t.players>=5))) {
        await db.prepare("UPDATE bot_jobs SET status='cancelled' WHERE id=?").bind(r.id).run();continue;
      }
    }
    const result=await telegram(env,r.method,payload);
    if(result.ok) {
      const updates=[db.prepare("UPDATE bot_jobs SET status='sent',error=NULL WHERE id=?").bind(r.id)];
      if(['group','channel'].includes(r.stream))updates.push(db.prepare(`UPDATE bot_runtime SET data=json_set(data,'$.${r.stream}At',?) WHERE id=1`).bind(now()));
      await db.batch(updates);
    }else{
      const permanent=[400,401,403].includes(result.code);
      await db.prepare('UPDATE bot_jobs SET attempts=attempts+1,status=?,due=?,error=? WHERE id=?').bind(permanent?'failed':'pending',now()+Math.max(result.retry,Math.min(900,15*2**Math.min(r.attempts,6))),`Telegram ${result.code}`,r.id).run();
      if(result.code===403)await db.prepare("UPDATE bot_subscribers SET filter='off' WHERE id=?").bind(r.target).run();
      if(result.code===429)break;
    }
  }
}
const menu={inline_keyboard:[[{text:'All',callback_data:'sub:all'},{text:'NLH',callback_data:'sub:NLH'},{text:'PLO',callback_data:'sub:PLO'}],[{text:'Unsubscribe',callback_data:'sub:off'}]]};

export async function update(env,u) {
  const db=env.DB;
  if(!Number.isSafeInteger(u.update_id))return;
  const success=await leased(db,async()=>{
    if(await db.prepare('SELECT id FROM bot_updates WHERE id=?').bind(u.update_id).first())return;
    const q=u.callback_query,m=q?.message||u.message,who=q?.from||m?.from;
    const statements=[],time=now();
    const reply=(text,extra={})=>statements.push(job(db,`reply:${u.update_id}:${statements.length}`,m.chat.id,'reply',text,time,extra));
    if(m?.chat&&who) {
      const privateChat=m.chat.type==='private',owner=String(who.id)===String(env.OWNER_ID);
      const [verb,...args]=(m.text||'').trim().split(/\s+/);
      const [cmd,mention]=(verb||'').split('@');
      if(!mention||mention.toLowerCase()===USERNAME.toLowerCase()) {
        if(q&&privateChat&&/^sub:(all|NLH|PLO|off)$/.test(q.data||'')) {
          const filter=q.data.slice(4);
          statements.push(db.prepare('INSERT INTO bot_subscribers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET filter=excluded.filter').bind(String(who.id),filter));
          reply(filter==='off'?'Table notifications stopped.':`Subscribed: ${filter}`);
        }else if(!q) {
          if(cmd==='/tables') {
            try{reply(message(await source(env),time,{lineup:await lineupSource(env)}));}catch{reply('Live tables are temporarily unavailable. Please check https://www.everestpokerroom.com/waiting-list/');}
          }else if(privateChat&&['/subscribe','/start'].includes(cmd)) {
            reply('EVEREST POKER LIVE TABLES\n/tables — latest tables\n/subscribe — table notifications\n/unsubscribe — stop notifications\nContact : @midoripokerroom to reserve your seat',{reply_markup:menu});
          }else if(privateChat&&cmd==='/unsubscribe') {
            statements.push(db.prepare("INSERT INTO bot_subscribers VALUES(?,'off') ON CONFLICT(id) DO UPDATE SET filter='off'").bind(String(who.id)));reply('Table notifications stopped.');
          }else if(owner&&cmd==='/connectgroup'&&['group','supergroup'].includes(m.chat.type)) {
            const check=await telegram(env,'getChatMember',{chat_id:m.chat.id,user_id:who.id});
            if(check.ok&&['creator','administrator'].includes(check.result.status)) {
              statements.push(db.prepare("INSERT INTO bot_destinations VALUES(?,'group',?) ON CONFLICT(id) DO UPDATE SET kind='group',title=excluded.title").bind(String(m.chat.id),String(m.chat.title||'')));
              statements.push(job(db,`connect:${u.update_id}`,who.id,'reply',`已連接群組：${m.chat.title||m.chat.id}`,time));
            }else statements.push(job(db,`connect:${u.update_id}`,who.id,'reply','請以群組管理員身分執行連接。',time));
          }else if(owner&&privateChat&&cmd==='/updateson') {
            const tables=await source(env);
            // First enable deliberately seeds an empty baseline; >=5-player tables announce on next cron.
            const previous=JSON.parse((await db.prepare('SELECT data FROM bot_runtime WHERE id=1').first()).data);
            if(await setting(db,'enabled')!=='1')statements.push(db.prepare('UPDATE bot_runtime SET data=? WHERE id=1').bind(JSON.stringify({pendingThanksDay:previous.pendingThanksDay??null,thankedDay:previous.thankedDay??null,sequence:previous.sequence||0})));
            statements.push(set(db,'enabled','1'));reply(`雲端推播已啟用，目前 ${tables.filter(t=>t.open).length} 桌。`);
          }else if(owner&&privateChat&&cmd==='/updatesoff') {statements.push(set(db,'enabled','0'));statements.push(db.prepare("UPDATE bot_jobs SET status='cancelled' WHERE status='pending' AND stream IN ('group','channel','common')"));reply('雲端自動推播已暫停，/tables 仍可查詢。');
          }else if(owner&&privateChat&&cmd==='/status') {
            const targets=(await db.prepare('SELECT * FROM bot_destinations').all()).results;
            const errors=(await db.prepare("SELECT target,error FROM bot_jobs WHERE status='failed' ORDER BY created DESC LIMIT 3").all()).results;
            reply(`Cloudflare bot\n推播：${await setting(db,'enabled','0')==='1'?'ON':'OFF'}\n${targets.map(t=>`${t.kind}: ${t.title||t.id}`).join('\n')}\n最近發送異常：${errors.length?errors.map(e=>`${e.target}: ${e.error}`).join('; '):'無'}`);
          }else if(privateChat&&cmd?.startsWith('/'))reply('Commands: /tables /subscribe /unsubscribe\nContact : @midoripokerroom to reserve your seat');
        }
      }
    }
    statements.push(db.prepare('INSERT INTO bot_updates VALUES(?,?)').bind(u.update_id,time));
    await db.batch(statements);
    if(q)await telegram(env,'answerCallbackQuery',{callback_query_id:q.id});
    await flush(env);
  });
  if(!success)throw new Error('BUSY');
}

const setupPage=`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Everest Telegram Setup</title><style>body{font:17px system-ui;max-width:650px;margin:60px auto;padding:24px;color:#143d32}input,button{font:inherit;padding:12px;margin:8px 0;width:100%;box-sizing:border-box}button{background:#174c3e;color:white;border:0;border-radius:6px}</style><h1>Everest Telegram 雲端設定</h1><p>先停止 Mac 上的 bot.py，再按下連接。完成後，私訊機器人 /subscribe；在玩家群組傳 /connectgroup@EverestPokerRoomBot；最後私訊 /updateson。</p><form method="post" action="/setup"><input type="hidden" name="csrf" value="{{CSRF}}"><label>Cloudflare SETUP_PASSWORD<input type="password" name="password" autocomplete="off" required></label><button>連接 Telegram（暫不啟用自動推播）</button></form></html>`;

async function setup(req,env) {
  if(!env.DB||!env.BOT_TOKEN||!env.OWNER_ID||!env.SETUP_PASSWORD||env.SETUP_PASSWORD.length<16)return json({error:'請先設定 DB、BOT_TOKEN、OWNER_ID 及至少16字元的 SETUP_PASSWORD。'},503);
  const origin=req.headers.get('Origin');
  if(origin && origin!=='null' && origin!==new URL(req.url).origin)return json({error:'請從此 Worker 的 /setup 頁面提交設定。'},403);
  if(Number(req.headers.get('Content-Length'))>4096)return json({error:'Too large'},413);
  const raw=await req.text();if(raw.length>4096)return json({error:'Too large'},413);
  const fields=new URLSearchParams(raw);
  const csrf=fields.get('csrf')||'';
  const cookie=(req.headers.get('Cookie')||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('__Host-everest_setup_csrf='))?.slice('__Host-everest_setup_csrf='.length)||'';
  if(!/^[a-f0-9]{64}$/.test(csrf)||!await same(csrf,cookie))return json({error:'設定頁已過期，請重新開啟 /setup 頁面後再試。'},403);
  if(!await same(fields.get('password')||'',env.SETUP_PASSWORD))return json({error:'設定密碼不正確'},401);
  let stage='VERIFY_BOT';
  try {
  if(typeof env.DB.prepare!=='function')return json({error:'DB 不是 D1 資料庫綁定，請在 Bindings 加入 D1，名稱只填 DB。',stage:'DB_BINDING'},503);
  const me=await telegram(env,'getMe',{});
  if(!me.ok||me.result.username!==USERNAME)return json({error:'BOT_TOKEN 不正確，或不是 EverestPokerRoomBot。'},400);
  stage='PPM_SOURCE';
  await source(env);
  stage='DB_SCHEMA';
  for(const statement of SCHEMA.split(';').map(s=>s.trim()).filter(Boolean))await env.DB.prepare(statement).run();
  stage='CHECK_WEBHOOK';
  const existing=await telegram(env,'getWebhookInfo',{});
  const url=new URL('/telegram',req.url).href;
  if(!existing.ok)return json({error:'無法查詢 Telegram webhook'},502);
  if(existing.result.url&&existing.result.url!==url)return json({error:'機器人已有其他雲端 webhook，尚未變更。'},409);
  stage='CHECK_CHANNEL';
  const channel=await telegram(env,'getChat',{chat_id:'@MidoriPoker'});
  if(!channel.ok||channel.result.type!=='channel')return json({error:'無法讀取 @MidoriPoker 頻道。'},400);
  const member=await telegram(env,'getChatMember',{chat_id:channel.result.id,user_id:me.result.id});
  if(!member.ok||member.result.status!=='administrator'||!member.result.can_post_messages)return json({error:'請把機器人設為 @MidoriPoker 管理員並開啟發布訊息權限。'},400);
  stage='SAVE_CHANNEL';
  const secret=await setting(env.DB,'webhook_secret')||crypto.randomUUID().replaceAll('-','');
  await env.DB.batch([set(env.DB,'webhook_secret',secret),env.DB.prepare("INSERT INTO bot_destinations VALUES(?,'channel',?) ON CONFLICT(id) DO UPDATE SET kind='channel',title=excluded.title").bind(String(channel.result.id),channel.result.title||'MidoriPoker')]);
  stage='CONNECT_WEBHOOK';
  const result=await telegram(env,'setWebhook',{url,secret_token:secret,allowed_updates:['message','callback_query'],max_connections:1,drop_pending_updates:false});
  if(!result.ok)return json({error:'Telegram webhook 設定失敗，請稍後重試。'},502);
  stage='SAVE_CONNECTION';
  await set(env.DB,'connected','1').run();
  await telegram(env,'setMyCommands',{commands:[{command:'tables',description:'Latest live tables'},{command:'subscribe',description:'Subscribe to table updates'},{command:'unsubscribe',description:'Stop table notifications'}]});
  return json({ok:true,message:'雲端已連接。先私訊 /subscribe，群組內傳 /connectgroup@EverestPokerRoomBot，最後私訊 /updateson。'});
  }catch(e){
    const hints={PPM_SOURCE:'讀取 PPM 桌況失敗。',DB_SCHEMA:'初始化 D1 資料庫失敗，請確認 DB 綁定的是新的 everest-telegram 資料庫。',SAVE_CHANNEL:'儲存頻道設定失敗。',SAVE_CONNECTION:'儲存連線狀態失敗。'};
    const detail=/^SOURCE_HTTP_\d{3}$/.test(e?.message||'')?e.message:'SETUP_STEP_FAILED';
    console.error('Setup failed at '+stage+' ('+detail+')');
    return json({error:hints[stage]||'設定程序暫時失敗。',stage,code:detail},503);
  }
}

export default {
  async fetch(req,env) {
    const path=new URL(req.url).pathname;
    try {
      if(path==='/setup'&&req.method==='GET') {
        const csrf=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
        return new Response(setupPage.replace('{{CSRF}}',csrf),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",'Referrer-Policy':'same-origin','Set-Cookie':`__Host-everest_setup_csrf=${csrf}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=900`}});
      }
      if(path==='/setup'&&req.method==='POST')return await setup(req,env);
      if(path==='/'&&req.method==='GET')return json({service:'Everest Telegram',version:'2.0.7',setup:'/setup'});
      if(path==='/telegram'&&req.method==='POST') {
        const secret=await setting(env.DB,'webhook_secret');
        if(!secret||!await same(req.headers.get('X-Telegram-Bot-Api-Secret-Token')||'',secret))return json({error:'Forbidden'},403);
        if(Number(req.headers.get('Content-Length'))>100000)return json({error:'Too large'},413);
        const text=await req.text();if(text.length>100000)return json({error:'Too large'},413);
        await update(env,JSON.parse(text));return json({ok:true});
      }
      return json({error:'Not found'},404);
    }catch{return json({error:'Service unavailable. Check DB binding and setup; retry shortly.'},503);}
  },
  async scheduled(controller,env) {
    try{await poll(env);}catch{console.error('Scheduled table update failed; will retry next minute.');}
  }
};