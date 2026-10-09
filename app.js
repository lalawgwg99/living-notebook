/* 活筆記 — 多腦架構前端
 * 丟進來 → 抓內容 → AI摘要 → 自動分類進大腦 → 大腦進化（分裂/繁衍/思考/補缺口）
 * 資料全存在瀏覽器 localStorage；AI 走 ai-proxy ＋ notebook-ingest。
 */
(function () {
'use strict';

const AI_URL = (window.APP_CONFIG && window.APP_CONFIG.AI_URL) || 'https://ai.taicalc.com/api/ai';
const INGEST_URL = (window.APP_CONFIG && window.APP_CONFIG.INGEST_URL) || '';

const LS_NOTES = 'living-notes-v1';
const LS_BRAINS = 'living-brains-v1';
const LS_PERSONA = 'living-persona-v1';
const LS_CHAT = 'living-chat-v1';

/* ---------------- 工具 ---------------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const uid = (p) => (p || 'n') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmtDate = (ts) => new Date(ts).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' });
const load = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const validColor = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.trim()) ? c.trim() : null;

function extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
async function aiTask(task, payload, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 60000);
  try {
    const r = await fetch(AI_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, payload }), signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('ai-' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

function toast(msg, ms) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, ms || 3200);
}

/* 餵食吸收特效：同心光圈 */
function absorbBurst() {
  const fx = $('absorbFx');
  if (!fx) return;
  fx.classList.remove('on'); void fx.offsetWidth; fx.classList.add('on');
  setTimeout(() => fx.classList.remove('on'), 1000);
}

/* ---------------- 檔期日期工具 ---------------- */
function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(d) ? null : d;
}
function todayMid() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function daysUntil(dateStr) {
  const d = parseDay(dateStr);
  if (!d) return null;
  return Math.round((d - todayMid()) / 86400000);
}
function fmtDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? `${+m[2]}/${+m[3]}` : '';
}
/* 檔期狀態：ended 已結束 / expiring 即將到期(≤3天) / upcoming 未開始 / active 進行中 / nodate 無日期 */
function phaseOf(n) {
  const dEnd = daysUntil(n.eventEnd), dStart = daysUntil(n.eventStart);
  if (dEnd !== null && dEnd < 0) return 'ended';
  if (dStart !== null && dStart > 0) return 'upcoming';
  if (dEnd !== null && dEnd <= 3) return 'expiring';
  if (n.eventEnd || n.eventStart) return 'active';
  return 'nodate';
}
function countdownChip(n) {
  const d = daysUntil(n.eventEnd);
  if (d === null) return '';
  if (d < 0) return `<span class="countdown ended">已結束</span>`;
  if (d === 0) return `<span class="countdown urgent">今天到期</span>`;
  if (d <= 3) return `<span class="countdown urgent">剩 ${d} 天</span>`;
  if (d <= 7) return `<span class="countdown soon">剩 ${d} 天</span>`;
  return `<span class="countdown active">剩 ${d} 天</span>`;
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
/* 圖片等比縮小 → dataURL */
function downscaleImage(img, maxDim, quality) {
  const r = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * r), h = Math.round(img.naturalHeight * r);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', quality || 0.82);
}
function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}
/* .ics 行事曆下載（含 3 天前提醒） */
function downloadICS(n) {
  if (!n.eventEnd) { toast('這則沒有活動日期'); return; }
  const endD = parseDay(n.eventEnd); if (!endD) return;
  const f = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const startD = parseDay(n.eventStart) || endD;
  const afterEnd = new Date(endD); afterEnd.setDate(afterEnd.getDate() + 1);
  const escICS = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n').slice(0, 200);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//活筆記//檔期管家//TW',
    'BEGIN:VEVENT',
    `UID:${n.id}@living-notebook`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${f(startD)}`,
    `DTEND;VALUE=DATE:${f(afterEnd)}`,
    `SUMMARY:${escICS((n.eventName || n.title || '活動') + '（截止）')}`,
    `DESCRIPTION:${escICS(n.summary || '')}`,
    'BEGIN:VALARM', 'TRIGGER:-P3D', 'ACTION:DISPLAY', 'DESCRIPTION:活動即將到期', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = `${(n.eventName || n.title || '活動').slice(0, 20)}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('已匯出行事曆');
}

/* ---------------- 資料 ---------------- */
let notes = load(LS_NOTES, []);
let brains = load(LS_BRAINS, []);
// 舊版筆記沒有 brainId → 視為待分類
notes.forEach((n) => { if (!('brainId' in n)) n.brainId = null; });
let persona = load(LS_PERSONA, null) || {
  name: null, mood: '就緒', color: '#4a6fa5',
  greeting: '把 DM、活動訊息丟進來，我會整理成檔期，標出截止日並提醒你。',
  traits: [], bio: '', absorbedCount: 0, updatedAt: null,
};
let chatHistory = load(LS_CHAT, []);
let selectedBrain = 'all';   // 'all' | 'inbox' | brainId
let selectedPhase = 'all';   // 'all' | 'active' | 'expiring' | 'upcoming' | 'ended'
let searchKw = '';
let pipelining = false;
let chatting = false;
let brainView = 'list';          // 'list' | 'sky'
const freshIds = new Set();      // 剛誕生的筆記：重點螢光筆掃一次
let skyRAF = null;

const activeBrains = () => brains.filter((b) => !b.retired);
const brainById = (id) => brains.find((b) => b.id === id);
const brainNotes = (id) => notes.filter((n) => n.brainId === id);
function brainTags(b) {
  const c = {};
  brainNotes(b.id).forEach((n) => (n.tags || []).forEach((t) => { c[t] = (c[t] || 0) + 1; }));
  return Object.entries(c).sort((a, b2) => b2[1] - a[1]).slice(0, 6).map((e) => e[0]);
}

/* ---------------- 主人格 ---------------- */
function renderPersona(growing) {
  if (!$('personaMood')) return;  // v5：側欄 UI 已移除
  document.documentElement.style.setProperty('--mood', persona.color || '#c2703d');
  $('personaMood').textContent = persona.mood || '';
  $('personaName').textContent = persona.name || '檔期助手';
  $('personaGreeting').textContent = persona.greeting || '';
  $('statNotes').textContent = notes.length;
  $('statPoints').textContent = notes.reduce((a, n) => a + (n.keyPoints ? n.keyPoints.length : 0), 0);
  if (growing) {
    const orb = $('activityDot');
    orb.classList.remove('growing'); void orb.offsetWidth; orb.classList.add('growing');
  }
}

async function absorbHost(silent) {
  const pool = notes.filter((n) => !n.counted);
  const target = (pool.length ? pool : notes).slice(0, 12);
  if (target.length === 0) { if (!silent) toast('還沒有筆記可以吸收'); return; }
  const ab = $('absorbBtn');
  if (!silent && ab) { ab.disabled = true; ab.textContent = '吸收中…'; }
  try {
    const d = await aiTask('notebook-absorb', {
      persona: { name: persona.name, mood: persona.mood, traits: persona.traits, bio: persona.bio },
      notes: target.map((n) => ({ title: n.title, summary: n.summary, tags: n.tags })),
    });
    const p = extractJSON(d.text);
    if (!p || !p.mood) throw new Error('bad-json');
    if (p.name && p.name.trim()) persona.name = p.name.trim().slice(0, 12);
    persona.mood = String(p.mood).slice(0, 16);
    const c = validColor(p.color); if (c) persona.color = c;
    if (p.greeting) persona.greeting = String(p.greeting).slice(0, 120);
    if (Array.isArray(p.traits)) persona.traits = p.traits.filter((t) => typeof t === 'string').map((t) => t.slice(0, 12)).slice(0, 6);
    if (p.bio) persona.bio = String(p.bio).slice(0, 200);
    target.forEach((n) => { n.counted = true; });
    save(LS_PERSONA, persona); save(LS_NOTES, notes);
    renderAll(true);
    if (p.comment && !silent) { pushChatMsg('bot', String(p.comment).slice(0, 120)); openChat(); }
    else if (!silent) toast('已更新');
  } catch (e) {
    if (!silent) toast('這次沒能好好思考，下次再試');
  } finally {
    if (!silent) {
      const ab2 = $('absorbBtn');
      if (ab2) { ab2.disabled = false; ab2.textContent = '主人格吸收長大'; }
    }
  }
}

/* ---------------- 檔期篩選 ---------------- */
const PHASES = [
  { id: 'active', name: '進行中', color: '#3d7a34' },
  { id: 'expiring', name: '即將到期', color: '#b3402e' },
  { id: 'upcoming', name: '未開始', color: '#4a6fa5' },
  { id: 'ended', name: '已結束', color: '#a89d8c' },
];
function renderPhases() {
  const el = $('phaseChips');
  if (!el) return;
  const counts = { all: notes.length, active: 0, expiring: 0, upcoming: 0, ended: 0 };
  notes.forEach((n) => {
    const p = phaseOf(n);
    if (p === 'nodate') counts.active++;
    else if (counts[p] !== undefined) counts[p]++;
  });
  const items = [{ id: 'all', name: '全部', color: '#a79c8b' }, ...PHASES];
  el.innerHTML = items.map((p) =>
    `<button class="phase-chip ${selectedPhase === p.id ? 'active' : ''}" data-phase="${p.id}">
      <span class="dot" style="background:${p.color}"></span>${p.name}<span class="n">${counts[p.id]}</span>
    </button>`).join('');
}
/* 到期橫幅：7 天內到期的活動 */
function renderExpiryBanner() {
  const el = $('expiryBanner');
  if (!el) return;
  const list = notes
    .filter((n) => { const d = daysUntil(n.eventEnd); return d !== null && d >= 0 && d <= 7; })
    .sort((a, b) => daysUntil(a.eventEnd) - daysUntil(b.eventEnd))
    .slice(0, 5);
  if (!list.length || selectedPhase !== 'all') { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = `<b>${list.length} 則活動即將到期</b>
    <ul>${list.map((n) => {
      const d = daysUntil(n.eventEnd);
      const label = d === 0 ? '今天到期' : `剩 ${d} 天`;
      return `<li><span>${esc(String(n.eventName || n.title || '未命名').slice(0, 20))}</span>
        <button class="eb-go" data-id="${n.id}">${label} →</button></li>`;
    }).join('')}</ul>`;
}

/* ---------------- 大腦列表 ---------------- */
function renderBrains() {
  const list = $('brainList');
  if (!list) return;  // v5：側欄 UI 已移除
  const inboxCount = notes.filter((n) => !n.brainId).length;
  let html = `<button class="brain-row all ${selectedBrain === 'all' ? 'active' : ''}" data-brain="all">
      <span class="brain-dot"></span><span class="brain-row-name">全部</span>
      <span class="brain-row-meta">${notes.length} 則</span></button>`;
  if (inboxCount > 0) {
    html += `<button class="brain-row inbox ${selectedBrain === 'inbox' ? 'active' : ''}" data-brain="inbox">
      <span class="brain-dot"></span><span class="brain-row-name">待分類</span>
      <span class="brain-row-meta">${inboxCount} 則</span></button>`;
  }
  activeBrains().forEach((b) => {
    const n = brainNotes(b.id).length;
    html += `<button class="brain-row ${selectedBrain === b.id ? 'active' : ''}" data-brain="${b.id}"
        style="--brain-color:${esc(b.color || '#c2703d')}" id="brow-${b.id}">
      <span class="brain-dot"></span>
      <span class="brain-row-name">${esc(b.name)}</span>
      <span class="brain-row-meta">Lv.${b.level || 1} · ${n}則</span></button>`;
  });
  list.innerHTML = html;
  $('brainsCount').textContent = activeBrains().length ? `${activeBrains().length} 個大腦` : '還沒長出來';
  // 星系視圖開著時，大腦有變動就重畫星空
  if (brainView === 'sky' && !$('constellationWrap').classList.contains('hidden')) startConstellation();
}

/* ---------------- 大腦星系（神經突觸視圖） ---------------- */
function setBrainView(v) {
  brainView = v;
  if (!$('viewListBtn')) return;  // v5：側欄 UI 已移除
  $('viewListBtn').classList.toggle('active', v === 'list');
  $('viewSkyBtn').classList.toggle('active', v === 'sky');
  $('brainList').classList.toggle('hidden', v !== 'list');
  $('constellationWrap').classList.toggle('hidden', v !== 'sky');
  if (v === 'sky') startConstellation(); else stopConstellation();
}
function stopConstellation() {
  if (skyRAF) { cancelAnimationFrame(skyRAF); skyRAF = null; }
}
function startConstellation() {
  stopConstellation();
  const cv = $('brainCanvas');
  const wrap = $('constellationWrap');
  if (!cv || !wrap || wrap.classList.contains('hidden')) return;
  const W = Math.max(200, wrap.clientWidth || 260), H = 280;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stars = Array.from({ length: 70 }, () => ({
    x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.3 + 0.3, tw: Math.random() * 6.28,
  }));
  const list = activeBrains().slice(0, 12);
  if (!list.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.font = '13px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('還沒有大腦，丟東西進來就會長出來', W / 2, H / 2);
    return;
  }
  const cx = W / 2, cy = H / 2 - 8, R = Math.min(W, H) / 2 - 36;
  const nodes = list.map((b, i) => {
    const a = (i / list.length) * Math.PI * 2 - Math.PI / 2;
    return {
      b, x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R * 0.8,
      r: 15 + Math.min(10, brainNotes(b.id).length * 1.4), parts: [],
    };
  });
  nodes.forEach((nd) => {
    const cnt = Math.min(7, brainNotes(nd.b.id).length);
    for (let i = 0; i < cnt; i++) {
      nd.parts.push({ a: Math.random() * 6.28, d: nd.r + 9 + Math.random() * 15,
        s: 0.006 + Math.random() * 0.012, sz: 1.2 + Math.random() * 1.8 });
    }
  });
  // 突觸光纖：共享 ≥2 個標籤的大腦連線
  const links = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const ti = new Set(brainTags(nodes[i].b)), tj = new Set(brainTags(nodes[j].b));
    let shared = 0; ti.forEach((t) => { if (tj.has(t)) shared++; });
    if (shared >= 2) links.push([i, j]);
  }
  const draw = (t) => {
    ctx.clearRect(0, 0, W, H);
    stars.forEach((s) => {
      const a = 0.22 + 0.33 * Math.abs(Math.sin(t * 0.8 + s.tw));
      ctx.fillStyle = `rgba(255,255,255,${a.toFixed(2)})`;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.29); ctx.fill();
    });
    links.forEach(([i, j]) => {
      const A = nodes[i], B = nodes[j];
      const g = ctx.createLinearGradient(A.x, A.y, B.x, B.y);
      g.addColorStop(0, A.b.color || '#8a7fd6'); g.addColorStop(1, B.b.color || '#8a7fd6');
      ctx.strokeStyle = g; ctx.globalAlpha = 0.45; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
      ctx.globalAlpha = 1;
    });
    nodes.forEach((nd) => {
      nd.parts.forEach((p) => {
        if (!reduced) p.a += p.s;
        const px = nd.x + Math.cos(p.a) * p.d, py = nd.y + Math.sin(p.a) * p.d;
        ctx.fillStyle = nd.b.color || '#8a7fd6'; ctx.globalAlpha = 0.8;
        ctx.beginPath(); ctx.arc(px, py, p.sz, 0, 6.29); ctx.fill(); ctx.globalAlpha = 1;
      });
      const col = nd.b.color || '#8a7fd6';
      const glow = ctx.createRadialGradient(nd.x, nd.y, 2, nd.x, nd.y, nd.r + 13);
      glow.addColorStop(0, col + 'cc'); glow.addColorStop(1, col + '00');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(nd.x, nd.y, nd.r + 13, 0, 6.29); ctx.fill();
      ctx.fillStyle = '#221f28';
      ctx.beginPath(); ctx.arc(nd.x, nd.y, nd.r, 0, 6.29); ctx.fill();
      ctx.strokeStyle = selectedBrain === nd.b.id ? '#ffffff' : col;
      ctx.lineWidth = selectedBrain === nd.b.id ? 3 : 2;
      ctx.beginPath(); ctx.arc(nd.x, nd.y, nd.r, 0, 6.29); ctx.stroke();
      ctx.font = `${Math.round(nd.r * 1.05)}px serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = nd.b.color || '#c2703d';
      ctx.beginPath(); ctx.arc(nd.x, nd.y, nd.r * 0.42, 0, 6.29); ctx.fill();
      ctx.font = '11px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.88)';
      ctx.fillText(String(nd.b.name).slice(0, 8), nd.x, nd.y + nd.r + 11);
    });
  };
  cv.onclick = (e) => {
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best = null, bd = 1e9;
    nodes.forEach((nd) => {
      const d = Math.hypot(nd.x - x, nd.y - y);
      if (d < nd.r + 16 && d < bd) { bd = d; best = nd; }
    });
    if (best) {
      selectedBrain = best.b.id;
      renderBrains(); renderBrainDetail(); renderNotes();
      toast(`進入「${best.b.name}」`);
    }
  };
  if (reduced) { draw(0); return; }
  const frame = () => { draw(performance.now() / 1000); skyRAF = requestAnimationFrame(frame); };
  frame();
}

/* ---------------- 腦內詳情 ---------------- */
function renderBrainDetail() {
  const el = $('brainDetail');
  if (!el) return;  // v5：側欄 UI 已移除
  if (selectedBrain === 'all' || selectedBrain === 'inbox') {
    if (selectedBrain === 'inbox') {
      el.classList.remove('hidden');
      el.innerHTML = `<div class="brain-detail-head"><span class="brain-dot" style="--brain-color:#e8e0cd"></span>
        <div><h2 class="brain-detail-name">待分類</h2>
        <p class="brain-detail-desc">這些還沒被大腦認領。按一下，讓 AI 幫它們找到家。</p></div></div>
        <button class="btn-primary" id="classifyAllBtn">一鍵自動分類</button>`;
      const btn = $('classifyAllBtn');
      if (btn) btn.onclick = classifyInbox;
    } else el.classList.add('hidden');
    return;
  }
  const b = brainById(selectedBrain);
  if (!b) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.style.setProperty('--brain-color', b.color || '#c2703d');
  const lv = Math.min(5, Math.max(1, b.level || 1));
  const dots = '●'.repeat(lv) + '○'.repeat(5 - lv);
  const gaps = (b.gaps || []).length
    ? `<div class="brain-gaps"><span class="gaps-label">想學的：</span>${b.gaps.map((g) => `<span class="gap-chip">${esc(g)}</span>`).join('')}</div>` : '';
  const born = b.spawnReason ? `<div class="brain-born">誕生原因：${esc(b.spawnReason)}</div>`
    : b.parentId ? `<div class="brain-born">從「${esc((brainById(b.parentId) || {}).name || '母腦')}」分裂而來</div>` : '';
  el.innerHTML = `
    <div class="brain-detail-head">
      <span class="brain-dot"></span>
      <div><h2 class="brain-detail-name">${esc(b.name)}</h2>
      <p class="brain-detail-desc">${esc(b.description || '')}</p></div>
      <span class="brain-level"><span class="dots">${dots}</span> Lv.${lv}</span>
    </div>
    ${b.summary ? `<p class="brain-summary">${esc(b.summary)}</p>` : '<p class="brain-summary">這個大腦剛誕生，還在認識世界…</p>'}
    ${gaps}${born}`;
}

async function classifyInbox() {
  const pending = notes.filter((n) => !n.brainId);
  if (!pending.length) return;
  toast(`開始分類 ${pending.length} 則…`);
  for (const n of pending) {
    await routeNote(n, true);
  }
  renderAll();
  toast('分類完成');
}

/* ---------------- 全自動管線 ---------------- */
function pipelineStep(text, done) {
  const box = $('modalPipeline');
  box.classList.remove('hidden');
  const div = document.createElement('div');
  div.className = 'pipeline-step' + (done ? ' done' : '');
  div.textContent = (done ? '✓ ' : '… ') + text;
  const prev = box.querySelector('.pipeline-step:not(.done)');
  if (prev && done !== false) { prev.classList.add('done'); prev.textContent = '✓ ' + prev.textContent.slice(2); }
  box.appendChild(div);
  return div;
}

async function fetchIngest(url) {
  if (!INGEST_URL) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(INGEST_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }), signal: ctrl.signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

/* 原地重抓：更新同一則，不建新的 */
async function retryIngest(id) {
  const n = notes.find((x) => x.id === id);
  if (!n || !n.url || pipelining) return;
  pipelining = true;
  toast('↻ 重新抓取中…');
  try {
    const data = await fetchIngest(n.url);
    if (data && (data.title || data.summary)) {
      n.title = data.title || n.url;
      n.summary = data.summary || '';
      n.keyPoints = Array.isArray(data.key_points) ? data.key_points.slice(0, 5) : [];
      n.tags = Array.isArray(data.tags) ? data.tags.slice(0, 5) : [];
      n.site = (data.source && data.source.site) || '';
      save(LS_NOTES, notes);
      await routeNote(n, true);
      if (n.brainId) await evolveBrain(n.brainId, n);
      renderAll();
      toast('抓到了');
    } else {
      toast('還是抓不到，稍後再試試');
    }
  } finally { pipelining = false; }
}

/* 手動補充：影片穿隱形衣時，主人餵內容給它 */
let suppId = null;
function openSupplement(id) {
  const n = notes.find((x) => x.id === id);
  if (!n) return;
  suppId = id;
  $('suppDesc').textContent = `「${(n.title || n.url).slice(0, 40)}」穿了隱形衣，我抓不到內容。把你記得的、或影片下方的簡介貼上來，我來整理成重點。`;
  $('suppText').value = '';
  $('suppLoading').classList.add('hidden');
  $('suppSave').disabled = false;
  $('suppBackdrop').classList.remove('hidden');
  setTimeout(() => $('suppText').focus(), 50);
}
function closeSupplement() { $('suppBackdrop').classList.add('hidden'); suppId = null; }
async function saveSupplement() {
  const text = $('suppText').value.trim();
  if (!text || !suppId || pipelining) return;
  const n = notes.find((x) => x.id === suppId);
  if (!n) { closeSupplement(); return; }
  pipelining = true;
  $('suppLoading').classList.remove('hidden');
  $('suppSave').disabled = true;
  try {
    const d = await aiTask('notebook-summarize', { title: n.title, text }, 60000);
    const s = extractJSON(d.text);
    if (!s || !s.summary) throw new Error('bad-json');
    n.summary = String(s.summary).slice(0, 120);
    n.keyPoints = Array.isArray(s.key_points) ? s.key_points.filter((x) => typeof x === 'string').map((x) => x.slice(0, 80)).slice(0, 5) : [];
    n.tags = Array.isArray(s.tags) ? s.tags.filter((x) => typeof x === 'string').map((x) => x.slice(0, 12)).slice(0, 5) : [];
    n.needsHelp = false;
    save(LS_NOTES, notes);
    freshIds.add(n.id);
    await routeNote(n, true);
    if (n.brainId) await evolveBrain(n.brainId, n);
    maybeAbsorbHost();
    absorbBurst();
    closeSupplement(); renderAll();
    toast('補充完成');
  } catch (e) {
    toast('整理失敗，再試一次');
  } finally {
    pipelining = false;
    $('suppLoading').classList.add('hidden');
    $('suppSave').disabled = false;
  }
}

async function addLinkNote(url) {
  if (pipelining) return;
  pipelining = true;
  $('activityDot').classList.add('working');
  $('modalLoading').classList.remove('hidden');
  $('modalPipeline').innerHTML = '';
  $('modalSave').disabled = true;
  try {
    pipelineStep('把內容抓回來');
    $('modalLoadingText').textContent = '正在把內容抓回來…';
    const data = await fetchIngest(url);
    const partial = data && data.partial;
    const note = {
      id: uid(), type: 'link', url,
      title: (data && data.title) || url,
      summary: (data && data.summary) || '',
      keyPoints: (data && data.key_points) || [],
      tags: (data && data.tags) || [],
      site: (data && data.source && data.source.site) || '',
      author: (data && data.author) || '',
      needsHelp: !!partial || !data,
      brainId: null, createdAt: Date.now(),
    };
    if (!data) note.summary = '';
    notes.unshift(note); save(LS_NOTES, notes);
    freshIds.add(note.id);
    pipelineStep('把內容抓回來', true);

    $('modalLoadingText').textContent = 'AI 正在摘要重點…';
    pipelineStep('摘要成重點', true); // ingest 已做

    $('modalLoadingText').textContent = '正在分類進大腦…';
    const s = pipelineStep('分類進大腦');
    await routeNote(note);
    s.classList.add('done'); s.textContent = '✓ 分類進大腦';

    $('modalLoadingText').textContent = '大腦正在進化…';
    const s2 = pipelineStep('大腦進化中');
    if (note.brainId) await evolveBrain(note.brainId, note);
    s2.classList.add('done'); s2.textContent = '✓ 大腦進化完成';

    maybeAbsorbHost();
    absorbBurst();
    closeModal(true); renderAll();
  } finally {
    pipelining = false;
    $('activityDot').classList.remove('working');
    $('modalLoading').classList.add('hidden');
    $('modalSave').disabled = false;
    $('linkUrl').value = '';
  }
}

/* 把 AI 回傳的日期欄位整理進筆記 */
function applyEventFields(note, s) {
  const cleanDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : null;
  const cleanStr = (v, max) => (v && String(v).trim()) ? String(v).trim().slice(0, max || 30) : null;
  note.eventName = cleanStr(s.event_name, 30);
  note.brand = cleanStr(s.brand, 20);
  note.eventStart = cleanDate(s.event_start);
  note.eventEnd = cleanDate(s.event_end);
}
async function finalizeNote(note, s, doneLabels) {
  note.summary = String(s.summary || '').slice(0, 120);
  const rawPts = Array.isArray(s.key_points) ? s.key_points.filter((x) => typeof x === 'string').map((x) => x.slice(0, 80)) : [];
  // 去重：去掉重複、以及跟摘要重複的重點
  const seen = new Set();
  note.keyPoints = rawPts.filter((p) => {
    const k = p.replace(/\s/g, '');
    if (!k || seen.has(k)) return false;
    const sk = note.summary.replace(/\s/g, '');
    if (sk.includes(k) || k.includes(sk)) return false;
    seen.add(k);
    return true;
  }).slice(0, 5);
  note.tags = Array.isArray(s.tags) ? s.tags.filter((x) => typeof x === 'string').map((x) => x.slice(0, 12)).slice(0, 5) : [];
  applyEventFields(note, s);
  notes.unshift(note); save(LS_NOTES, notes);
  freshIds.add(note.id);
  (doneLabels || []).forEach((t) => pipelineStep(t, true));
  const s2 = pipelineStep('分類進大腦');
  await routeNote(note);
  s2.classList.add('done'); s2.textContent = '✓ 分類進大腦';
  const s3 = pipelineStep('大腦進化中');
  if (note.brainId) await evolveBrain(note.brainId, note);
  s3.classList.add('done'); s3.textContent = '✓ 大腦進化完成';
  maybeAbsorbHost();
  absorbBurst();
  closeModal(true); renderAll();
}

/* Tesseract 中文 OCR（瀏覽器端，免 key） */
let tesseractWorker = null;
async function ocrImage(dataURL, onProgress) {
  await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
  if (!tesseractWorker) {
    tesseractWorker = await Tesseract.createWorker('chi_tra', 1, {
      logger: (m) => { if (m.status === 'recognizing text' && onProgress) onProgress(Math.round(m.progress * 100)); },
    });
  }
  const { data: { text } } = await tesseractWorker.recognize(dataURL);
  return (text || '').replace(/[ \t]+/g, ' ').trim();
}
/* pdf.js 抽文字（瀏覽器端，免 key） */
async function extractPdfText(file, onProgress) {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  const pages = Math.min(pdf.numPages, 15);
  for (let i = 1; i <= pages; i++) {
    if (onProgress) onProgress(Math.round((i / pages) * 100));
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    text += tc.items.map((it) => it.str).join('') + '\n';
    if (text.length > 9000) break;
  }
  return text.slice(0, 9000).trim();
}

let pendingImages = [];  // [{ dataURL, thumb }]
let pendingPdf = null;
async function handleImageFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith('image/')).slice(0, 10);
  if (!list.length) { toast('請選擇圖片檔'); return; }
  for (const file of list) {
    try {
      const img = await loadImageFromFile(file);
      pendingImages.push({
        dataURL: downscaleImage(img, 1600, 0.85),
        thumb: downscaleImage(img, 480, 0.75),
      });
    } catch { /* 單張失敗略過 */ }
  }
  renderImgPreviews();
  if (pendingImages.length) toast(`已選 ${pendingImages.length} 張，按「新增」開始辨識`);
}
function renderImgPreviews() {
  const box = $('imgPreviewList');
  box.innerHTML = pendingImages.map((p, i) =>
    `<div class="img-preview-item"><img src="${p.thumb}" alt="圖片${i + 1}">
     <button data-rmimg="${i}" aria-label="移除">×</button></div>`).join('');
}
async function addImageNotes() {
  if (pipelining || !pendingImages.length) return;
  pipelining = true;
  const hint = $('imgHint').value.trim();
  const queue = pendingImages.splice(0, pendingImages.length);
  renderImgPreviews();
  $('imgHint').value = '';
  $('activityDot').classList.add('working');
  $('modalLoading').classList.remove('hidden');
  $('modalPipeline').innerHTML = '';
  $('modalSave').disabled = true;
  let okCount = 0;
  try {
    for (let idx = 0; idx < queue.length; idx++) {
      const p = queue[idx];
      $('modalLoadingText').textContent = `處理第 ${idx + 1}/${queue.length} 張…`;
      pipelineStep(`第 ${idx + 1} 張：辨識圖片文字`);
      try {
        const ocrText = await ocrImage(p.dataURL, (pct) => {
          $('modalLoadingText').textContent = `第 ${idx + 1}/${queue.length} 張辨識中 ${pct}%…`;
        });
        if (!ocrText || ocrText.replace(/\s/g, '').length < 10) {
          pipelineStep(`第 ${idx + 1} 張：文字太少，已略過`, true);
          continue;
        }
        $('modalLoadingText').textContent = `第 ${idx + 1}/${queue.length} 張 AI 整理中…`;
        const d = await aiTask('notebook-summarize', {
          title: hint || 'DM圖片',
          text: (hint ? `補充說明：${hint}\n` : '') + ocrText.slice(0, 4000),
        }, 60000);
        const s = extractJSON(d.text);
        if (!s || !s.summary) throw new Error('bad-json');
        const note = {
          id: uid(), type: 'image',
          title: (hint || s.event_name || (s.brand ? s.brand + '活動' : null) || 'DM圖片').slice(0, 30),
          image: p.thumb,
          brainId: null, createdAt: Date.now(),
        };
        note.summary = String(s.summary || '').slice(0, 120);
        note.keyPoints = Array.isArray(s.key_points) ? s.key_points.filter((x) => typeof x === 'string').map((x) => x.slice(0, 80)).slice(0, 5) : [];
        note.tags = Array.isArray(s.tags) ? s.tags.filter((x) => typeof x === 'string').map((x) => x.slice(0, 12)).slice(0, 5) : [];
        applyEventFields(note, s);
        notes.unshift(note); freshIds.add(note.id);
        try { await routeNote(note, true); } catch {}
        if (note.brainId) { try { await evolveBrain(note.brainId, note); } catch {} }
        pipelineStep(`第 ${idx + 1} 張：完成`, true);
        okCount++;
      } catch (e) {
        pipelineStep(`第 ${idx + 1} 張：處理失敗，已略過`, true);
      }
      if (idx < queue.length - 1) await new Promise((r) => setTimeout(r, 1200));
    }
    save(LS_NOTES, notes);
    maybeAbsorbHost();
    absorbBurst();
    closeModal(true); renderAll();
    toast(okCount === queue.length ? `完成，共新增 ${okCount} 張` : `完成 ${okCount}/${queue.length} 張`);
  } finally {
    pipelining = false;
    $('activityDot').classList.remove('working');
    $('modalLoading').classList.add('hidden');
    $('modalSave').disabled = false;
  }
}
async function addPdfNote(file) {
  if (pipelining || !file) return;
  pipelining = true;
  $('activityDot').classList.add('working');
  $('modalLoading').classList.remove('hidden');
  $('modalPipeline').innerHTML = '';
  $('modalSave').disabled = true;
  try {
    const s1 = pipelineStep('讀取 PDF 文字');
    const text = await extractPdfText(file, (p) => {
      $('modalLoadingText').textContent = `讀取 PDF 中 ${p}%…`;
    });
    s1.classList.add('done'); s1.textContent = '✓ PDF 文字讀取完成';
    if (!text || text.replace(/\s/g, '').length < 20) {
      toast('PDF 抓不到文字（可能是掃描圖），試試用圖片方式');
      return;
    }
    $('modalLoadingText').textContent = 'AI 正在整理活動資訊…';
    const d = await aiTask('notebook-summarize', {
      title: file.name.replace(/\.pdf$/i, ''),
      text: text.slice(0, 4000),
    }, 60000);
    const s = extractJSON(d.text);
    if (!s || !s.summary) throw new Error('bad-json');
    const note = {
      id: uid(), type: 'pdf',
      title: (s.event_name || file.name.replace(/\.pdf$/i, '')).slice(0, 30),
      brainId: null, createdAt: Date.now(),
    };
    await finalizeNote(note, s, ['PDF 文字讀取完成', 'AI 整理完成']);
    $('pdfName').textContent = '';
  } catch (e) {
    toast('PDF 處理失敗，再試一次');
  } finally {
    pipelining = false;
    $('activityDot').classList.remove('working');
    $('modalLoading').classList.add('hidden');
    $('modalSave').disabled = false;
  }
}

async function addTextNote(title, body) {
  if (pipelining) return;
  pipelining = true;
  $('activityDot').classList.add('working');
  $('modalLoading').classList.remove('hidden');
  $('modalPipeline').innerHTML = '';
  $('modalSave').disabled = true;
  try {
    $('modalLoadingText').textContent = 'AI 正在整理…';
    let s = null;
    try {
      const d = await aiTask('notebook-summarize', { title: title || body.slice(0, 24), text: body.slice(0, 4000) }, 60000);
      s = extractJSON(d.text);
    } catch { s = null; }
    const note = {
      id: uid(), type: 'text',
      title: title || body.slice(0, 24) || '未命名',
      body, summary: '', keyPoints: [],
      tags: autoTags(body + title), brainId: null, createdAt: Date.now(),
    };
    if (s && s.summary) {
      await finalizeNote(note, s, ['AI 整理完成']);
    } else {
      // AI 失敗：保留純文字，不遺失
      notes.unshift(note); save(LS_NOTES, notes);
      freshIds.add(note.id);
      await routeNote(note);
      if (note.brainId) await evolveBrain(note.brainId, note);
      maybeAbsorbHost();
      absorbBurst();
      closeModal(true); renderAll();
    }
    $('textTitle').value = ''; $('textBody').value = '';
  } finally {
    pipelining = false;
    $('activityDot').classList.remove('working');
    $('modalLoading').classList.add('hidden');
    $('modalSave').disabled = false;
  }
}

function autoTags(text) {
  const kws = ['投資', '理財', '股票', '健康', '長照', '美食', '旅遊', '科技', 'AI', '育兒', '房產', '運動', '職場'];
  return kws.filter((k) => text.includes(k)).slice(0, 4);
}

/* 自動分類：丟進現有大腦，或誕生新大腦 */
async function routeNote(note, quiet) {
  const targets = activeBrains().map((b) => ({ id: b.id, name: b.name, description: b.description, tags: brainTags(b) }));
  try {
    const d = await aiTask('notebook-route', {
      note: { title: note.title, summary: note.summary, tags: note.tags },
      brains: targets,
    }, 45000);
    const r = extractJSON(d.text);
    if (!r) throw new Error('bad-json');
    if (r.action === 'join' && brainById(r.brain_id)) {
      note.brainId = r.brain_id;
    } else if (r.action === 'new' && r.brain && r.brain.name) {
      const nb = makeBrain(r.brain);
      brains.unshift(nb); save(LS_BRAINS, brains);
      note.brainId = nb.id;
      if (!quiet) {
        toast(`新大腦「${nb.name}」已建立`);
        setTimeout(() => {
          const row = $('brow-' + nb.id);
          if (row) row.classList.add('brain-new');
        }, 50);
      }
    }
  } catch (e) {
    // 失敗就先放待分類，不丟失
    note.brainId = null;
  }
  save(LS_NOTES, notes);
}

function makeBrain(b) {
  return {
    id: uid('b'),
    name: String(b.name || '新大腦').slice(0, 10),
    color: validColor(b.color) || '#8a7fd6',
    description: String(b.description || '').slice(0, 40),
    summary: '', gaps: [], level: 1,
    createdAt: Date.now(), parentId: b.parentId || null,
    spawnReason: b.spawnReason || '', retired: false,
  };
}

/* 大腦進化：摘要/缺口/等級/分裂/繁衍/思考筆記 */
async function evolveBrain(brainId, newNote) {
  const b = brainById(brainId);
  if (!b || b.retired) return;
  const list = brainNotes(brainId).slice(0, 20);
  if (!list.length) return;

  // 缺口被餵食：新筆記標籤命中大腦的「想學的」
  if (newNote && (b.gaps || []).length && (newNote.tags || []).length) {
    const hit = b.gaps.find((g) => newNote.tags.some((t) => t.includes(g) || g.includes(t)));
    if (hit) setTimeout(() => toast(`「${b.name}」找到了想學的「${hit}」`), 600);
  }

  try {
    const d = await aiTask('notebook-evolve', {
      brain: { name: b.name, description: b.description, summary: b.summary },
      notes: list.map((n) => ({ id: n.id, title: n.title, summary: n.summary })),
    }, 60000);
    const evo = extractJSON(d.text);
    if (!evo) return;
    if (evo.summary) b.summary = String(evo.summary).slice(0, 160);
    if (Array.isArray(evo.gaps)) b.gaps = evo.gaps.filter((g) => typeof g === 'string').map((g) => g.slice(0, 14)).slice(0, 4);
    if (Number.isInteger(evo.level)) b.level = Math.min(5, Math.max(1, evo.level));

    // 分裂
    if (evo.split && Array.isArray(evo.split.brains) && evo.split.brains.length >= 2 && list.length >= 6) {
      const kids = evo.split.brains.slice(0, 3).map((kb) => {
        const nb = makeBrain(kb); nb.parentId = b.id; return nb;
      });
      const assign = evo.split.assign || {};
      const nameToKid = {};
      kids.forEach((k) => { nameToKid[k.name] = k; });
      list.forEach((n) => {
        const want = assign[n.id];
        const kid = want && nameToKid[want];
        n.brainId = (kid || kids[0]).id;
      });
      b.retired = true;
      brains.unshift(...kids);
      if (selectedBrain === b.id) selectedBrain = kids[0].id;
      setTimeout(() => toast(`「${b.name}」已拆分為 ${kids.map((k) => `「${k.name}」`).join('、')}`), 900);
    }

    // 繁衍：意想不到的新大腦
    if (evo.spawn && evo.spawn.name && !b.retired) {
      const nb = makeBrain(evo.spawn);
      nb.spawnReason = String(evo.spawn.reason || '').slice(0, 60);
      brains.unshift(nb);
      setTimeout(() => toast(`新增分類「${nb.name}」${nb.spawnReason ? '（' + nb.spawnReason + '）' : ''}`), 1400);
    }

    // 思考筆記：大腦自己長出的連結
    if (evo.synthesis && evo.synthesis.body && !b.retired) {
      const targetBrain = b.id;
      notes.unshift({
        id: uid(), type: 'synth', ai: true,
        title: String(evo.synthesis.title || '腦的思考').slice(0, 30),
        body: String(evo.synthesis.body).slice(0, 400),
        summary: '', keyPoints: [], tags: brainTags(b).slice(0, 3),
        brainId: targetBrain, createdAt: Date.now(),
      });
      setTimeout(() => toast(`「${b.name}」產生了一篇關聯整理`), 1800);
    }
    save(LS_BRAINS, brains); save(LS_NOTES, notes);
  } catch (e) { /* 進化失敗就維持現狀 */ }
}

let hostAbsorbCounter = 0;
function maybeAbsorbHost() {
  hostAbsorbCounter++;
  if (hostAbsorbCounter >= 5) {
    hostAbsorbCounter = 0;
    absorbHost(true);
    setTimeout(() => toast('助手已更新'), 2200);
  }
}

/* ---------------- 筆記渲染 ---------------- */
function filteredNotes() {
  const kw = searchKw.trim().toLowerCase();
  return notes
    .filter((n) => selectedBrain === 'all' ? true : selectedBrain === 'inbox' ? !n.brainId : n.brainId === selectedBrain)
    .filter((n) => {
      if (selectedPhase === 'all') return true;
      const p = phaseOf(n);
      if (selectedPhase === 'active') return p === 'active' || p === 'nodate';
      return p === selectedPhase;
    })
    .filter((n) => {
      if (!kw) return true;
      const hay = [n.title, n.summary, n.url, (n.keyPoints || []).join(' '), (n.tags || []).join(' '), n.body]
        .join(' ').toLowerCase();
      return hay.includes(kw);
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

function noteCard(n, idx) {
  const b = n.brainId && brainById(n.brainId);
  const cd = countdownChip(n);
  const dates = (n.eventStart || n.eventEnd)
    ? `${fmtDay(n.eventStart) || '?'} – ${fmtDay(n.eventEnd) || '?'}${n.brand ? ' · ' + esc(n.brand) : ''}` : '';
  const thumb = n.image ? `<img class="card-thumb" src="${n.image}" alt="" loading="lazy">` : '';
  const pts = (n.keyPoints || []).slice(0, 3).map((p) => `<span class="pt">${esc(p)}</span>`).join('');
  const failed = n.needsHelp || (n.type === 'link' && !n.summary && !(n.keyPoints || []).length);
  const helpHtml = failed ? `<p class="needs-help-msg"><b>抓不到內容</b>，你可以幫我補充，我來整理成重點。</p>` : '';
  const actionsHtml = failed
    ? `<button class="btn-mini" data-act="supplement">幫我補充</button><button class="btn-mini ghost" data-act="retry">↻ 重抓</button>`
    : (n.eventEnd ? `<button class="btn-ics" data-act="ics">加入行事曆</button>` : '');
  const titleHtml = n.url
    ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title || n.url)}</a>`
    : esc(n.title || '未命名');
  const delay = Math.min((idx || 0) * 50, 400);
  return `<article class="card${failed ? ' needs-help' : ''}" data-id="${n.id}" style="animation-delay:${delay}ms">
    <button class="card-del" data-act="del" title="刪除">×</button>
    ${thumb}
    <div class="card-body">
      <div class="card-top">
        <span class="card-title">${titleHtml}</span>
        ${cd}
      </div>
      ${dates ? `<div class="card-sub">${dates}</div>` : ''}
      ${n.summary ? `<p class="card-summary">${esc(n.summary)}</p>` : ''}
      ${(!n.summary && n.body) ? `<p class="card-summary">${esc(n.body.slice(0, 120))}</p>` : ''}
      ${pts ? `<div class="card-points">${pts}</div>` : ''}
      ${helpHtml}
      <div class="card-foot">
        <span class="brain-tag">${b ? esc(b.name) : ''}</span>
        <span class="card-actions">${actionsHtml}</span>
      </div>
    </div>
  </article>`;
}

function renderNotes() {
  const list = filteredNotes();
  $('notesGrid').innerHTML = list.map((n, i) => noteCard(n, i)).join('');
  freshIds.clear();   // 螢光筆只掃一次
  const showEmpty = list.length === 0;
  $('emptyState').style.display = showEmpty ? '' : 'none';
  $('notesGrid').style.display = showEmpty ? 'none' : '';
}

/* ---------------- 問筆記本 ---------------- */
function retrieve(question, k) {
  const words = question.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, ' ').split(/\s+/).filter((w) => w.length >= 2);
  const pool = selectedBrain === 'all' || selectedBrain === 'inbox'
    ? notes : notes.filter((n) => n.brainId === selectedBrain);
  const scored = pool.map((n) => {
    const hay = [n.title, n.summary, (n.keyPoints || []).join(' '), (n.tags || []).join(' '), n.body || ''].join(' ');
    let s = 0;
    words.forEach((w) => { if (hay.includes(w)) s += w.length >= 4 ? 3 : 1; });
    return { n, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const picked = scored.slice(0, k || 5).map((x) => x.n);
  return picked.length ? picked : pool.slice(0, 3);
}
function pushChatMsg(role, text, sources) {
  chatHistory.push({ role, content: text, sources: sources || null });
  if (chatHistory.length > 40) chatHistory = chatHistory.slice(-40);
  save(LS_CHAT, chatHistory);
  renderChat();
}
function renderChat() {
  const body = $('chatBody');
  body.innerHTML = chatHistory.map((m) => {
    let cite = '';
    if (m.role !== 'user' && Array.isArray(m.sources) && m.sources.length) {
      cite = `<div class="cite-cards">${m.sources.slice(0, 4).map((s) =>
        `<button class="cite-card" data-id="${esc(s.id)}">${esc(String(s.title || '未命名').slice(0, 18))}</button>`).join('')}</div>`;
    }
    return `<div class="msg ${m.role === 'user' ? 'user' : 'bot'}">${esc(m.content)}${cite}</div>`;
  }).join('');
  body.scrollTop = body.scrollHeight;
}
/* 點引用卡片 → 跳到那則筆記所屬的大腦 */
function jumpToNote(id) {
  const n = notes.find((x) => x.id === id);
  if (!n) return;
  renderAll();
  toast('已定位到相關筆記');
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function openChat() {
  setChatOpen(true);
  if (chatHistory.length === 0) {
    pushChatMsg('bot', '你好，我是你的檔期助手。問我任何活動的日期、優惠或到期資訊。');
  } else renderChat();
}
/* AI 助手：右側滑出面板 */
function setChatOpen(open) {
  const p = $('assistantPanel');
  if (!p) return;
  p.classList.toggle('hidden', !open);
  if (open) setTimeout(() => $('chatInput') && $('chatInput').focus(), 120);
}
function isChatOpen() { const p = $('assistantPanel'); return p && !p.classList.contains('hidden'); }
/* ---------------- 台股即時報價（瀏覽器直連證交所，有開 CORS） ---------------- */
const TW_STOCK_NAMES = {
'0050': '元大台灣50', '00631L': '元大台灣50正2', '00646': '元大S&P500',
'00935': '野村臺灣新科技50', '2330': '台積電', '2454': '聯發科',
'2317': '鴻海', '2308': '台達電', '2382': '廣達', '2303': '聯電',
'2881': '富邦金', '2882': '國泰金', '2603': '長榮',
};
const TW_NAME_TO_CODE = {};
Object.entries(TW_STOCK_NAMES).forEach(([code, name]) => {
  TW_NAME_TO_CODE[name] = code;
  TW_NAME_TO_CODE[name.replace('臺', '台')] = code;
});
function stockIntent(text) {
  return /股價|收盤|報價|漲|跌|多少|持股|成分|淨值/.test(String(text || ''));
}
function detectTwCodes(text) {
  const t = String(text || '');
  const found = [];
  Object.entries(TW_NAME_TO_CODE).forEach(([name, code]) => {
    if (t.includes(name) && !found.includes(code)) found.push(code);
  });
  (t.match(/\b\d{4}[A-Z]?\b/g) || []).forEach((c) => {
    const code = c.toUpperCase();
    if (TW_STOCK_NAMES[code] && !found.includes(code)) found.push(code);
  });
  return found.slice(0, 3);
}
async function fetchTwseQuote(code) {
  try {
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const r = await fetch(`https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${ymd}&stockNo=${code}`);
    const d = await r.json();
    if (!d || d.stat !== 'OK' || !Array.isArray(d.data) || d.data.length < 2) return null;
    const rows = d.data.slice(-2);
    const num = (s) => parseFloat(String(s).replace(/,/g, ''));
    const price = num(rows[1][6]);
    const prevClose = num(rows[0][6]);
    if (!Number.isFinite(price) || !Number.isFinite(prevClose) || prevClose <= 0) return null;
    const m = String(rows[1][0]).match(/(\d+)\/(\d+)\/(\d+)/);
    const chg = (price - prevClose) / prevClose * 100;
    return `${TW_STOCK_NAMES[code] || code}(${code}) ${m ? `${m[2]}/${m[3]}` : ''}收 ${price.toFixed(2)}，${chg >= 0 ? '漲' : '跌'}${Math.abs(chg).toFixed(2)}%`;
  } catch { return null; }
}
async function getMarketData(question) {
  if (!stockIntent(question)) return '';
  const recent = chatHistory.filter((m) => m.role === 'user').slice(-3).map((m) => m.content).join('\n');
  const codes = detectTwCodes(recent);
  if (!codes.length) return '';
  const lines = (await Promise.all(codes.map(fetchTwseQuote))).filter(Boolean);
  return lines.join('\n');
}
async function askChat() {
  const input = $('chatInput');
  const q = input.value.trim();
  if (!q || chatting) return;
  chatting = true;
  $('chatSend').disabled = true;
  $('activityDot').classList.add('working');
  input.value = '';
  pushChatMsg('user', q);
  const ctx = retrieve(q, 5);
  // 儀式感：主人格翻找記憶，相關筆記標題隱隱發光
  const ritual = document.createElement('div');
  ritual.className = 'msg bot ritual';
  ritual.innerHTML = '正在搜尋相關內容…' +
    (ctx.length ? `<div class="ritual-titles">${ctx.slice(0, 4).map((n) =>
      `<span>✦ ${esc(String(n.title || '未命名').slice(0, 22))}</span>`).join('')}</div>` : '');
  $('chatBody').appendChild(ritual);
  $('chatBody').scrollTop = $('chatBody').scrollHeight;
  try {
    const ctxPayload = ctx.map((n) => ({
      title: n.title, summary: n.summary || n.body || '', key_points: n.keyPoints, tags: n.tags,
      event_name: n.eventName || null, event_start: n.eventStart || null, event_end: n.eventEnd || null,
    }));
    const marketData = await getMarketData(q);
    const d = await aiTask('notebook-chat', {
      persona: { name: persona.name, mood: persona.mood },
      context_notes: ctxPayload,
      market_data: marketData,
      messages: chatHistory.slice(-8).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
    }, 45000);
    ritual.remove();
    const sources = ctx.map((n) => ({ id: n.id, title: n.title, brainId: n.brainId }));
    pushChatMsg('bot', d.text || '嗯…大腦們翻了一下，暫時沒想法，換個問法試試？', sources);
  } catch (e) {
    ritual.remove();
    pushChatMsg('bot', '大腦們現在有點累（連不上），稍後再問我一次吧。');
  } finally {
    chatting = false;
    $('chatSend').disabled = false;
    $('activityDot').classList.remove('working');
  }
}

/* ---------------- 匯出 / 匯入 ---------------- */
function exportData() {
  const blob = new Blob([JSON.stringify({ notes, brains, persona, exportedAt: Date.now() }, null, 2)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '活筆記-備份.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function importData(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const d = JSON.parse(rd.result);
      if (Array.isArray(d.notes)) { notes = d.notes; save(LS_NOTES, notes); }
      if (Array.isArray(d.brains)) { brains = d.brains; save(LS_BRAINS, brains); }
      if (d.persona && typeof d.persona === 'object') { persona = Object.assign(persona, d.persona); save(LS_PERSONA, persona); }
      selectedBrain = 'all';
      renderAll();
      toast('匯入完成！');
    } catch { toast('這個檔案讀不出來'); }
  };
  rd.readAsText(file);
}

/* ---------------- 新增對話框 ---------------- */
let modalTab = 'link';
function openModal() {
  if (pipelining) return;
  $('modalBackdrop').classList.remove('hidden');
  $('modalLoading').classList.add('hidden');
  $('modalPipeline').innerHTML = '';
  $('modalPipeline').classList.add('hidden');
  setTimeout(() => {
    const el = modalTab === 'link' ? $('linkUrl') : modalTab === 'text' ? $('textTitle')
      : modalTab === 'image' ? $('imgHint') : null;
    if (el) el.focus();
  }, 50);
}
function closeModal(force) { if (!pipelining || force) $('modalBackdrop').classList.add('hidden'); }
function setModalTab(t) {
  modalTab = t;
  document.querySelectorAll('.modal-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  ['link', 'text', 'image', 'pdf'].forEach((k) => {
    const pane = $('pane' + k[0].toUpperCase() + k.slice(1));
    if (pane) pane.classList.toggle('hidden', t !== k);
  });
}
async function saveNote() {
  if (modalTab === 'link') {
    const url = $('linkUrl').value.trim();
    if (!url) { $('linkUrl').focus(); return; }
    if (!/^https?:\/\//i.test(url)) { toast('請貼上完整的網址（http 開頭）'); return; }
    await addLinkNote(url);
  } else if (modalTab === 'text') {
    const title = $('textTitle').value.trim();
    const body = $('textBody').value.trim();
    if (!body && !title) { $('textBody').focus(); return; }
    await addTextNote(title, body);
  } else if (modalTab === 'image') {
    if (!pendingImages.length) { toast('請先選擇或貼上圖片'); return; }
    await addImageNotes();
  } else if (modalTab === 'pdf') {
    const f = $('pdfFile').files[0] || pendingPdf;
    if (!f) { toast('請先選擇 PDF'); return; }
    await addPdfNote(f);
  }
}

/* ---------------- 事件 ---------------- */
function renderAll() { renderPhases(); renderExpiryBanner(); renderNotes(); }
function bind() {
  $('addBtn').onclick = openModal;
  $('emptyAddBtn').onclick = () => { setModalTab('image'); openModal(); };
  $('modalCancel').onclick = closeModal;
  $('modalBackdrop').addEventListener('click', (e) => { if (e.target === $('modalBackdrop')) closeModal(); });
  $('modalSave').onclick = saveNote;
  document.querySelectorAll('.modal-tab').forEach((b) => { b.onclick = () => setModalTab(b.dataset.tab); });
  $('linkUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveNote(); });

  $('suppCancel').onclick = closeSupplement;
  $('suppSave').onclick = saveSupplement;
  $('suppBackdrop').addEventListener('click', (e) => { if (e.target === $('suppBackdrop')) closeSupplement(); });

  /* 圖片 / PDF：點選＋拖曳＋貼上 */
  function bindDrop(zoneId, inputId, handler) {
    const zone = $(zoneId), input = $(inputId);
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => {
      if (!input.files.length) return;
      if (input.multiple) handler([...input.files]);
      else handler(input.files[0]);
      input.value = '';
    });
    ['dragover', 'dragenter'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragover'); }));
    zone.addEventListener('drop', (e) => {
      const fs = e.dataTransfer && e.dataTransfer.files;
      if (!fs || !fs.length) return;
      handler(input.multiple ? [...fs] : fs[0]);
    });
  }
  bindDrop('imgDrop', 'imgFile', (f) => handleImageFiles(Array.isArray(f) ? f : [f]));
  bindDrop('pdfDrop', 'pdfFile', (f) => {
    if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) { toast('請選擇 PDF 檔'); return; }
    pendingPdf = f;
    $('pdfName').textContent = `已選：${f.name}`;
    toast('PDF 就緒，按「新增」開始整理');
  });
  // Ctrl+V 貼圖片（圖片分頁開啟時，可多張）
  document.addEventListener('paste', (e) => {
    if (modalTab !== 'image' || $('modalBackdrop').classList.contains('hidden')) return;
    const files = [...(e.clipboardData?.items || [])]
      .filter((i) => i.type.startsWith('image/'))
      .map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) handleImageFiles(files);
  });
  // 預覽列移除單張
  $('imgPreviewList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rmimg]');
    if (!b) return;
    pendingImages.splice(+b.dataset.rmimg, 1);
    renderImgPreviews();
  });

  /* 檔期篩選 */
  $('phaseChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-phase]');
    if (!chip) return;
    selectedPhase = chip.dataset.phase;
    renderPhases(); renderExpiryBanner(); renderNotes();
  });
  /* 到期橫幅 → 跳到該筆記 */
  $('expiryBanner').addEventListener('click', (e) => {
    const b = e.target.closest('.eb-go');
    if (b) jumpToNote(b.dataset.id);
  });

  $('searchInput').addEventListener('input', (e) => { searchKw = e.target.value; renderNotes(); });
  $('notesGrid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'del') {
      // 兩段式刪除：第一下變成「確定？」，3 秒內再按一下才真的刪
      if (act.classList.contains('confirming')) {
        notes = notes.filter((n) => n.id !== id);
        save(LS_NOTES, notes); renderAll();
        toast('已刪除');
      } else {
        act.classList.add('confirming');
        act.textContent = '確定？';
        setTimeout(() => {
          const b = document.querySelector(`.card[data-id="${id}"] .card-del.confirming`);
          if (b) { b.classList.remove('confirming'); b.textContent = '×'; }
        }, 3000);
      }
    } else if (act.dataset.act === 'retry') {
      retryIngest(id);
    } else if (act.dataset.act === 'supplement') {
      openSupplement(id);
    } else if (act.dataset.act === 'ics') {
      const n = notes.find((x) => x.id === id);
      if (n) downloadICS(n);
    }
  });

  $('assistantBtn').onclick = () => setChatOpen(!isChatOpen());
  $('assistantClose').onclick = () => setChatOpen(false);
  $('chatSend').onclick = askChat;
  $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') askChat(); });
  $('chatBody').addEventListener('click', (e) => {
    const c = e.target.closest('.cite-card');
    if (c) jumpToNote(c.dataset.id);
  });

  $('exportBtn').onclick = exportData;
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').addEventListener('change', (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); closeSupplement(); setChatOpen(false); }
  });
}

bind();
renderAll();
renderChat();
})();
