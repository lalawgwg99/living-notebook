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

const TRAD_MAP = '复→複、发→發、国→國、学→學、读→讀、说→說、认→認、识→識、时→時、这→這、个→個、无→無、与→與、为→為、来→來、对→對、开→開、关→關、门→門、现→現、让→讓、远→遠、运→運、经→經、济→濟、话→話、设→設、证→證、评→評、质→質、义→義、习→習、务→務、广→廣、严→嚴、宝→寶、专→專、传→傳、归→歸、并→並、应→應、还→還、过→過、进→進、连→連、适→適、观→觀、规→規、选→選、达→達、财→財、资→資、误→誤、栅→柵、轻→輕、权→權、势→勢、艺→藝、节→節、华→華、丽→麗、万→萬、东→東、丝→絲、丢→丟、两→兩、丧→喪、临→臨、举→舉、乐→樂、乔→喬、乡→鄉、书→書、买→買、乱→亂、争→爭、亏→虧、云→雲、互→互、亚→亞、亲→親、宁→寧、审→審、写→寫、军→軍、农→農、决→決、冻→凍、净→淨、凭→憑、凯→凱、击→擊、则→則、刚→剛、创→創、删→刪、划→劃、剂→劑、剑→劍、阀→閥、阁→閣、献→獻、变→變、议→議、讯→訊、记→記、讲→講、许→許、论→論、访→訪、词→詞、语→語、法→法、调→調、课→課、请→請、诸→諸、贸→貿、购→購、轨→軌、轮→輪、软→軟、轴→軸、辈→輩、辉→輝、输→輸、辞→辭、边→邊、迈→邁、违→違、迟→遲、迹→跡、遗→遺、遥→遙、邓→鄧、邮→郵、邻→鄰、释→釋、错→錯、键→鍵、镇→鎮、镜→鏡、长→長、问→問、闪→閃、闭→閉、闯→闖、闲→閒、闷→悶、闹→鬧、闻→聞、阅→閱、队→隊、阳→陽、阴→陰、阵→陣、阶→階、际→際、陆→陸、随→隨、隐→隱、雾→霧、顶→頂、项→項、顺→順、须→須、颁→頒、顾→顧、顿→頓、预→預、领→領、颇→頗、颈→頸、风→風、飞→飛、饭→飯、肃→肅、虽→雖、验→驗、险→險';

const SYSTEM_SUMMARY =
'你是繁體中文摘要助手。使用者給你一篇網頁或影片的文字內容，你只回傳 JSON，格式固定：' +
'{"title":"標題（20字內）","summary":"一句話摘要（40字內）",' +
'"key_points":["重點一（25字內）","重點二","重點三"],"tags":["標籤一","標籤二","標籤三"]}' +
'key_points 給 3 到 5 個最重要的資訊，每點 25 字內；tags 給 3 到 5 個短標籤。' +
'全程只用繁體中文（台灣用法）回傳，絕對不可出現簡體字。' +
'注意：原文可能是簡體中文，你必須先理解內容，再用自己的繁體中文重寫，不可照抄原文簡體字。' +
'對照：复→複、发→發、国→國、学→學、读→讀、说→說、认→認、识→識、时→時、这→這、个→個、无→無、与→與、为→為、来→來、对→對、开→開、关→關、门→門、现→現、让→讓、远→遠、运→運、经→經、济→濟、话→話、设→設、证→證、评→評、质→質、义→義、习→習、务→務、广→廣、严→嚴、宝→寶、专→專、传→傳、归→歸、并→並、应→應、还→還、过→過、进→進、远→遠、连→連、适→適、观→觀、规→規、选→選、达→達、运→運。' +
'只回傳 JSON，不要加任何前言、解釋或 markdown 標記。';

// 常見簡體特徵字：命中任一即視為含簡體，需轉繁
const SIMP_RE = /[发国学读说认识时这无与为来对开关联现让远运经话设证评质义习务广严宝专传归并应还过进连适观规选达财资误栅轻权势艺节华万丽东丝丢两丧临举乐乔乡书买乱争亏云互亚亲宁审写军农决冻净凭凯击则刚创删划剂剑阀阁献变议讯记讲许论访词语法调课请诸贸购轨轮软轴辈辉输辞边迈违迟迹遗遥邓邮邻释错键镇镜长门问闪闭闯闲闷闹闻阅队阳阴阵阶际陆随隐雾顶项顺须颁顾顿预领颇颈风飞饭肃虽验险导异弃张弥弯弹强当彻态怀悦悬悯惊惠惭惯愤愿懒虑戏战户扎扑执扩扰扫扬换损捡搅摆携摄摇搞搔搜复]/;
// 多音多義字：不做機械轉換，留給 AI 依上下文判斷
const AMBIGUOUS = new Set(['发','复','干','伙','借','尽','丑','余','征','卷','划','回','里','后','只','表','斗','松','舍','范','丰','朴','咸','佣','御','旋','谷','腊','纤','秋','虫','钟','银','链','镇','针','诊','钓','铁','铃','铅','铝','铜','铠','鉴']);
const DET_MAP = {};
for (const pair of TRAD_MAP.split('、')) {
const pv = pair.split('→');
if (pv.length === 2 && pv[0] && pv[1] && pv[0] !== pv[1] && !AMBIGUOUS.has(pv[0])) DET_MAP[pv[0]] = pv[1];
}
const DET_RE = new RegExp('[' + Object.keys(DET_MAP).join('') + ']', 'g');
function detTrad(s) { return String(s || '').replace(DET_RE, (c) => DET_MAP[c] || c); }

async function toTraditional(env, obj) {
const texts = [obj.title, obj.summary, ...(obj.key_points || []), ...(obj.tags || [])].join('');
if (!SIMP_RE.test(texts)) return obj;
try {
const prompt = '把下面 JSON 裡所有文字轉成繁體中文（台灣用法），key 和結構完全不變，只回傳 JSON。' +
'簡繁對照：' + TRAD_MAP + '\n' + JSON.stringify(obj);
const out = await env.AI.run(MODEL, {
messages: [{ role: 'user', content: prompt }], max_tokens: 1200,
});
const raw = (out && out.response) || '';
const m = raw.match(/\{[\s\S]*\}/);
if (!m) return obj;
const fixed = JSON.parse(m[0]);
if (fixed && fixed.summary) {
fixed.title = detTrad(fixed.title); fixed.summary = detTrad(fixed.summary);
fixed.key_points = (fixed.key_points || []).map(detTrad);
fixed.tags = (fixed.tags || []).map(detTrad);
return fixed;
}
} catch {}
// AI 沒轉乾淨也沒關係：機械掃一遍無歧義字
obj.title = detTrad(obj.title); obj.summary = detTrad(obj.summary);
obj.key_points = (obj.key_points || []).map(detTrad);
obj.tags = (obj.tags || []).map(detTrad);
return obj;
}

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
if (data) data = await toTraditional(env, data);
return data;
}

// 單一字串轉繁（給標題 fallback 用）：先機械轉，無歧義字一定中
async function tradText(env, str) {
if (!str) return str;
const mech = detTrad(str);
if (!SIMP_RE.test(mech)) return mech;
const r = await toTraditional(env, { title: mech, summary: '佔位', key_points: [], tags: [] });
return (r && r.title) || mech;
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
title: (await tradText(env, yt.title)).slice(0, 80),
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
const out = {
title: String(s.title || title).slice(0, 60),
summary: String(s.summary || '').slice(0, 120),
key_points: Array.isArray(s.key_points)? s.key_points.filter((x) => typeof x === 'string').map((x) => x.slice(0, 80)).slice(0, 5): [],
tags: Array.isArray(s.tags)? s.tags.filter((x) => typeof x === 'string').map((x) => x.slice(0, 12)).slice(0, 5): [],
source: { url: target.toString(), site: target.hostname.replace(/^www\./, '')},
};
// 最後再掃一次：任何殘留簡體一次轉掉
const fixed = await toTraditional(env, out);
return Response.json({
title: fixed.title, summary: fixed.summary,
key_points: fixed.key_points, tags: fixed.tags, source: out.source,
}, { headers: cors});
} catch (e) {
return Response.json({ error: 'fetch failed'}, { status: 502, headers: cors});
}
},
};
