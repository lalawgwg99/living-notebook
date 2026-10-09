// notebook-ingest：把使用者貼的連結抓回來，抽出重點
// POST /ingest { url} -> { title, summary, key_points[], tags[], source}
// 或 { partial:true, title, author, source}（YouTube 被擋時只有標題）
// 部署：cf_worker_deploy.py notebook-ingest worker-ingest.js worker-ingest-metadata.json

const MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

const ALLOWED_ORIGINS = [
'https://living-notebook.pages.dev',
'http://localhost:8000',
'http://127.0.0.1:8000',
];

const SYSTEM_SUMMARY =
'你是繁體中文摘要助手。使用者給你一篇網頁或影片的文字內容，你只回傳 JSON，格式固定：' +
'{"title":"標題（20字內）","summary":"一句話摘要（40字內）",' +
'"key_points":["重點一（25字內）","重點二","重點三"],"tags":["標籤一","標籤二","標籤三"]}' +
'key_points 給 3 到 5 個最重要的資訊，每點 25 字內；tags 給 3 到 5 個短標籤。' +
'全程只用繁體中文回傳，絕對不可出現簡體字。' +
'只回傳 JSON，不要加任何前言、解釋或 markdown 標記。';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 簡易 SSRF 防護：擋內網與特殊主機
function hostBlocked(hostname) {
const h = hostname.toLowerCase().trim();
if (!h) return true;
if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0)/.test(h)) return true;
if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
if (h === '::1' || h === '[::1]') return true;
if (h.includes('metadata.google')) return true;
return false;
}

function stripTags(html) {
return html
.replace(/<script[\s\S]*?<\/script>/gi, ' ')
.replace(/<style[\s\S]*?<\/style>/gi, ' ')
.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
.replace(/<!--[\s\S]*?-->/g, ' ');
}
function textOf(html) {
return stripTags(html)
.replace(/<\/p>|<br\s*\/?>|<\/div>|<\/li>|<\/h[1-6]>/gi, '\n')
.replace(/<[^>]+>/g, ' ')
.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
.replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
.replace(/[ \t]+/g, ' ')
.split('\n').map((s) => s.trim()).filter((s) => s.length > 12)
.join('\n');
}
function metaContent(html, name) {
const m = html.match(new RegExp('<meta[^>]+(?:name|property)=["\']' + name + '["\'][^>]*>', 'i'));
if (!m) return '';
const c = m[0].match(/content=["']([^"']+)["']/i);
return c? c[1].trim(): '';
}

// 通用文章正文抽取：找 <article>/<main>，沒有就找 <p> 最多的區塊
function extractArticle(html) {
const clean = stripTags(html);
const candidates = [];
const re = /<(article|main)([^>]*)>([\s\S]*?)<\/\1>/gi;
let m;
while ((m = re.exec(clean)) && candidates.length < 6) candidates.push(m[3]);
const re2 = /<(div|section)([^>]*class=["'][^"']*(content|article|post|entry|main|text|body)[^"']*["'][^>]*)>([\s\S]*?)<\/\1>/gi;
while ((m = re2.exec(clean)) && candidates.length < 12) candidates.push(m[3]);
let best = '', bestScore = 0;
for (const c of candidates) {
const t = textOf(c);
const score = t.length;
if (score > bestScore && score > 200) { bestScore = score; best = t;}
}
if (best) return best;
return textOf(clean);
}

function isYouTube(url) {
const h = url.hostname.replace(/^www\./, '').toLowerCase();
return h === 'youtube.com' || h === 'youtu.be' || h.endsWith('.youtube.com');
}

// YouTube：youtu.be 正規化；watch 頁被擋（sorry/bot）時用 oEmbed 保底拿標題＋作者
// 回傳 { title, author, desc, transcript, blocked}
async function fetchYouTube(url) {
let vid = '';
const host = url.hostname.replace(/^www\./, '').toLowerCase();
if (host === 'youtu.be') vid = url.pathname.slice(1).split(/[?/]/)[0];
else vid = url.searchParams.get('v') || '';
const watchUrl = vid? 'https://www.youtube.com/watch?v=' + vid: url.toString();

let html = '', blocked = false;
try {
const resp = await fetch(watchUrl, {
headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9'},
redirect: 'follow',
});
const finalUrl = resp.url || '';
html = await resp.text();
if (/sorry\/index|consent\.youtube|accounts\.google/.test(finalUrl)) blocked = true;
else if (/captcha/i.test(html.slice(0, 5000))) blocked = true;
} catch (e) { blocked = true;}

let title = '', desc = '', transcript = '';
if (!blocked && html) {
title = (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || '';
desc = metaContent(html, 'description') || metaContent(html, 'og:description');
try {
const capMatch = html.match(/"captionTracks":\s*(\[[\s\S]*?\])/);
if (capMatch) {
const tracks = JSON.parse(capMatch[1]);
const zh = (t) => /zh(-|_)?(Hant|TW)/i.test(t.languageCode || '') || /zh/i.test((t.name && t.name.simpleText) || '');
const pick = tracks.find(zh) || tracks.find((t) => /^en/i.test(t.languageCode || '')) || tracks[0];
if (pick && pick.baseUrl) {
const xml = await (await fetch(pick.baseUrl, { headers: { 'User-Agent': UA}})).text();
const parts = [];
const re3 = /<text[^>]*>([\s\S]*?)<\/text>/g;
let tm;
while ((tm = re3.exec(xml))) {
parts.push(tm[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim());
}
transcript = parts.join(' ').replace(/\s+/g, ' ');
}
}
} catch (e) {}
}
let author = '';
try {
const oe = await (await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent(watchUrl) + '&format=json',
{ headers: { 'User-Agent': UA}})).json();
if (oe) {
if (!title && oe.title) title = oe.title;
if (oe.author_name) author = oe.author_name;
}
} catch (e) {}
const cleanTitle = String(title || '').replace(/ - YouTube$/, '').trim();
return { title: cleanTitle, author: author, desc: desc, transcript: transcript, blocked: blocked &&!transcript &&!desc};
}

async function summarize(env, title, content) {
const input = '標題：' + title + '\n\n內容：\n' + content.slice(0, 6000);
const resp = await env.AI.run(MODEL, {
messages: [
{ role: 'system', content: SYSTEM_SUMMARY},
{ role: 'user', content: input},
],
max_tokens: 800,
temperature: 0.2,
});
const raw = typeof resp?.response === 'string'? resp.response.trim(): '';
let data = null;
try { data = JSON.parse(raw);} catch (e) {
const m = raw.match(/\{[\s\S]*\}/);
if (m) { try { data = JSON.parse(m[0]);} catch (e2) {}}
}
return data;
}

// IP 限流：每分鐘 10 次（記憶體版）
const hits = new Map();
function rateLimited(ip) {
const now = Date.now();
const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
arr.push(now); hits.set(ip, arr);
if (hits.size > 5000) hits.clear();
return arr.length > 10;
}

export default {
async fetch(request, env, ctx) {
const origin = request.headers.get('Origin') || '';
const cors = {
'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin)? origin: ALLOWED_ORIGINS[0],
'Access-Control-Allow-Methods': 'POST, OPTIONS',
'Access-Control-Allow-Headers': 'Content-Type',
};
if (request.method === 'OPTIONS') return new Response(null, { headers: cors});
const url = new URL(request.url);
if (url.pathname!== '/ingest' || request.method!== 'POST') {
return new Response('not found', { status: 404, headers: cors});
}
const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
if (rateLimited(ip)) return Response.json({ error: 'too many requests'}, { status: 429, headers: cors});

let body;
try { body = await request.json();} catch (e) {
return Response.json({ error: 'bad request'}, { status: 400, headers: cors});
}
let target;
try {
target = new URL(String(body.url || '').trim());
if (!/^https?:$/.test(target.protocol)) throw new Error('proto');
if (hostBlocked(target.hostname)) throw new Error('blocked');
} catch (e) {
return Response.json({ error: 'bad url'}, { status: 400, headers: cors});
}

try {
let title = '', content = '', author = '';
if (isYouTube(target)) {
const yt = await fetchYouTube(target);
title = yt.title || target.toString();
author = yt.author || '';
// 被擋到只剩標題：回 partial，讓前端走手動補充
if (yt.blocked && yt.title) {
return Response.json({
partial: true,
title: yt.title.slice(0, 80),
author: author.slice(0, 40),
source: { url: target.toString(), site: 'youtube.com'},
}, { headers: cors});
}
content = yt.transcript
? '\n' + yt.transcript.slice(0, 8000)
: '\n' + (yt.desc || '（無描述）');
if (author) content = '作者：' + author + '\n' + content;
} else {
const resp = await fetch(target.toString(), {
headers: {
'User-Agent': UA,
'Accept-Language': 'zh-TW,zh;q=0.9',
'Accept': 'text/html',
},
redirect: 'follow',
});
const ct = resp.headers.get('content-type') || '';
if (!/text\/html/i.test(ct)) {
return Response.json({ error: 'not a page', detail: ct.slice(0, 60)}, { status: 422, headers: cors});
}
const html = await resp.text();
title = metaContent(html, 'og:title') || ((html.match(/<title>([^<]+)<\/title>/i) || [])[1] || '').trim() || target.hostname;
const desc = metaContent(html, 'og:description') || metaContent(html, 'description');
const article = extractArticle(html);
content = article? article.slice(0, 8000): desc;
}
if (!content || content.trim().length < 40) {
return Response.json({ error: 'empty content'}, { status: 422, headers: cors});
}
const s = await summarize(env, title, content);
if (!s) return Response.json({ error: 'ai error'}, { status: 502, headers: cors});
return Response.json({
title: String(s.title || title).slice(0, 60),
summary: String(s.summary || '').slice(0, 120),
key_points: Array.isArray(s.key_points)? s.key_points.filter((x) => typeof x === 'string').map((x) => x.slice(0, 80)).slice(0, 5): [],
tags: Array.isArray(s.tags)? s.tags.filter((x) => typeof x === 'string').map((x) => x.slice(0, 12)).slice(0, 5): [],
source: { url: target.toString(), site: target.hostname.replace(/^www\./, '')},
}, { headers: cors});
} catch (e) {
return Response.json({ error: 'fetch failed'}, { status: 502, headers: cors});
}
},
};
