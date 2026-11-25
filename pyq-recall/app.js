
(function(){
"use strict";
const CAT = window.PYQ_CATALOGUE;
const TOPICS = CAT.topics, PARTS = CAT.parts;
const BY = Object.fromEntries(TOPICS.map(t => [t.id, t]));
const numKey = id => id.split('.').map(Number);
const cmpNum = (a,b) => { const x=numKey(a), y=numKey(b); return x[0]-y[0] || x[1]-y[1]; };
const ORDER_HY = TOPICS.slice().sort((a,b) => b.n-a.n || cmpNum(a.id,b.id)).map(t=>t.id);
const ORDER_PART = TOPICS.slice().sort((a,b) => cmpNum(a.id,b.id)).map(t=>t.id);
const LADDER = [1,3,7,21,60,120];
const DEFAULTS = {newPerDay:2, order:'hy', examDate:'2027-12-01', startDate:'2026-11-01', restDay:'', theme:'dark', label:''};

let db = null, progress = {}, settings = {...DEFAULTS}, tab = 'today', filters = {q:'', part:'', status:'all'}, mode = 'loading';
let me = null, active = null, people = {}, names = {}, amOwner = false, myEmail = '';
const SETTING_KEYS = Object.keys(DEFAULTS);
const labelOf = uid => names[uid] || (people[uid] && people[uid].settings && people[uid].settings.label) || '';
const who = uid => uid===me ? 'You' : (labelOf(uid) || 'Study buddy');
const whoPoss = uid => uid===me ? 'your' : `${labelOf(uid) || 'your buddy'}’s`;
const lsGet = k => { try { return localStorage.getItem(k); } catch(e){ return null; } };
const lsSet = (k,v) => { try { localStorage.setItem(k,v); } catch(e){} };
let lastUndo = null;

/* ---------- dates (viewer's local calendar) ---------- */
const pad = n => String(n).padStart(2,'0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const addDays = (s,n) => { const [y,m,d]=s.split('-').map(Number); const x=new Date(y,m-1,d); x.setDate(x.getDate()+n); return ymd(x); };
const diffDays = (a,b) => { const p=s=>{const [y,m,d]=s.split('-').map(Number);return Date.UTC(y,m-1,d)}; return Math.round((p(b)-p(a))/864e5); };
const nice = s => { const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d).toLocaleDateString(undefined,{day:'numeric',month:'short'}); };
const inDays = n => n<=0 ? 'today' : n===1 ? 'tomorrow' : n<30 ? `in ${n} days` : n<60 ? 'in ~1 month' : `in ~${Math.round(n/30)} months`;

/* ---------- scheduling ---------- */
function nextState(prev, rating){
  const t = today();
  const s0 = prev ? prev.step : -1;
  let step, gap, lapses = prev ? (prev.lapses||0) : 0;
  if (rating==='forgot'){ step=0; gap=1; if(prev) lapses++; }
  else if (rating==='hard'){ if(!prev){ step=0; gap=1; } else { step=s0; gap=Math.max(1, Math.round(LADDER[s0]*0.5)); } }
  else if (rating==='good'){ step=Math.min(s0+1, LADDER.length-1); gap=LADDER[step]; }
  else { step=Math.min(s0+2, LADDER.length-1); gap=LADDER[step]; }
  const hist = (prev && prev.hist ? prev.hist.slice(-19) : []).concat([[t, rating[0]]]);
  let before = null;
  if (prev){ before = JSON.parse(JSON.stringify(prev)); delete before.prev; }
  return {step, due:addDays(t,gap), last:t, lastRating:rating, reps:(prev?prev.reps||0:0)+1, lapses, intro: prev ? prev.intro : t, hist, prev: before};
}
const preview = (prev, r) => { const n=nextState(prev,r); return inDays(diffDays(today(), n.due)); };
const isWeak = p => p && ((p.lapses||0)>=2 || p.lastRating==='forgot');

function plan(){
  const t = today();
  const due = Object.entries(progress).filter(([,p]) => p.due <= t).sort((a,b) => a[1].due.localeCompare(b[1].due) || cmpNum(a[0],b[0])).map(([id])=>id);
  const introducedToday = Object.values(progress).filter(p => p.intro === t).length;
  const rest = settings.restDay === t;
  const notYet = t < (settings.startDate||'');
  const want = (rest||notYet) ? 0 : Math.max(0, settings.newPerDay - introducedToday);
  const order = settings.order==='part' ? ORDER_PART : ORDER_HY;
  const fresh = [];
  for (const id of order){ if (fresh.length>=want) break; if (!progress[id]) fresh.push(id); }
  return {due, fresh, introducedToday, rest, notYet};
}
function pace(){
  const started = Object.keys(progress).length, left = TOPICS.length - started;
  const target = addDays(settings.examDate, -90);
  const from = today() < (settings.startDate||'') ? settings.startDate : today();
  const days = diffDays(from, target);
  if (left===0) return {ok:true, text:'Every topic has been started. Keep clearing reviews until the exam.'};
  if (days<=0) return {ok:false, text:`The first pass was meant to finish 3 months before the exam. ${left} topics are still new.`};
  const need = left/days;
  const ok = need <= settings.newPerDay + 0.01;
  return {ok, text: ok ? `On pace: ${left} new topics left, about ${need.toFixed(1)} a day needed to finish by ${nice(target)}.` : `Behind pace: ${left} new topics left needs ${need.toFixed(1)} a day to finish by ${nice(target)}. Raise new topics per day in Settings.`};
}

/* ---------- persistence: Supabase, with an offline outbox ---------- */
const CFG = window.PYQ_CONFIG || {};
const CACHE = 'pyq-cache-v1', OUTBOX = 'pyq-outbox-v1';
const jget = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch(e){ return d; } };
const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} };
let outbox = jget(OUTBOX, []);
function cacheState(){ jset(CACHE, {me, amOwner, myEmail, people}); }
function queue(op){
  // keep only the newest pending write per row
  outbox = outbox.filter(o => !(o.kind === op.kind && o.uid === op.uid && o.id === op.id));
  outbox.push(op); jset(OUTBOX, outbox); flush();
}
let flushing = false;
async function flush(){
  if (!db || flushing || !outbox.length) { updateSync(); return; }
  flushing = true;
  try {
    while (outbox.length){
      const o = outbox[0]; let r;
      if (o.kind === 'progress'){
        r = o.val ? await db.from('pyq_progress').upsert({user_id:o.uid, topic_id:o.id, data:o.val, updated_at:new Date().toISOString()})
                  : await db.from('pyq_progress').delete().eq('user_id', o.uid).eq('topic_id', o.id);
      } else {
        r = await db.from('pyq_profiles').update({settings:o.val, label:o.val.label||'', updated_at:new Date().toISOString()}).eq('user_id', o.uid);
      }
      if (r.error){
        if (/JWT|auth|401|permission|row-level/i.test(r.error.message||'')) { outbox.shift(); toast('Not saved: you are signed out or do not have access.'); }
        else { if (/fetch|network|load failed/i.test(r.error.message||'')) online = false; break; }   // network problem: keep it and retry later
      } else outbox.shift();
      jset(OUTBOX, outbox);
    }
  } catch(e){ online = false; /* offline: retry later */ }
  flushing = false; updateSync();
}
async function saveTopic(id, val, uid){
  uid = uid || active;
  people[uid] = people[uid] || {settings:{...DEFAULTS}, progress:{}};
  const target = people[uid].progress = (uid === active ? progress : (people[uid].progress || {}));
  if (val) target[id]=val; else delete target[id];
  if (uid === active) progress = target;
  cacheState(); render();
  queue({kind:'progress', uid, id, val: val || null});
}
let setTimer=null;
function saveSettings(){
  const uid = active;
  people[uid] = people[uid] || {progress:{}};
  people[uid].settings = {...(people[uid].settings||{}), ...settings};
  cacheState(); render();
  clearTimeout(setTimer);
  setTimer = setTimeout(() => { const body={}; SETTING_KEYS.forEach(k=>body[k]=people[uid].settings[k]); queue({kind:'settings', uid, id:'s', val:body}); }, 400);
}
function applyTheme(){ const th = (me && people[me] ? people[me].settings : settings).theme; if (th !== undefined) { if (th) document.documentElement.setAttribute('data-theme', th); else document.documentElement.removeAttribute('data-theme'); return; } if (settings.theme) document.documentElement.setAttribute('data-theme', settings.theme); else document.documentElement.removeAttribute('data-theme'); }

/* ---------- rendering helpers ---------- */
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const view = document.getElementById('view');
function status(id){
  const p = progress[id]; if (!p) return ['new','New'];
  if (p.due <= today()) return ['due','Due'];
  if (isWeak(p)) return ['weak','Weak'];
  return ['ok', nice(p.due)];
}
function row(id, extra, uid){
  const t = BY[id]; const [cls,lbl] = extra || status(id);
  return `<button class="row" data-open="${id}"${uid?` data-uid="${uid}"`:''}><span class="num">${id}</span><span class="tt"><b>${esc(t.t)}</b><span>Asked ${t.n}× · Vol ${t.v} p ${t.pg}${t.x.length?` · +Vol 5`:''}</span></span><span class="pill ${cls}">${esc(lbl)}</span></button>`;
}
function ring(frac, label){
  const r=36, c=2*Math.PI*r, off=c*(1-frac);
  return `<svg class="ring" viewBox="0 0 84 84" role="img" aria-label="${esc(label)}"><circle class="bgc" cx="42" cy="42" r="${r}"/><circle class="fgc" cx="42" cy="42" r="${r}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 42 42)"/><text x="42" y="47" text-anchor="middle">${Math.round(frac*100)}%</text></svg>`;
}

function renderToday(){
  const {due, fresh, introducedToday, rest, notYet} = plan();
  const total = due.length + fresh.length;
  const started = Object.keys(progress).length;
  const ex = diffDays(today(), settings.examDate);
  const pc = pace();
  document.getElementById('hTitle').textContent = 'Today';
  document.getElementById('hSub').textContent = new Date().toLocaleDateString(undefined,{weekday:'long',day:'numeric',month:'long'}) + (ex>0 ? ` · ${ex} days to exam` : '');
  let h = `<div class="hero glass"><div><div class="big">${total}<small>${total===1?'topic':'topics'} left today</small></div>
    <div class="line">${due.length} review${due.length===1?'':'s'} · ${fresh.length} new${introducedToday?` · ${introducedToday} new done`:''}</div></div>
    ${ring(started/TOPICS.length, `${started} of ${TOPICS.length} topics started`)}
    <div class="pace ${pc.ok?'':'warn'}">${esc(pc.text)}</div></div>`;
  h += `<div class="section-h"><h2>Reviews due</h2><span>Recall first, then check the book</span></div>`;
  h += due.length ? `<div class="list glass">${due.map(id=>row(id)).join('')}</div>` : `<div class="glass empty">${started? '<b>No reviews due.</b> Topics come back here on the day they are due.' : '<b>Nothing to review yet.</b> Start with today’s new topics below; each one returns here tomorrow.'}</div>`;
  h += `<div class="section-h"><h2>New topics</h2><span>${settings.order==='part'?'Part by part':'Most-asked first'}</span></div>`;
  if (notYet) h += `<div class="glass empty"><b>Your plan starts on ${nice(settings.startDate)}.</b> ${diffDays(today(),settings.startDate)===1?'Tomorrow':'In '+diffDays(today(),settings.startDate)+' days'} the first topics appear here: ${ (settings.order==='part'?ORDER_PART:ORDER_HY).filter(id=>!progress[id]).slice(0,settings.newPerDay).map(id=>`${id} ${esc(BY[id].t.split(' — ')[0])}`).join(' and ') }. You can open any topic early from the Topics tab.</div>`;
  else if (rest) h += `<div class="glass empty"><b>Reviews only today.</b> New topics resume tomorrow.</div>`;
  else h += fresh.length ? `<div class="list glass">${fresh.map(id=>row(id,['new','New'])).join('')}</div>` : `<div class="glass empty"><b>Today’s new topics are done.</b> Want more? Raise the daily number in Settings.</div>`;
  const doneToday = Object.keys(progress).filter(id => progress[id].last === today()).sort(cmpNum);
  if (doneToday.length){ const RL={forgot:['weak','Forgot'],hard:['due','Hard'],good:['ok','Good'],easy:['new','Easy']}; h += `<div class="section-h"><h2>Done today</h2><span>Tap a topic to undo its rating</span></div><div class="list glass">${doneToday.map(id=>row(id, RL[progress[id].lastRating]||['ok','Done'])).join('')}</div>`; }
  if (!notYet) h += `<div class="glass toggle-row"><div><b>Heavy duty day?</b><p>${rest?'Only reviews are shown today.':'Skip new topics today and only clear reviews.'}</p></div><button class="btn ${rest?'primary':''}" id="restBtn">${rest?'Undo':'Reviews only'}</button></div>`;
  view.innerHTML = h;
  const rb=document.getElementById('restBtn'); if (rb) rb.onclick = () => { settings.restDay = rest ? '' : today(); saveSettings(); };
  const b = document.getElementById('badge'); b.hidden = !total; b.textContent = total;
}

function renderTopics(){
  document.getElementById('hTitle').textContent = 'Topics';
  document.getElementById('hSub').textContent = `${TOPICS.length} topics from Volumes 1–5`;
  const q = filters.q.trim().toLowerCase();
  let items = (settings.order==='part'?ORDER_PART:ORDER_HY).filter(id => {
    const t = BY[id], p = progress[id];
    if (filters.part && String(t.p)!==filters.part) return false;
    if (filters.status==='new' && p) return false;
    if (filters.status==='learning' && !p) return false;
    if (filters.status==='due' && !(p && p.due<=today())) return false;
    if (filters.status==='weak' && !isWeak(p)) return false;
    if (q && !(id.startsWith(q) || t.t.toLowerCase().includes(q) || t.q.some(x=>x.toLowerCase().includes(q)))) return false;
    return true;
  });
  const shown = items.slice(0, 150);
  const st = (k,l) => `<button class="chip" data-status="${k}" aria-pressed="${filters.status===k}">${l}</button>`;
  let h = `<div class="glass toolbar"><input id="q" type="search" placeholder="Search number, title or question" value="${esc(filters.q)}" aria-label="Search topics">
    <select id="part" aria-label="Filter by part"><option value="">All parts</option>${Object.entries(PARTS).map(([n,tt])=>`<option value="${n}" ${filters.part===n?'selected':''}>${n}. ${esc(tt)}</option>`).join('')}</select>
    <div class="chips">${st('all','All')}${st('new','Not started')}${st('learning','Started')}${st('due','Due')}${st('weak','Weak')}</div></div>`;
  h += `<div class="section-h"><h2>${items.length} topic${items.length===1?'':'s'}</h2><span>${settings.order==='part'?'Part order':'Most-asked first'}</span></div>`;
  h += items.length ? `<div class="list glass">${shown.map(id=>row(id)).join('')}</div>${items.length>150?`<div class="glass empty">Showing the first 150. Search or filter to narrow the list.</div>`:''}` : `<div class="glass empty"><b>No topics match.</b> Clear the search or pick another filter.</div>`;
  view.innerHTML = h;
  const qi = document.getElementById('q');
  qi.oninput = () => { filters.q = qi.value; const pos=qi.selectionStart; renderTopics(); const n=document.getElementById('q'); n.focus(); try{n.setSelectionRange(pos,pos);}catch(e){} };
  document.getElementById('part').onchange = e => { filters.part = e.target.value; renderTopics(); };
  view.querySelectorAll('[data-status]').forEach(b => b.onclick = () => { filters.status = b.dataset.status; renderTopics(); });
}

function renderProgress(){
  document.getElementById('hTitle').textContent = 'Progress';
  const P = Object.values(progress);
  const started = P.length, mature = P.filter(p=>p.step>=3).length, weak = Object.keys(progress).filter(id=>isWeak(progress[id]));
  document.getElementById('hSub').textContent = `${started} of ${TOPICS.length} topics started`;
  const t = today(); const days = [...Array(14)].map((_,i)=>addDays(t,i));
  const counts = days.map((d,i) => P.filter(p => i===0 ? p.due<=d : p.due===d).length);
  const max = Math.max(4, ...counts);
  let h = `<div class="stats"><div class="glass stat"><div class="k">Started</div><div class="v">${started}</div></div><div class="glass stat"><div class="k">Strong</div><div class="v">${mature}</div></div><div class="glass stat"><div class="k">Weak</div><div class="v">${weak.length}</div></div></div>`;
  h += `<div class="glass chart"><div class="section-h" style="margin:0;flex-direction:column;align-items:flex-start"><h2>Reviews due · next 14 days</h2><span>Today includes overdue</span></div><div class="bars" role="img" aria-label="Reviews due per day for the next 14 days">${counts.map((c,i)=>`<div class="bar ${i===0?'today':''}"><span>${c||''}</span><i style="height:${(c/max*100).toFixed(1)}%"></i><em>${i===0?'Tod':(()=>{const [y,m,d]=days[i].split('-').map(Number);return new Date(y,m-1,d).toLocaleDateString(undefined,{weekday:'narrow'});})()}</em></div>`).join('')}</div></div>`;
  h += `<div class="section-h"><h2>By part</h2><span>started / total</span></div><div class="glass partgrid">${Object.entries(PARTS).map(([n,tt])=>{const ids=TOPICS.filter(x=>String(x.p)===n);const s=ids.filter(x=>progress[x.id]).length;return `<div class="prow"><span class="lbl">${n}. ${esc(tt)}</span><span class="c">${s} / ${ids.length}</span><div class="track"><i style="width:${(s/ids.length*100).toFixed(1)}%"></i></div></div>`;}).join('')}</div>`;
  h += `<div class="section-h"><h2>Weak topics</h2><span>Forgot last time, or twice or more</span></div>`;
  h += weak.length ? `<div class="list glass">${weak.sort(cmpNum).map(id=>row(id,['weak',progress[id].lapses?`${progress[id].lapses} lapse${progress[id].lapses>1?'s':''}`:'Forgot'])).join('')}</div>` : `<div class="glass empty">No weak topics yet. Topics you rate <b>Forgot</b> appear here so the final months can go to them.</div>`;
  view.innerHTML = h;
}

function renderSettings(){
  document.getElementById('hTitle').textContent = 'Settings';
  document.getElementById('hSub').textContent = (db && active !== me) ? `These are ${whoPoss(active)} plan settings` : 'Changes sync to all your devices';
  const th = settings.theme; const mine = !db || active === me;
  view.innerHTML = `<div class="glass settings">
    <div class="field"><label>New topics per day<small>Reviews are always shown in full.</small></label><div class="stepper"><button class="btn" id="minus" aria-label="Fewer">−</button><output id="npd">${settings.newPerDay}</output><button class="btn" id="plus" aria-label="More">+</button></div></div>
    <div class="field"><label for="ord">Order of new topics<small>Most-asked uses how often each topic appeared 2015–2025.</small></label><select id="ord"><option value="hy" ${settings.order==='hy'?'selected':''}>Most-asked first</option><option value="part" ${settings.order==='part'?'selected':''}>Part by part</option></select></div>
    ${mine ? `<div class="field"><label for="lbl">Your name<small>Shown to your study buddy.</small></label><input id="lbl" type="text" maxlength="30" value="${esc(settings.label||'')}" placeholder="e.g. Mahekdeep"></div>` : ''}
    <div class="field"><label for="start">Start date<small>New topics begin on this day.</small></label><input id="start" type="date" value="${esc(settings.startDate||'')}"></div>
    <div class="field"><label for="exam">Exam date<small>The first pass is paced to end 3 months before.</small></label><input id="exam" type="date" value="${esc(settings.examDate)}"></div>
    ${mine ? `<div class="field"><label for="theme">Appearance</label><select id="theme"><option value="dark" ${th==='dark'?'selected':''}>Black</option><option value="" ${!th?'selected':''}>Match device</option><option value="light" ${th==='light'?'selected':''}>Light</option></select></div>` : ''}
  </div>
  <div class="glass note"><b>How the spacing works.</b> Each rating sets when a topic comes back. <b>Good</b> moves it up the ladder of 1, 3, 7, 21, 60 and 120 days; <b>Easy</b> skips a step; <b>Hard</b> repeats at half the gap; <b>Forgot</b> starts it again tomorrow and marks it weak.</div>
  <div class="glass note"><b>Daily reminder.</b> A Claude notification at 8:45 pm lists what is due.</div>
  <div class="glass note" id="syncNote"></div>
  ${mine && db ? `<div class="glass settings"><div class="field"><label>Backup<small>Copy your whole plan as text, or restore one.</small></label><div class="stepper"><button class="btn" id="bkCopy" style="width:auto;padding:0 16px">Copy</button><button class="btn" id="bkRestore" style="width:auto;padding:0 16px">Restore</button></div></div>
    <div class="field" id="bkBox" hidden style="grid-template-columns:1fr"><textarea id="bkText" rows="4" placeholder="Paste a backup here" style="width:100%;font:13px var(--mono);color:var(--fg);background:var(--glass);border:1px solid var(--rim);border-radius:14px;padding:10px"></textarea><button class="btn primary" id="bkApply">Restore this backup</button></div>
    <div class="field"><label>Account<small>${esc(myEmail)}</small></label><button class="btn" id="signOut">Sign out</button></div></div>` : ''}`;
  const sn=document.getElementById('syncNote'); sn.innerHTML = db ? (outbox.length ? `<b>${outbox.length} change${outbox.length>1?'s':''} waiting to sync.</b> They upload automatically when you are back online.` : '<b>Sync is on.</b> Ratings save as you make them, and wait safely if you are offline.') : '<b>Sync is not set up.</b> Add your Supabase details to config.js.';
  const so=document.getElementById('signOut'); if (so) so.onclick = async () => { if (outbox.length && !confirmInline(so, 'Unsynced changes — tap again to sign out anyway')) return; await db.auth.signOut(); try{ localStorage.removeItem(CACHE); localStorage.removeItem(OUTBOX); }catch(e){} location.reload(); };
  const bc=document.getElementById('bkCopy'); if (bc) bc.onclick = async () => { const txt = JSON.stringify({app:'pyq-recall', v:1, settings, progress}); try { await navigator.clipboard.writeText(txt); toast('Backup copied. Paste it into Notes to keep it.'); } catch(e){ document.getElementById('bkBox').hidden=false; const t=document.getElementById('bkText'); t.value=txt; t.select(); toast('Select all and copy the text shown.'); } };
  const br=document.getElementById('bkRestore'); if (br) br.onclick = () => { const b=document.getElementById('bkBox'); b.hidden=false; document.getElementById('bkText').value=''; document.getElementById('bkText').focus(); };
  const ba=document.getElementById('bkApply'); if (ba) ba.onclick = () => { try { const d = JSON.parse(document.getElementById('bkText').value); if (d.app!=='pyq-recall') throw 0; Object.entries(d.progress||{}).forEach(([id,v]) => { if (BY[id]) saveTopic(id, v); }); if (d.settings){ const keep = {theme:settings.theme, label:settings.label}; settings = {...DEFAULTS, ...d.settings, ...keep}; saveSettings(); } toast(`Restored ${Object.keys(d.progress||{}).length} topics.`); document.getElementById('bkBox').hidden=true; } catch(e){ toast('That text is not a PYQ Recall backup.'); } };
  document.getElementById('minus').onclick = () => { settings.newPerDay = Math.max(0, settings.newPerDay-1); saveSettings(); };
  document.getElementById('plus').onclick = () => { settings.newPerDay = Math.min(10, settings.newPerDay+1); saveSettings(); };
  document.getElementById('ord').onchange = e => { settings.order = e.target.value; saveSettings(); };
  const lb=document.getElementById('lbl'); if (lb) lb.onchange = e => { settings.label = e.target.value.trim(); saveSettings(); };
  document.getElementById('start').onchange = e => { if (e.target.value) { settings.startDate = e.target.value; saveSettings(); } };
  document.getElementById('exam').onchange = e => { if (e.target.value) { settings.examDate = e.target.value; saveSettings(); } };
  const ts=document.getElementById('theme'); if (ts) ts.onchange = e => { settings.theme = e.target.value; saveSettings(); applyTheme(); };
}

function showAuth(msg){
  sheetHost.innerHTML = `<div class="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="au-t">
    <div class="grab"></div><h3 id="au-t">PYQ Recall</h3>
    <div class="howto">Sign in once on each device. Your plan then syncs between your iPhone, iPad and laptop.</div>
    <form id="authForm" class="authform" autocomplete="on">
      <label for="auEmail">Email</label><input id="auEmail" type="email" autocomplete="username" required>
      <label for="auPass">Password</label><input id="auPass" type="password" autocomplete="current-password" minlength="6" required>
      <label for="auName" id="auNameL" hidden>Your name<small> · shown to your study buddy</small></label><input id="auName" type="text" maxlength="30" hidden placeholder="e.g. Mahekdeep">
      <div class="autherr" id="auErr" role="alert">${esc(msg||'')}</div>
      <button class="btn primary" id="auGo" type="submit">Sign in</button>
      <button class="btn" id="auSwitch" type="button">New here? Create an account</button>
    </form></div></div>`;
  let mode = 'in';
  const sw = document.getElementById('auSwitch'), go = document.getElementById('auGo'), err = document.getElementById('auErr');
  sw.onclick = () => { mode = mode==='in' ? 'up' : 'in';
    document.getElementById('auName').hidden = document.getElementById('auNameL').hidden = mode==='in';
    document.getElementById('auPass').autocomplete = mode==='in' ? 'current-password' : 'new-password';
    go.textContent = mode==='in' ? 'Sign in' : 'Create account'; sw.textContent = mode==='in' ? 'New here? Create an account' : 'Have an account? Sign in'; err.textContent=''; };
  document.getElementById('authForm').onsubmit = async e => {
    e.preventDefault(); err.textContent=''; go.disabled = true; go.textContent = 'Please wait…';
    const email = document.getElementById('auEmail').value.trim(), password = document.getElementById('auPass').value, name = document.getElementById('auName').value.trim();
    try {
      const r = mode==='in' ? await db.auth.signInWithPassword({email, password}) : await db.auth.signUp({email, password, options:{data:{label:name}}});
      if (r.error) throw r.error;
      if (mode==='up' && !r.data.session){ err.textContent = 'Account created. Confirm the email Supabase sent you, then sign in here.'; mode='up'; sw.click(); }
      else { pendingLabel = name; sheetHost.innerHTML=''; await startSession(r.data.session); }
    } catch(x){ err.textContent = (x && x.message) ? (/fetch|network/i.test(x.message) ? 'No connection. Check your internet and try again.' : x.message) : 'Could not sign in.'; }
    go.disabled = false; go.textContent = mode==='in' ? 'Sign in' : 'Create account';
  };
}
let pendingLabel = '';
function setActive(uid){
  active = uid;
  const P = people[uid] || {settings:{...DEFAULTS}, progress:{}};
  progress = P.progress || {}; settings = {...DEFAULTS, ...P.settings};
  closeSheet(); render();
}
function statsFor(uid){
  const P = people[uid] || {}; const pr = P.progress || {}; const st = {...DEFAULTS, ...(P.settings||{})};
  const vals = Object.values(pr), t = today();
  const done = Object.keys(pr).filter(id => pr[id].last === t);
  const dueNow = vals.filter(p => p.due <= t).length;
  const days = new Set(); vals.forEach(p => (p.hist||[]).forEach(h => days.add(h[0])));
  let streak = 0, d = days.has(t) ? t : addDays(t,-1);
  while (days.has(d)) { streak++; d = addDays(d,-1); }
  return {started: vals.length, strong: vals.filter(p=>p.step>=3).length, weak: vals.filter(isWeak).length, done, dueNow, streak, st};
}
function renderBuddy(){
  document.getElementById('hTitle').textContent = 'Study buddy';
  const ids = Object.keys(people).sort((a,b) => (a===me?-1:b===me?1:0));
  document.getElementById('hSub').textContent = ids.length>1 ? `${ids.length} people on this planner` : 'Waiting for your study buddy to join';
  const RL={forgot:['weak','Forgot'],hard:['due','Hard'],good:['ok','Good'],easy:['new','Easy']};
  let h = '';
  if (!db){ view.innerHTML = `<div class="glass empty"><b>Study buddy needs sync.</b> Sign in to see each other’s plans.</div>`; return; }
  ids.forEach(uid => {
    const s = statsFor(uid);
    h += `<div class="glass buddy"><div class="bhead"><div><b>${esc(who(uid))}</b><span>${s.streak ? `${s.streak}-day streak` : 'No streak yet'} · ${s.started} / ${TOPICS.length} started</span></div><button class="btn ${uid===active?'primary':''}" data-person="${uid}">${uid===active?'Viewing':'Open plan'}</button></div>
      <div class="bstats"><div><em>Today</em><b>${s.done.length}</b></div><div><em>Due</em><b>${s.dueNow}</b></div><div><em>Strong</em><b>${s.strong}</b></div><div><em>Weak</em><b>${s.weak}</b></div></div>
      <div class="track"><i style="width:${(s.started/TOPICS.length*100).toFixed(1)}%"></i></div></div>`;
    h += `<div class="section-h"><h2>${esc(who(uid))} · today</h2><span>${s.done.length ? 'Tap a topic to see it' : ''}</span></div>`;
    const pr = (people[uid]||{}).progress || {};
    h += s.done.length ? `<div class="list glass">${s.done.sort(cmpNum).map(id => row(id, RL[pr[id].lastRating]||['ok','Done'], uid)).join('')}</div>` : `<div class="glass empty">Nothing rated yet today.</div>`;
  });
  if (ids.length < 2) h += `<div class="glass note"><b>Invite your study buddy.</b> Send her this app’s link. She opens it, adds it to her Home Screen and taps <b>Create an account</b>. Her plan then appears here and you can see each other’s progress.</div>`;
  view.innerHTML = h;
  view.querySelectorAll('[data-person]').forEach(b => b.onclick = () => { setActive(b.dataset.person); tab='today'; document.querySelectorAll('.tab').forEach(x => x.setAttribute('aria-selected', String(x.dataset.tab==='today'))); render(); });
}
function resolveNames(){}
function render(){
  if (tab==='today') renderToday(); else if (tab==='topics') renderTopics(); else if (tab==='progress') renderProgress(); else if (tab==='buddy') renderBuddy(); else renderSettings();
  const vb = document.getElementById('viewing');
  if (active && me && active!==me && tab!=='buddy'){ vb.hidden=false; vb.innerHTML = `<span>Viewing <b>${esc(who(active))}’s</b> plan. Ratings you make here change ${esc(whoPoss(active))} schedule.</span><button class="btn" id="backMine">My plan</button>`; document.getElementById('backMine').onclick=()=>setActive(me); } else vb.hidden=true;
  if (tab!=='today'){ const {due,fresh}=plan(); const b=document.getElementById('badge'); b.hidden=!(due.length+fresh.length); b.textContent=due.length+fresh.length; }
  if (openId) renderSheet();
}

/* ---------- topic sheet ---------- */
let openId = null;
const sheetHost = document.getElementById('sheetHost');
function openSheet(id){ openId = id; renderSheet(); }
function closeSheet(){ openId = null; sheetHost.innerHTML=''; }
function renderSheet(){
  const id = openId, t = BY[id], p = progress[id]; if (!t) return;
  const [cls,lbl] = status(id);
  const sess = t.s;
  const qs = t.q.map(q => { const m=q.match(/^(.*?)\s+—\s+(Paper \d.*)$/); return m?`<li>${esc(m[1])}<em>${esc(m[2])}</em></li>`:`<li>${esc(q)}</li>`; }).join('');
  const x = t.x.map(([n,pg]) => `<div><b>Answer ${n} · Volume 5, page ${pg}</b><span>2024–25 revision answer with key points and any new sub-parts</span></div>`).join('');
  const rel = (t.r||[]).filter(r=>BY[r]).map(r => `<div><b>Related: ${r} · Volume ${BY[r].v}, page ${BY[r].pg}</b><span>${esc(BY[r].t)}</span></div>`).join('');
  const histTxt = p && p.hist && p.hist.length ? 'History: ' + p.hist.slice(-8).map(([d,r])=>`${nice(d)} ${({f:'Forgot',h:'Hard',g:'Good',e:'Easy'})[r]}`).join(' · ') : '';
  sheetHost.innerHTML = `<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-t">
    <div class="grab"></div>
    <div class="meta"><span class="num">${id}</span><span class="pill ${cls}">${esc(lbl)}</span><span class="pill">Part ${t.p}</span><span class="pill">Asked ${t.n}×</span></div>
    <h3 id="sh-t">${esc(t.t)}</h3>
    ${db && me && active!==me ? `<div class="pill due" style="display:inline-block;margin-bottom:8px">Rating on ${esc(whoPoss(active))} plan</div>` : ''}
    <div class="howto">${p ? 'Write the headings and key points from memory, then open the book and check. Rate honestly.' : 'First read: study the answer in the book, close it, write the outline from memory, then rate.'}</div>
    <div class="where"><div><b>Answer ${id} · Volume ${t.v}, page ${t.pg}</b><span>${esc(PARTS[t.p]||'')}</span></div>${x}${rel}</div>
    <div class="section-h" style="margin:0 2px"><h2>Asked as</h2><span>${sess.length} session${sess.length===1?'':'s'}</span></div>
    <ul class="qlist">${qs}</ul>
    <div class="howto">Sessions: ${esc(sess.join(', '))}</div>
    ${histTxt?`<div class="hist">${esc(histTxt)}</div>`:''}
    ${p ? `<button class="btn undo-btn" id="undoRate">${('prev' in p) || (p.reps||1)<=1 ? `Undo last rating · ${({forgot:'Forgot',hard:'Hard',good:'Good',easy:'Easy'})[p.lastRating]||''} on ${nice(p.last)}` : 'Reset this topic to not started'}</button>` : ''}
    <div class="rate">
      <button class="f" data-rate="forgot">Forgot<small>${preview(p,'forgot')}</small></button>
      <button class="h" data-rate="hard">Hard<small>${preview(p,'hard')}</small></button>
      <button class="g" data-rate="good">Good<small>${preview(p,'good')}</small></button>
      <button class="e" data-rate="easy">Easy<small>${preview(p,'easy')}</small></button>
    </div></div></div>`;
  document.getElementById('scrim').onclick = e => { if (e.target.id==='scrim') closeSheet(); };
  sheetHost.querySelectorAll('[data-rate]').forEach(b => b.onclick = () => rate(id, b.dataset.rate));
  const ub = document.getElementById('undoRate'); if (ub) ub.onclick = () => undoRating(id);
}
function undoRating(id){
  const p = progress[id]; if (!p) return;
  const back = ('prev' in p) && p.prev ? JSON.parse(JSON.stringify(p.prev)) : null;
  closeSheet(); saveTopic(id, back);
  toast(back ? `${id} restored to before your last rating` : `${id} is back to not started`);
}
function rate(id, r){
  const prev = progress[id] ? JSON.parse(JSON.stringify(progress[id])) : null;
  const n = nextState(progress[id], r);
  lastUndo = {id, prev, uid: active};
  closeSheet();
  saveTopic(id, n);
  toast(`${id} rated ${r[0].toUpperCase()+r.slice(1)} · back ${inDays(diffDays(today(), n.due))}`, true);
}
let toastT=null;
function toast(msg, undo){
  const host=document.getElementById('toastHost');
  host.innerHTML = `<div class="toast glass" role="status"><span>${esc(msg)}</span>${undo?'<button id="undo">Undo</button>':''}</div>`;
  if (undo) document.getElementById('undo').onclick = () => { if (lastUndo){ const u=lastUndo; lastUndo=null; saveTopic(u.id, u.prev, u.uid); } host.innerHTML=''; };
  clearTimeout(toastT); toastT=setTimeout(()=>{host.innerHTML='';}, 9000);
}

/* ---------- events ---------- */
document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  tab = b.dataset.tab;
  document.querySelectorAll('.tab').forEach(x => x.setAttribute('aria-selected', String(x===b)));
  window.scrollTo(0,0); render();
});
view.addEventListener('click', e => { const r = e.target.closest('[data-open]'); if (!r) return; if (r.dataset.uid && r.dataset.uid!==active){ setActive(r.dataset.uid); } openSheet(r.dataset.open); });
document.addEventListener('keydown', e => {
  if (e.key==='Escape' && openId) closeSheet();
  if (openId && !e.target.closest('input,select')){ const k={'1':'forgot','2':'hard','3':'good','4':'easy'}[e.key]; if(k) rate(openId,k); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

function setSync(state, text){ const s=document.getElementById('sync'); s.className='sync '+state; s.querySelector('span').textContent=text; }
let online = navigator.onLine !== false, live = false;
function updateSync(){
  if (!db) return;
  if (!online) setSync('off', outbox.length ? `Offline · ${outbox.length} to sync` : 'Offline');
  else if (outbox.length) setSync('off', `Syncing ${outbox.length}…`);
  else setSync('on', 'Synced');
}

/* ---------- boot ---------- */
function confirmInline(btn, msg){ if (btn.dataset.armed) return true; btn.dataset.armed='1'; btn.textContent = msg; setTimeout(()=>{ delete btn.dataset.armed; btn.textContent='Sign out'; }, 4000); return false; }
function applyRows(profiles, progRows){
  const P = {};
  profiles.forEach(r => { P[r.user_id] = {settings:{...DEFAULTS, ...(r.settings||{}), label: r.label || (r.settings||{}).label || ''}, owner: r.is_owner, progress:{}}; });
  progRows.forEach(r => { (P[r.user_id] = P[r.user_id] || {settings:{...DEFAULTS}, progress:{}}).progress[r.topic_id] = r.data; });
  // re-apply writes that have not reached the server yet, so a refresh never undoes them
  outbox.forEach(o => { const t = P[o.uid]; if (!t) return; if (o.kind==='progress'){ if (o.val) t.progress[o.id]=o.val; else delete t.progress[o.id]; } else t.settings = {...t.settings, ...o.val}; });
  people = P;
  if (people[me]) amOwner = !!people[me].owner;
  if (!people[active]) active = me;
  progress = (people[active]||{}).progress || {}; settings = {...DEFAULTS, ...((people[active]||{}).settings||{})};
  cacheState(); applyTheme(); render();
}
async function fetchAll(){
  const prof = await db.from('pyq_profiles').select('user_id,label,settings,is_owner');
  if (prof.error) throw prof.error;
  let rows = [], from = 0;
  for (;;){ const r = await db.from('pyq_progress').select('user_id,topic_id,data').order('user_id').order('topic_id').range(from, from+999);
    if (r.error) throw r.error; rows = rows.concat(r.data); if (r.data.length < 1000) break; from += 1000; }
  return [prof.data, rows];
}
let refreshing = false, refreshAgain = false, channel = null;
async function refresh(){
  if (!db || !me) return;
  if (refreshing){ refreshAgain = true; return; }
  refreshing = true;
  try { await flush(); const [p, r] = await fetchAll(); applyRows(p, r); online = true; }
  catch(e){ online = navigator.onLine !== false && !/fetch|network/i.test((e&&e.message)||'') ? online : false; }
  refreshing = false; updateSync();
  if (refreshAgain){ refreshAgain = false; refresh(); }
}
async function ensureProfile(){
  const mine = await db.from('pyq_profiles').select('user_id').eq('user_id', me).maybeSingle();
  if (mine.error) throw mine.error;
  if (mine.data) return;
  const any = await db.from('pyq_profiles').select('user_id', {count:'exact', head:true});
  const first = !any.error && (any.count||0) === 0;
  const label = pendingLabel || '';
  const r = await db.from('pyq_profiles').insert({user_id: me, label, is_owner: first, settings: {...DEFAULTS, label, startDate: today()}});
  if (r.error && !/duplicate/i.test(r.error.message)) throw r.error;
}
async function startSession(session){
  if (!session){ showAuth(); return; }
  if (me && me !== session.user.id){ try{ localStorage.removeItem(CACHE); localStorage.removeItem(OUTBOX); }catch(e){} outbox = []; people = {}; }
  me = session.user.id; myEmail = session.user.email || ''; if (!active || !people[active]) active = me;
  try { await ensureProfile(); } catch(e){ /* offline first run: try again on next refresh */ }
  await refresh();
  if (!channel){
    channel = db.channel('pyq-live')
      .on('postgres_changes', {event:'*', schema:'public', table:'pyq_progress'}, () => scheduleRefresh())
      .on('postgres_changes', {event:'*', schema:'public', table:'pyq_profiles'}, () => scheduleRefresh())
      .subscribe(st => { live = st === 'SUBSCRIBED'; });
  }
}
let rT = null; function scheduleRefresh(){ clearTimeout(rT); rT = setTimeout(refresh, 600); }

applyTheme();
// open instantly from the last saved copy, then sync
(() => { const c = jget(CACHE, null); if (c && c.me){ me = c.me; active = c.me; amOwner = c.amOwner; myEmail = c.myEmail||''; people = c.people||{}; progress = (people[me]||{}).progress||{}; settings = {...DEFAULTS, ...((people[me]||{}).settings||{})}; } })();
render();
if (!CFG.url || !CFG.anonKey || !window.supabase){
  setSync('off', 'Not set up');
  view.innerHTML = `<div class="glass empty"><b>Almost there.</b> Open <b>config.js</b> and paste your Supabase Project URL and anon key, then reload.</div>`;
} else {
  db = window.supabase.createClient(CFG.url, CFG.anonKey, {auth:{persistSession:true, autoRefreshToken:true, storageKey:'pyq-auth'}});
  updateSync();
  db.auth.getSession().then(({data}) => startSession(data.session)).catch(() => { if (me) { online=false; updateSync(); } else showAuth('No connection. Connect to the internet for your first sign-in.'); });
  db.auth.onAuthStateChange((ev, session) => { if (ev === 'SIGNED_OUT') { me = null; showAuth(); } });
  window.addEventListener('online', () => { online = true; refresh(); });
  window.addEventListener('offline', () => { online = false; updateSync(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 120000);
}
})();
