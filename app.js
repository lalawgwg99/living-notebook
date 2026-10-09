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

/* ---------------- 資料 ---------------- */
let notes = load(LS_NOTES, []);
let brains = load(LS_BRAINS, []);
// 舊版筆記沒有 brainId → 視為待分類
notes.forEach((n) => { if (!('brainId' in n)) n.brainId = null; });
let persona = load(LS_PERSONA, null) || {
  name: null, mood: '還沒醒來', color: '#c2703d', emoji: '📓',
  greeting: '嗨，我還沒有名字。丟一些你看到的影片或文章給我，我會自動分類、長出大腦。',
  traits: [], bio: '', absorbedCount: 0, updatedAt: null,
};
let chatHistory = load(LS_CHAT, []);
let selectedBrain = 'all';   // 'all' | 'inbox' | brainId
let activeFilter = 'all';
let searchKw = '';
let pipelining = false;

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
  document.documentElement.style.setProperty('--mood', persona.color || '#c2703d');
  $('personaEmoji').textContent = persona.emoji || '📓';
  $('personaMood').textContent = persona.mood || '';
  $('personaName').textContent = persona.name || '一本空白的筆記本';
  $('personaGreeting').textContent = persona.greeting || '';
  $('chatPersonaName').textContent = persona.name || '筆記本';
  $('statNotes').textContent = notes.length;
  $('statPoints').textContent = notes.reduce((a, n) => a + (n.keyPoints ? n.keyPoints.length : 0), 0);
  if (growing) {
    const orb = $('personaOrb');
    orb.classList.remove('growing'); void orb.offsetWidth; orb.classList.add('growing');
  }
}

async function absorbHost(silent) {
  const pool = notes.filter((n) => !n.counted);
  const target = (pool.length ? pool : notes).slice(0, 12);
  if (target.length === 0) { if (!silent) toast('還沒有筆記可以吸收'); return; }
  if (!silent) { $('absorbBtn').disabled = true; $('absorbBtn').textContent = '🌀 長大中…'; }
  try {
    const d = await aiTask('notebook-absorb', {
      persona: { name: persona.name, mood: persona.mood, emoji: persona.emoji, traits: persona.traits, bio: persona.bio },
      notes: target.map((n) => ({ title: n.title, summary: n.summary, tags: n.tags })),
    });
    const p = extractJSON(d.text);
    if (!p || !p.mood) throw new Error('bad-json');
    if (p.name && p.name.trim()) persona.name = p.name.trim().slice(0, 12);
    persona.mood = String(p.mood).slice(0, 16);
    const c = validColor(p.color); if (c) persona.color = c;
    if (p.emoji && p.emoji.trim()) persona.emoji = [...p.emoji.trim()][0];
    if (p.greeting) persona.greeting = String(p.greeting).slice(0, 120);
    if (Array.isArray(p.traits)) persona.traits = p.traits.filter((t) => typeof t === 'string').map((t) => t.slice(0, 12)).slice(0, 6);
    if (p.bio) persona.bio = String(p.bio).slice(0, 200);
    target.forEach((n) => { n.counted = true; });
    save(LS_PERSONA, persona); save(LS_NOTES, notes);
    renderAll(true);
    if (p.comment && !silent) { pushChatMsg('bot', String(p.comment).slice(0, 120)); openChat(); }
    else if (!silent) toast('主人格長大了 ✨');
  } catch (e) {
    if (!silent) toast('這次沒能好好思考，下次再試');
  } finally {
    if (!silent) { $('absorbBtn').disabled = false; $('absorbBtn').textContent = '🌀 主人格吸收長大'; }
  }
}

/* ---------------- 大腦列表 ---------------- */
function renderBrains() {
  const list = $('brainList');
  const inboxCount = notes.filter((n) => !n.brainId).length;
  let html = `<button class="brain-row all ${selectedBrain === 'all' ? 'active' : ''}" data-brain="all">
      <span class="brain-dot">🌱</span><span class="brain-row-name">全部</span>
      <span class="brain-row-meta">${notes.length} 則</span></button>`;
  if (inboxCount > 0) {
    html += `<button class="brain-row inbox ${selectedBrain === 'inbox' ? 'active' : ''}" data-brain="inbox">
      <span class="brain-dot">📥</span><span class="brain-row-name">待分類</span>
      <span class="brain-row-meta">${inboxCount} 則</span></button>`;
  }
  activeBrains().forEach((b) => {
    const n = brainNotes(b.id).length;
    html += `<button class="brain-row ${selectedBrain === b.id ? 'active' : ''}" data-brain="${b.id}"
        style="--brain-color:${esc(b.color || '#c2703d')}" id="brow-${b.id}">
      <span class="brain-dot">${esc(b.emoji || '🧠')}</span>
      <span class="brain-row-name">${esc(b.name)}</span>
      <span class="brain-row-meta">Lv.${b.level || 1} · ${n}則</span></button>`;
  });
  list.innerHTML = html;
  $('brainsCount').textContent = activeBrains().length ? `${activeBrains().length} 個大腦` : '還沒長出來';
}

/* ---------------- 腦內詳情 ---------------- */
function renderBrainDetail() {
  const el = $('brainDetail');
  if (selectedBrain === 'all' || selectedBrain === 'inbox') {
    if (selectedBrain === 'inbox') {
      el.classList.remove('hidden');
      el.innerHTML = `<div class="brain-detail-head"><span class="brain-detail-emoji">📥</span>
        <div><h2 class="brain-detail-name">待分類</h2>
        <p class="brain-detail-desc">這些還沒被大腦認領。按一下，讓 AI 幫它們找到家。</p></div></div>
        <button class="btn-primary" id="classifyAllBtn">✨ 一鍵自動分類</button>`;
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
    ? `<div class="brain-gaps"><span class="gaps-label">🧠 想學的：</span>${b.gaps.map((g) => `<span class="gap-chip">${esc(g)}</span>`).join('')}</div>` : '';
  const born = b.spawnReason ? `<div class="brain-born">🌱 誕生原因：${esc(b.spawnReason)}</div>`
    : b.parentId ? `<div class="brain-born">🔀 從「${esc((brainById(b.parentId) || {}).name || '母腦')}」分裂而來</div>` : '';
  el.innerHTML = `
    <div class="brain-detail-head">
      <span class="brain-detail-emoji">${esc(b.emoji || '🧠')}</span>
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
  toast('分類完成 ✨');
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

async function addLinkNote(url) {
  if (pipelining) return;
  pipelining = true;
  $('modalLoading').classList.remove('hidden');
  $('modalPipeline').innerHTML = '';
  $('modalSave').disabled = true;
  try {
    pipelineStep('把內容抓回來');
    $('modalLoadingText').textContent = '正在把內容抓回來…';
    let data = null;
    if (INGEST_URL) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      try {
        const r = await fetch(INGEST_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }), signal: ctrl.signal,
        });
        if (r.ok) data = await r.json();
      } catch {} finally { clearTimeout(timer); }
    }
    const note = {
      id: uid(), type: 'link', url,
      title: (data && data.title) || url,
      summary: (data && data.summary) || '',
      keyPoints: (data && data.key_points) || [],
      tags: (data && data.tags) || [],
      site: (data && data.source && data.source.site) || '',
      brainId: null, createdAt: Date.now(),
    };
    if (!data) note.summary = '（這則還沒抓到內容，之後可以重抓）';
    notes.unshift(note); save(LS_NOTES, notes);
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
    closeModal(); renderAll();
  } finally {
    pipelining = false;
    $('modalLoading').classList.add('hidden');
    $('modalSave').disabled = false;
    $('linkUrl').value = '';
  }
}

async function addTextNote(title, body) {
  if (pipelining) return;
  pipelining = true;
  try {
    const note = {
      id: uid(), type: 'text',
      title: title || body.slice(0, 24) || '未命名',
      body, summary: '', keyPoints: [],
      tags: autoTags(body + title), brainId: null, createdAt: Date.now(),
    };
    notes.unshift(note); save(LS_NOTES, notes);
    await routeNote(note);
    if (note.brainId) await evolveBrain(note.brainId, note);
    maybeAbsorbHost();
    closeModal(); renderAll();
    $('textTitle').value = ''; $('textBody').value = '';
  } finally { pipelining = false; }
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
        toast(`🧠 新大腦誕生：「${nb.name}」`);
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
    emoji: (b.emoji && [...String(b.emoji).trim()][0]) || '🧠',
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
    if (hit) setTimeout(() => toast(`😋「${b.name}」吃到了想學的「${hit}」！`), 600);
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
      setTimeout(() => toast(`🔀「${b.name}」分裂成 ${kids.map((k) => `「${k.name}」`).join('、')}！`), 900);
    }

    // 繁衍：意想不到的新大腦
    if (evo.spawn && evo.spawn.name && !b.retired) {
      const nb = makeBrain(evo.spawn);
      nb.spawnReason = String(evo.spawn.reason || '').slice(0, 60);
      brains.unshift(nb);
      setTimeout(() => toast(`🌱 意外繁衍出新大腦：「${nb.name}」${nb.spawnReason ? '（' + nb.spawnReason + '）' : ''}`), 1400);
    }

    // 思考筆記：大腦自己長出的連結
    if (evo.synthesis && evo.synthesis.body && !b.retired) {
      const targetBrain = b.id;
      notes.unshift({
        id: uid(), type: 'synth', ai: true,
        title: '🤖 ' + String(evo.synthesis.title || '腦的思考').slice(0, 30),
        body: String(evo.synthesis.body).slice(0, 400),
        summary: '', keyPoints: [], tags: brainTags(b).slice(0, 3),
        brainId: targetBrain, createdAt: Date.now(),
      });
      setTimeout(() => toast(`💡「${b.name}」長出了一篇思考筆記`), 1800);
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
    setTimeout(() => toast('✨ 主人格也默默長大了'), 2200);
  }
}

/* ---------------- 筆記渲染 ---------------- */
function filteredNotes() {
  const kw = searchKw.trim().toLowerCase();
  return notes
    .filter((n) => selectedBrain === 'all' ? true : selectedBrain === 'inbox' ? !n.brainId : n.brainId === selectedBrain)
    .filter((n) => activeFilter === 'all' || n.type === activeFilter)
    .filter((n) => {
      if (!kw) return true;
      const hay = [n.title, n.summary, n.url, (n.keyPoints || []).join(' '), (n.tags || []).join(' '), n.body]
        .join(' ').toLowerCase();
      return hay.includes(kw);
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

function noteCard(n) {
  const pts = (n.keyPoints || []).slice(0, 5);
  const ptsHtml = pts.length
    ? `<ul class="note-points collapsed" id="pts-${n.id}">${pts.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
       ${pts.length > 2 ? `<button class="points-toggle" data-toggle="${n.id}">展開全部重點 ▾</button>` : ''}`
    : '';
  const tagsHtml = (n.tags || []).length
    ? `<div class="note-tags">${n.tags.map((t) => `<span class="note-tag">${esc(t)}</span>`).join('')}</div>` : '';
  const titleHtml = n.url
    ? `<h3 class="note-title"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title || n.url)}</a></h3>`
    : `<h3 class="note-title">${esc(n.title || '未命名筆記')}</h3>`;
  const b = n.brainId && brainById(n.brainId);
  const brainHtml = b ? `<div class="note-brain">${esc(b.emoji)} ${esc(b.name)}</div>` : '';
  const bodyHtml = n.body ? `<p class="note-summary">${esc(n.body.slice(0, 200))}${n.body.length > 200 ? '…' : ''}</p>` : '';
  return `<article class="note-card ${n.type === 'synth' ? 'synth' : ''}" data-id="${n.id}">
    <div class="note-top">
      <span class="note-type">${n.type === 'link' ? '🔗 連結' : n.type === 'synth' ? '🤖 腦的思考' : '✏️ 文字'}</span>
      <span class="note-date">${fmtDate(n.createdAt)}</span>
    </div>
    ${titleHtml}
    ${n.summary ? `<p class="note-summary">${esc(n.summary)}</p>` : ''}
    ${bodyHtml}
    ${ptsHtml}${tagsHtml}${brainHtml}
    <div class="note-actions">
      ${n.url ? `<button data-act="retry">↻ 重抓</button>` : ''}
      <button data-act="del" class="danger">刪除</button>
    </div>
  </article>`;
}

function renderNotes() {
  const list = filteredNotes();
  $('notesGrid').innerHTML = list.map(noteCard).join('');
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
function pushChatMsg(role, text) {
  chatHistory.push({ role, content: text });
  if (chatHistory.length > 40) chatHistory = chatHistory.slice(-40);
  save(LS_CHAT, chatHistory);
  renderChat();
}
function renderChat() {
  const body = $('chatBody');
  body.innerHTML = chatHistory.map((m) =>
    `<div class="msg ${m.role === 'user' ? 'user' : 'bot'}">${esc(m.content)}</div>`).join('');
  body.scrollTop = body.scrollHeight;
}
function openChat() {
  $('chatPanel').classList.remove('hidden');
  if (chatHistory.length === 0) {
    pushChatMsg('bot', (persona.name ? `我是${persona.name}。` : '嗨！') + '你丟進來的東西，我的大腦們都記得。想找什麼重點，直接問我。');
  } else renderChat();
  setTimeout(() => $('chatInput').focus(), 50);
}
async function askChat() {
  const input = $('chatInput');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  pushChatMsg('user', q);
  const typing = document.createElement('div');
  typing.className = 'msg bot typing'; typing.textContent = '大腦們翻筆記中…';
  $('chatBody').appendChild(typing);
  $('chatBody').scrollTop = $('chatBody').scrollHeight;
  try {
    const ctx = retrieve(q, 5).map((n) => ({
      title: n.title, summary: n.summary || n.body || '', key_points: n.keyPoints, tags: n.tags,
    }));
    const d = await aiTask('notebook-chat', {
      persona: { name: persona.name, mood: persona.mood },
      context_notes: ctx,
      messages: chatHistory.slice(-8).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
    }, 45000);
    typing.remove();
    pushChatMsg('bot', d.text || '嗯…大腦們翻了一下，暫時沒想法，換個問法試試？');
  } catch (e) {
    typing.remove();
    pushChatMsg('bot', '大腦們現在有點累（連不上），稍後再問我一次吧。');
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
  setTimeout(() => (modalTab === 'link' ? $('linkUrl') : $('textTitle')).focus(), 50);
}
function closeModal() { if (!pipelining) $('modalBackdrop').classList.add('hidden'); }
function setModalTab(t) {
  modalTab = t;
  document.querySelectorAll('.modal-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $('paneLink').classList.toggle('hidden', t !== 'link');
  $('paneText').classList.toggle('hidden', t !== 'text');
}
async function saveNote() {
  if (modalTab === 'link') {
    const url = $('linkUrl').value.trim();
    if (!url) { $('linkUrl').focus(); return; }
    if (!/^https?:\/\//i.test(url)) { toast('請貼上完整的網址（http 開頭）'); return; }
    await addLinkNote(url);
  } else {
    const title = $('textTitle').value.trim();
    const body = $('textBody').value.trim();
    if (!body && !title) { $('textBody').focus(); return; }
    await addTextNote(title, body);
  }
}

/* ---------------- 事件 ---------------- */
function renderAll(growing) { renderPersona(growing); renderBrains(); renderBrainDetail(); renderNotes(); }
function bind() {
  $('addBtn').onclick = openModal;
  $('emptyAddBtn').onclick = openModal;
  $('modalCancel').onclick = closeModal;
  $('modalBackdrop').addEventListener('click', (e) => { if (e.target === $('modalBackdrop')) closeModal(); });
  $('modalSave').onclick = saveNote;
  document.querySelectorAll('.modal-tab').forEach((b) => { b.onclick = () => setModalTab(b.dataset.tab); });
  $('linkUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveNote(); });
  $('absorbBtn').onclick = () => absorbHost(false);

  $('searchInput').addEventListener('input', (e) => { searchKw = e.target.value; renderNotes(); });
  $('filterRow').addEventListener('click', (e) => {
    const f = e.target.closest('[data-filter]');
    if (!f) return;
    activeFilter = f.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('active', b === f));
    renderNotes();
  });
  $('brainList').addEventListener('click', (e) => {
    const row = e.target.closest('[data-brain]');
    if (!row) return;
    selectedBrain = row.dataset.brain;
    renderBrains(); renderBrainDetail(); renderNotes();
  });
  $('notesGrid').addEventListener('click', (e) => {
    const tg = e.target.closest('[data-toggle]');
    if (tg) {
      const ul = $('pts-' + tg.dataset.toggle);
      const collapsed = ul.classList.toggle('collapsed');
      tg.textContent = collapsed ? '展開全部重點 ▾' : '收合 ▴';
      return;
    }
    const card = e.target.closest('.note-card');
    if (!card) return;
    const id = card.dataset.id;
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'del') {
      if (confirm('確定刪除這則筆記？')) {
        notes = notes.filter((n) => n.id !== id);
        save(LS_NOTES, notes); renderAll();
      }
    } else if (act.dataset.act === 'retry') {
      const n = notes.find((x) => x.id === id);
      if (n && n.url) { setModalTab('link'); openModal(); $('linkUrl').value = n.url; }
    }
  });

  $('chatFab').onclick = () => {
    if ($('chatPanel').classList.contains('hidden')) openChat();
    else $('chatPanel').classList.add('hidden');
  };
  $('chatClose').onclick = () => $('chatPanel').classList.add('hidden');
  $('chatSend').onclick = askChat;
  $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') askChat(); });

  $('exportBtn').onclick = exportData;
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').addEventListener('change', (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); $('chatPanel').classList.add('hidden'); }
  });
}

bind();
renderAll();
renderChat();
})();
