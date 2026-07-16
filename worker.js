// odottar API + イベント個別ページSSR + 静的アセット配信
// GET  /api/counts                          … いいね数マップ { eid: 数 }
// POST /api/hit?k=<eid>&op=inc|dec&id=<cid> … クライアント単位で冪等に加減算 (D1・アトミック)
// GET  /event/<eid>                         … イベント個別ページ (events.json からSSR)
// GET  /sitemap.xml                         … 全イベント個別ページを含む動的サイトマップ
//
// ■ イベント個別ページの設計 (2026-07-17)
//  index.html は SPA でイベント381件をJS描画しており、クローラーには「ほぼ1ページのサイト」に
//  見える (AdSense審査・SEOで不利)。個別ページを静的381ファイルで持つと GitHub Web UI の
//  100ファイル/コミット制限と衝突するため、Worker側で /event/<eid> をSSRする方式を採用。
//  データ源は events.json (pipeline/extract_data.py で index.html の DATA から生成)。
//  index.html の DATA を更新したら events.json も再生成して一緒にデプロイすること:
//    python3 pipeline/extract_data.py index.html > events.json
//
// ■ いいねカウンタを KV → D1 に移行した理由 (2026-07-11)
//  旧実装は KV の単一キー "counts" に全イベントのカウントをJSONで入れ、read → +1 → write していた。
//   - KVはアトミックでない → 同時いいねで lost update
//   - KVは結果整合で get が最大60秒古い値を返す → その古い値を書き戻し、直近1分のいいねが巻き戻る
//   - 全イベントが同じキーを共有するので、別イベント同士でも競合する
//   - 同一キーへの書き込みは 1回/秒 上限
//  → 「他人のいいねが出ない/増えない」の原因。
//  新実装は D1 で 1いいね = likes(eid,cid) の1行。INSERT OR IGNORE / DELETE はアトミックで、
//  PRIMARY KEY(eid,cid) が二重いいねをDBレベルで拒否する。
//  キーもイベント名 → 不変ID eid に変更 (改名でカウント消失/同名別日イベントの合算を防ぐ)。
//
// ■ セキュリティ方針
//  - id(クライアント識別子)必須。無しの無限inc穴を塞ぐ。
//  - k(eid)/id は長さ上限。
//  - Origin許可リストで他サイト/素のcurlを弾く(速度制限の代替ではない)。
//  - 全レスポンスに基本セキュリティヘッダを付与。
//  ※ 連打・水増し対策は Cloudflare Dashboard の Rate Limiting / Turnstile 併用が前提。

const ALLOWED_ORIGINS = ["https://odottar.com", "https://www.odottar.com"];
const EID_MAX = 32;
const ID_MAX = 64;
const ORIGIN = "https://odottar.com";
const ADSENSE_CLIENT = "ca-pub-2792766879613699";
const FORM_URL = "https://forms.gle/wDaecLp71c8gWCuV6";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "geolocation=(), microphone=(), camera=()"
};

function json(obj, status = 200) {
  return new Response(typeof obj === "string" ? obj : JSON.stringify(obj), {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

// GET /api/counts -> { eid: いいね数, ... }
async function getCounts(env) {
  if (!env.DB) return json({ error: "D1 not bound" }, 500);
  const { results } = await env.DB.prepare(
    `SELECT eid, SUM(n) AS c FROM (
       SELECT eid, COUNT(*) AS n FROM likes GROUP BY eid
       UNION ALL
       SELECT eid, n FROM seed
     ) GROUP BY eid HAVING c > 0`
  ).all();
  const out = {};
  for (const r of results) out[r.eid] = Number(r.c);
  return json(out);
}

// POST /api/hit?k=<eid>&op=inc|dec&id=<cid> -> { count }
async function postHit(env, request) {
  const url = new URL(request.url);

  const origin = request.headers.get("Origin");
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: "forbidden origin" }, 403);

  const eid = url.searchParams.get("k") || "";
  const cid = url.searchParams.get("id") || "";
  if (!eid || eid.length > EID_MAX) return json({ error: "bad k" }, 400);
  if (!cid || cid.length > ID_MAX) return json({ error: "bad id" }, 400);
  if (!env.DB) return json({ error: "D1 not bound" }, 500);

  const op = url.searchParams.get("op") === "dec" ? "dec" : "inc";

  // batch はトランザクションで直列実行される。
  // inc: 既にいいね済みなら OR IGNORE で無視 (冪等)。dec: 無ければ0行削除 (冪等)。
  const write = op === "inc"
    ? env.DB.prepare("INSERT OR IGNORE INTO likes (eid, cid) VALUES (?1, ?2)").bind(eid, cid)
    : env.DB.prepare("DELETE FROM likes WHERE eid = ?1 AND cid = ?2").bind(eid, cid);

  const read = env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM likes WHERE eid = ?1)
          + COALESCE((SELECT n FROM seed WHERE eid = ?1), 0) AS c`
  ).bind(eid);

  const [, res] = await env.DB.batch([write, read]);
  return json({ count: Number(res.results?.[0]?.c ?? 0) });
}

/* ========== イベント個別ページ SSR ========== */

// events.json のモジュールスコープキャッシュ。isolate生存中は再フェッチしない
// (events.json はデプロイ時にしか変わらず、デプロイで isolate も入れ替わるため安全)。
let EVENTS_CACHE = null;

async function loadEvents(env, request) {
  if (EVENTS_CACHE) return EVENTS_CACHE;
  const u = new URL(request.url);
  const res = await env.ASSETS.fetch(new Request(u.origin + "/events.json"));
  if (!res.ok) return null;
  EVENTS_CACHE = await res.json();
  return EVENTS_CACHE;
}

const H = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const WD = ["日", "月", "火", "水", "木", "金", "土"];

function jd(iso) { // "2026-06-05" -> Date (UTC固定で暦日として扱う)
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fmtDate(iso) {
  if (!iso) return "";
  const x = jd(iso);
  return `${x.getUTCFullYear()}年${x.getUTCMonth() + 1}月${x.getUTCDate()}日(${WD[x.getUTCDay()]})`;
}
function dateRange(e) {
  if (!e.start) return "日程調査中";
  return (e.end && e.end !== e.start) ? `${fmtDate(e.start)} 〜 ${fmtDate(e.end)}` : fmtDate(e.start);
}
// JSTの今日 "YYYY-MM-DD"
function todayJST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function statusLabel(e) {
  if (!e.start) return { t: "日程調査中", c: "tbd" };
  const today = todayJST();
  const end = e.end || e.start;
  if (end < today) return { t: "終了", c: "end" };
  if (e.start <= today && today <= end) return { t: "開催中", c: "live" };
  return { t: "開催予定", c: "soon" };
}

function eventJsonLd(e) {
  const ld = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: e.name,
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    location: {
      "@type": "Place",
      name: e.venue || e.name,
      address: { "@type": "PostalAddress", addressLocality: e.area || "", addressCountry: "JP" }
    },
    url: `${ORIGIN}/event/${e.eid}`,
    isAccessibleForFree: true
  };
  if (e.start) ld.startDate = e.time ? `${e.start}T${e.time}:00+09:00` : e.start;
  if (e.end || e.start) ld.endDate = e.end || e.start;
  if (e.feature) ld.description = e.feature;
  if (e.site) ld.sameAs = e.site;
  return JSON.stringify(ld);
}

function renderEventPage(e, events) {
  const st = statusLabel(e);
  const title = `${e.name}（${e.start ? fmtDate(e.start) : "2026年・日程調査中"}）｜${e.area || "東京"}の盆踊り｜おどったー`;
  const desc = `${e.area ? e.area + "の盆踊り「" : "「"}${e.name}」の開催情報。${e.start ? "日程: " + dateRange(e) + "。" : ""}${e.time ? "踊り開始 " + e.time + "〜。" : ""}会場: ${e.venue || "調査中"}。${e.station ? "最寄: " + e.station + "。" : ""}最新情報は公式サイトをご確認ください。`.slice(0, 160);

  // 同エリアの盆踊り (内部リンク)。開催日順に最大6件
  const related = events
    .filter(x => x.eid !== e.eid && x.area && x.area === e.area)
    .sort((a, b) => (a.start || "9999").localeCompare(b.start || "9999"))
    .slice(0, 6);
  // エリア外も含め開催日が近いもの4件
  const near = e.start ? events
    .filter(x => x.eid !== e.eid && x.start && !related.some(r => r.eid === x.eid))
    .sort((a, b) => Math.abs(jd(a.start) - jd(e.start)) - Math.abs(jd(b.start) - jd(e.start)))
    .slice(0, 4) : [];

  const relRow = x => `<li><a href="/event/${H(x.eid)}">${H(x.name)}</a><span class="rd">${x.start ? fmtDate(x.start) : "日程調査中"}${x.time ? "・" + H(x.time) + "〜" : ""}</span></li>`;

  const rows = [
    ["日程", dateRange(e)],
    ["踊り開始", e.time ? e.time + "〜" : "調査中"],
    ["会場", e.venue || "調査中"],
    ["最寄駅", e.station || "調査中"],
    ["エリア", e.area || "調査中"],
    ["踊れる曲", e.songs || "情報募集中"],
  ].map(([k, v]) => `<tr><th>${H(k)}</th><td>${H(v)}</td></tr>`).join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-TDLERYQHV1"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-TDLERYQHV1');</script>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}" crossorigin="anonymous"></script>
<meta name="theme-color" content="#1da1f2">
<title>${H(title)}</title>
<link rel="canonical" href="${ORIGIN}/event/${H(e.eid)}">
<meta name="description" content="${H(desc)}">
<meta property="og:site_name" content="おどったー">
<meta property="og:locale" content="ja_JP">
<meta property="og:type" content="article">
<meta property="og:title" content="${H(title)}">
<meta property="og:description" content="${H(desc)}">
<meta property="og:url" content="${ORIGIN}/event/${H(e.eid)}">
<meta property="og:image" content="${ORIGIN}/assets/ogp.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${ORIGIN}/assets/ogp.png">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/icons/favicon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/icons/apple-touch-icon-180.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@400;500;700;800&display=swap" rel="stylesheet">
<script type="application/ld+json">${eventJsonLd(e)}</script>
<style>
  :root{--bg:#eaf4fb;--card:#ffffff;--ink:#0f1419;--sub:#5b7083;--line:#e3eaef;--accent:#1da1f2;--accentD:#1a8cd8;--tint:#e8f5fd;--like:#f4326e;--max:480px}
  *{box-sizing:border-box;margin:0}
  html,body{background:var(--bg);color:var(--ink);line-height:1.8;
    font-family:"M PLUS Rounded 1c","Hiragino Maru Gothic ProN","Hiragino Sans","Yu Gothic UI","Yu Gothic",-apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased}
  .app{max-width:var(--max);margin:0 auto;background:var(--card);min-height:100vh}
  .head{background:radial-gradient(135% 105% at 50% -15%, #3cb0f7 0%, var(--accent) 48%, #1690dd 100%);
    color:#fff;padding:26px 20px 22px;text-align:center}
  .head .bk{display:inline-block;color:#fff;font-size:.75rem;text-decoration:underline;opacity:.9;margin-bottom:10px}
  .head h1{font-size:1.2rem;font-weight:800;line-height:1.4}
  .head .hd{font-size:.85rem;font-weight:700;margin-top:6px;opacity:.95}
  .bdg{display:inline-block;font-size:.7rem;font-weight:800;padding:2px 10px;border-radius:999px;background:#fff;color:var(--accentD);margin-bottom:8px}
  .bdg.end{background:rgba(255,255,255,.7);color:var(--sub)}
  .body{padding:22px 20px 40px}
  h2{font-size:.95rem;font-weight:800;margin:24px 0 8px;padding-left:10px;border-left:4px solid var(--accent)}
  p,li,td,th{font-size:.85rem}
  table{width:100%;border-collapse:collapse;margin:8px 0}
  th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line)}
  th{white-space:nowrap;background:var(--tint);font-weight:700;width:30%}
  a{color:var(--accentD)}
  .note{background:var(--tint);border-radius:10px;padding:12px 14px;font-size:.78rem;color:var(--sub);margin-top:14px}
  .btn{display:inline-block;background:var(--accent);color:#fff;font-weight:700;font-size:.85rem;
    padding:10px 20px;border-radius:999px;text-decoration:none;margin:8px 6px 0 0}
  .btn.ghost{background:#fff;color:var(--accentD);border:1.5px solid var(--accentD)}
  ul.rel{list-style:none;padding:0}
  ul.rel li{padding:8px 0;border-bottom:1px solid var(--line)}
  ul.rel a{font-weight:700}
  .rd{display:block;font-size:.75rem;color:var(--sub)}
  .adslot{margin:22px 0 4px;min-height:100px}
  .foot{padding:22px 16px 30px;text-align:center;background:var(--bg);border-top:1px solid var(--line)}
  .foot a{font-size:.8rem;font-weight:700;color:var(--accentD);margin:0 8px}
  .footcredit{margin-top:10px;font-size:.7rem;color:var(--sub)}
</style>
</head>
<body>
<div class="app">
  <div class="head">
    <a class="bk" href="/">← 盆踊り一覧（おどったー トップ）</a>
    <div><span class="bdg ${st.c}">${H(st.t)}</span></div>
    <h1>${H(e.name)}</h1>
    <div class="hd">${H(dateRange(e))}${e.time ? "・" + H(e.time) + "〜" : ""}</div>
  </div>
  <div class="body">
    <p>${H(e.area || "東京")}${e.venue ? "の「" + H(e.venue) + "」" : ""}で開催される盆踊りイベント${e.start ? "（" + H(dateRange(e)) + "）" : ""}の情報ページです。${e.feature ? H(e.feature) : ""}</p>

    <h2>開催情報</h2>
    <table>${rows}</table>
    ${e.feature ? `<h2>特徴・見どころ</h2><p>${H(e.feature)}</p>` : ""}

    <div>
      ${e.site ? `<a class="btn" href="${H(e.site)}" target="_blank" rel="noopener">${e.siteType === "official" ? "公式サイトで最新情報を確認" : "参考サイトを見る"}</a>` : ""}
      <a class="btn ghost" href="/#e/${H(e.eid)}">アプリで開く（行きたい登録）</a>
    </div>

    <div class="note">掲載情報は公開時点のものです。日程・時間・会場は天候や主催者の判断で変更・中止となる場合があります。おでかけ前に必ず公式情報をご確認ください。誤りを見つけた場合は<a href="${FORM_URL}" target="_blank" rel="noopener">情報提供フォーム</a>からご連絡ください。</div>

    <div class="adslot"><ins class="adsbygoogle" style="display:block" data-ad-client="${ADSENSE_CLIENT}" data-ad-format="auto" data-full-width-responsive="true"></ins><script>(adsbygoogle=window.adsbygoogle||[]).push({});</script></div>

    ${related.length ? `<h2>${H(e.area)}の盆踊り</h2><ul class="rel">${related.map(relRow).join("")}</ul>` : ""}
    ${near.length ? `<h2>開催日が近い盆踊り</h2><ul class="rel">${near.map(relRow).join("")}</ul>` : ""}
  </div>
  <footer class="foot">
    <a href="/">盆踊り一覧</a><a href="/about.html">運営者情報</a><a href="/privacy.html">プライバシーポリシー</a>
    <div class="footcredit">おどったー｜日本最大級の盆踊り情報サイト</div>
  </footer>
</div>
</body>
</html>`;
}

async function getEventPage(env, request) {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/event\/([^\/]+)\/?$/);
  const key = m ? decodeURIComponent(m[1]) : "";
  const events = await loadEvents(env, request);
  if (!events) return new Response("events.json not found", { status: 500, headers: SECURITY_HEADERS });
  const e = key && events.find(x => x.eid === key);
  if (!e) {
    // 不明IDはトップへ (SPA側のname/idルーティングはハッシュで担保)
    return Response.redirect(url.origin + "/", 302);
  }
  return new Response(renderEventPage(e, events), {
    headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" }
  });
}

async function getSitemap(env, request) {
  const today = todayJST();
  const events = (await loadEvents(env, request)) || [];
  const urls = [
    { loc: `${ORIGIN}/`, changefreq: "daily", priority: "1.0" },
    { loc: `${ORIGIN}/about.html`, changefreq: "yearly", priority: "0.3" },
    { loc: `${ORIGIN}/privacy.html`, changefreq: "yearly", priority: "0.3" },
    ...events.map(e => ({ loc: `${ORIGIN}/event/${e.eid}`, changefreq: "weekly", priority: "0.7" }))
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join("\n")}
</urlset>`;
  return new Response(xml, {
    headers: { ...SECURITY_HEADERS, "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/counts" && request.method === "GET") {
      return getCounts(env);
    }

    if (url.pathname === "/api/hit" && request.method === "POST") {
      return postHit(env, request);
    }

    if (url.pathname.startsWith("/event/") && request.method === "GET") {
      return getEventPage(env, request);
    }

    if (url.pathname === "/sitemap.xml") {
      return getSitemap(env, request);
    }

    // 静的アセットにもセキュリティヘッダを付与
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    for (const [h, v] of Object.entries(SECURITY_HEADERS)) headers.set(h, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
};
