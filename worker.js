// odottar API + イベント個別ページSSR + 静的アセット配信
// GET  /api/counts                          … いいね数マップ { eid: 数 }
// POST /api/hit?k=<eid>&op=inc|dec&id=<cid> … クライアント単位で冪等に加減算 (D1・アトミック)
// GET  /event/<eid>                         … イベント個別ページ (events.json からSSR)
// GET  /sitemap.xml                         … 全イベント個別ページを含む動的サイトマップ
//
// ■ イベント個別ページの設計 (2026-07-17 / 2026-08-05 りっち化)
//  index.html の SPA 個別ページ(.phero/.psec/.pcard/.pacts)テイストに合わせてSSR。
//  「友達を誘う」= 共有シート(Instagram/TikTok用の1080x1920画像生成 + LINE + X + コピー)。
//  「行きたい」= ハート + 数。SPAと同じ localStorage(odottar_kininaru_v2 / odottar_cid_v1)と /api を使う。
//  データ源は events.json。index.html の DATA 更新後は再生成: python3 pipeline/extract_data.py index.html > events.json
//
//  りっち化スキーマ(任意項目・入り次第表示/なければ非表示):
//   t_open(開場) time(踊り開始・既存) t_end(終了) kai(第◯回) yatai("あり")
//   rain(小雨決行/順延/中止) songs(・区切り) organizer(主催) address lat lng
//   pick(true=おどったーオススメ) fee("有料"で有料表示) poster(画像・出典明記で引用) image desc
//  設計: バッジは「記載があれば点灯」のみ(なし/不明は出さない=誤判定ゼロ)。主CTAは友達を誘う。
//        公式は出典に降格(おどったー内で完結)、地図はGoogleマップ外部リンク、ポスターは広告より下。
//        情報が乏しい小規模盆踊りはSEO配慮の定型文を自動表示。曲目タグは出現頻度順で低関連は薄表示。
//
// ■ いいね D1 移行 (2026-07-11): 1いいね=likes(eid,cid)の1行。INSERT OR IGNORE/DELETE はアトミック。
// ■ セキュリティ: id必須・長さ上限、Origin許可リスト、全レスポンスに基本ヘッダ。

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

let EVENTS_CACHE = null;
let SONG_FREQ = null;

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

function jd(iso) {
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

function splitSongs(s) {
  return String(s || "").split(/[・、,，／\/\s]+/).map(x => x.trim()).filter(Boolean);
}
function songFreq(events) {
  if (SONG_FREQ) return SONG_FREQ;
  const m = new Map();
  for (const e of events) for (const s of splitSongs(e.songs)) m.set(s, (m.get(s) || 0) + 1);
  SONG_FREQ = m;
  return m;
}
function sortedSongs(e, events) {
  const f = songFreq(events);
  return splitSongs(e.songs).sort((a, b) => (f.get(b) || 0) - (f.get(a) || 0));
}
function mapUrl(e) {
  const q = (e.lat && e.lng) ? `${e.lat},${e.lng}` : `${e.venue || e.name} ${e.address || e.area || ""}`.trim();
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function eventJsonLd(e) {
  const evUrl = `${ORIGIN}/event/${e.eid}`;
  const ld = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: e.name,
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    eventStatus: "https://schema.org/EventScheduled",
    location: {
      "@type": "Place",
      name: e.venue || e.name,
      address: { "@type": "PostalAddress", streetAddress: e.address || undefined, addressLocality: e.area || "", addressCountry: "JP" }
    },
    url: evUrl,
    isAccessibleForFree: e.fee !== "有料"
  };
  if (e.start) ld.startDate = e.time ? `${e.start}T${e.time}:00+09:00` : e.start;
  if (e.end || e.start) ld.endDate = e.end || e.start;
  if (e.lat && e.lng) ld.location.geo = { "@type": "GeoCoordinates", latitude: e.lat, longitude: e.lng };
  if (e.organizer) ld.organizer = { "@type": "Organization", name: e.organizer, url: e.site || undefined };

  // image: 推奨項目。常に付与（イベント画像→PDF以外のポスター→サイト共通OGP）
  const posterImg = /\.pdf(\?|#|$)/i.test(e.poster || "") ? "" : e.poster;
  ld.image = [e.image || posterImg || `${ORIGIN}/assets/ogp.png`];

  // description: 推奨項目。常に付与（desc→feature→自動生成）
  const songs = splitSongs(e.songs);
  ld.description = (e.desc || e.feature ||
    `${e.name}（${dateRange(e)}）の盆踊り情報。${e.venue ? "会場は" + e.venue + "。" : ""}${e.time ? "踊り開始" + e.time + "〜。" : ""}${songs.length ? "踊れる曲: " + songs.slice(0, 4).join("・") + "。" : ""}屋台・アクセス・地図はおどったーで。`
  ).slice(0, 300);

  // performer: 推奨項目。盆踊りの運営/出演団体（主催があれば主催、なければイベント名）
  ld.performer = { "@type": "PerformingGroup", name: e.organizer || e.name };

  // offers: 推奨項目。盆踊りは大半が入場無料（0円）。有料は公式へ誘導
  ld.offers = (e.fee !== "有料")
    ? { "@type": "Offer", url: e.site || evUrl, price: "0", priceCurrency: "JPY", availability: "https://schema.org/InStock", validFrom: e.start || undefined }
    : { "@type": "Offer", url: e.site || evUrl, availability: "https://schema.org/InStock", validFrom: e.start || undefined };

  if (e.site) ld.sameAs = e.site;
  return JSON.stringify(ld);
}

function renderEventPage(e, events) {
  const st = statusLabel(e);
  const ss = sortedSongs(e, events);
  const yr = (e.start || "2026").slice(0, 4);
  const title = `${e.name}｜${yr}年${e.area || "東京"}の盆踊り・夏祭り｜おどったー`;
  const desc = `${e.name}（${dateRange(e)}）の盆踊り情報。${e.time ? "踊り開始" + e.time + "〜。" : ""}${e.venue ? "会場: " + e.venue + "。" : ""}${ss.length ? "踊れる曲: " + ss.slice(0, 4).join("・") + "。" : ""}屋台・アクセス・地図もチェック。`.slice(0, 160);

  const related = events
    .filter(x => x.eid !== e.eid && x.area && x.area === e.area)
    .sort((a, b) => (a.start || "9999").localeCompare(b.start || "9999"))
    .slice(0, 6);
  const near = e.start ? events
    .filter(x => x.eid !== e.eid && x.start && !related.some(r => r.eid === x.eid))
    .sort((a, b) => Math.abs(jd(a.start) - jd(e.start)) - Math.abs(jd(b.start) - jd(e.start)))
    .slice(0, 4) : [];
  const relRow = x => `<li><a href="/event/${H(x.eid)}">${H(x.name)}</a><span class="rd">${x.start ? fmtDate(x.start) : "日程調査中"}${x.time ? "・" + H(x.time) + "〜" : ""}</span></li>`;

  // 属性バッジは常時表示。該当すれば色付き、非該当は激薄(saunaikitai式)。おどったーオススメは一覧ページのみ
  const badgeDefs = [
    { on: e.yatai === "あり", label: e.yatai === "あり" ? "屋台あり" : "屋台" },
    { on: !!e.rain, label: e.rain ? "雨天" + H(e.rain) : "雨天情報なし" }
  ];
  const chips = badgeDefs.map(b => `<span class="chip${b.on ? "" : " off"}">${b.label}</span>`).join("");

  const timeVal = e.time
    ? `${e.t_open ? "開場" + H(e.t_open) + " / " : ""}踊り開始 <b style="color:var(--accentD)">${H(e.time)}</b>${e.t_end ? " / 終了" + H(e.t_end) : ""}`
    : `<span style="color:var(--sub)">時間調査中</span>`;
  const mapCell = e.venue
    ? `${H(e.venue)} <a class="maplink" href="${mapUrl(e)}" target="_blank" rel="noopener">google map</a>`
    : `<span style="color:var(--sub)">調査中</span>`;
  // 曲目: 出現の多い順。該当曲のみ表示(薄表示はしない)
  const songVal = ss.length
    ? `<div class="stags">${ss.map(s => `<span class="ptag">${H(s)}</span>`).join("")}</div>`
    : `<span style="color:var(--sub)">情報募集中 — <a href="${FORM_URL}" target="_blank" rel="noopener">情報提供</a></span>`;

  const intro = `${H(e.area || "東京")}${e.venue ? "「" + H(e.venue) + "」" : ""}で開催される盆踊り${e.start ? "（" + H(dateRange(e)) + "）" : ""}。${e.time ? "踊り開始は" + H(e.time) + "ごろ。" : ""}${ss.length ? "「" + H(ss[0]) + "」など" + ss.length + "曲が踊れます。" : ""}${e.station ? "最寄りは" + H(e.station) + "。" : ""}`;
  const hasDetail = e.time || ss.length || e.desc || e.yatai || e.rain || e.organizer || e.t_open || e.kai;
  const summary = e.desc
    ? H(e.desc)
    : hasDetail
      ? intro
      : `${e.venue ? H(e.venue) : H(e.name)}で開催される${e.area ? H(e.area) + "の" : ""}地域密着型の盆踊り。${yr}年の日程・時間・屋台などの詳細はわかり次第更新します。`;
  const posterIsPdf = /\.pdf(\?|#|$)/i.test(e.poster || "");
  const posterBlock = e.poster
    ? (posterIsPdf
      ? `<div class="poster pdf"><a class="btn" href="${H(e.poster)}" target="_blank" rel="noopener">📄 ポスター/チラシを見る（PDF）</a><div class="pcap">出典: ${e.site ? `<a href="${H(e.site)}" target="_blank" rel="noopener">公式サイト</a>` : "主催者"}</div></div>`
      : `<figure class="poster"><img src="${H(e.poster)}" alt="${H(e.name)}のポスター" loading="lazy"><figcaption>ポスター出典: ${e.site ? `<a href="${H(e.site)}" target="_blank" rel="noopener">公式サイト</a>` : "主催者"}</figcaption></figure>`)
    : "";
  const posterImg = (!posterIsPdf && e.poster) || "";

  const evUrl = `${ORIGIN}/event/${e.eid}`;
  const inviteText = `【盆踊りのお誘い】\nShall we BON dance?\n${e.kai ? "第" + e.kai + "回 " : ""}${e.name}\n${dateRange(e)}\n\nおどったー｜日本最大級の盆踊り情報サイト\n${evUrl}`;
  const SH = {
    name: e.name, date: dateRange(e), venue: e.venue || "調査中",
    station: e.station || "", area: e.area || "", kai: e.kai ? ("第" + e.kai + "回 ") : "",
    url: evUrl, invite: inviteText
  };

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
<meta property="og:image" content="${e.image || posterImg || ORIGIN + "/assets/ogp.png"}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${e.image || posterImg || ORIGIN + "/assets/ogp.png"}">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/icons/favicon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/icons/apple-touch-icon-180.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@400;500;700;800;900&display=swap" rel="stylesheet">
<script type="application/ld+json">${eventJsonLd(e)}</script>
<style>
  :root{--bg:#eaf4fb;--card:#fff;--ink:#0f1419;--sub:#5b7083;--line:#e3eaef;--line2:#cfdee9;--accent:#1da1f2;--accentD:#1a8cd8;--tint:#e8f5fd;--like:#f4326e;--max:480px}
  *{box-sizing:border-box;margin:0;-webkit-tap-highlight-color:transparent}
  html,body{background:var(--bg);color:var(--ink);line-height:1.45;
    font-family:"M PLUS Rounded 1c","Hiragino Maru Gothic ProN","Hiragino Sans","Yu Gothic UI","Yu Gothic",-apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased}
  .app{max-width:var(--max);margin:0 auto;background:var(--card);min-height:100vh}
  .phead{position:sticky;top:0;z-index:5;background:var(--accent);color:#fff;display:flex;align-items:center;gap:8px;padding:11px 12px}
  .phead a.bk{color:#fff;text-decoration:none;font-size:1.3rem;line-height:1;padding:0 4px}
  .ptitle{font-weight:800;font-size:.98rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pbody{padding:14px 14px 20px}
  .phero{background:var(--tint);border-radius:16px;padding:15px 16px;margin-bottom:12px}
  .pdt{font-size:.72rem;color:var(--accentD);font-weight:800;margin-bottom:5px}
  .bdg{font-size:.62rem;font-weight:800;padding:1px 8px;border-radius:20px}
  .bdg.soon{color:var(--accentD);background:#fff}
  .bdg.live{color:#fff;background:var(--accent)}
  .bdg.end,.bdg.tbd{color:var(--sub);background:#e6ebf0}
  .pname{font-size:1.5rem;font-weight:900;line-height:1.3;color:var(--ink)}
  .pdate{margin-top:9px;font-size:1.02rem;font-weight:800;color:var(--accentD)}
  .podori{margin-top:10px;font-size:.95rem;font-weight:800;color:var(--ink)}
  .podori b{font-size:1.15rem}
  .chips{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}
  .chip{font-size:.7rem;font-weight:700;color:var(--accentD);background:var(--tint);border:1px solid #d7e6f2;border-radius:20px;padding:3px 10px}
  .chip.off{color:#c3ccd3;background:#f7f9fb;border-color:#eef1f4;font-weight:400}
  .psec{font-size:.74rem;font-weight:800;color:var(--sub);letter-spacing:.04em;margin:2px 2px 7px}
  .pnote{font-size:.85rem;color:#3d4d5c;line-height:1.75;background:#f6f9fb;border-radius:14px;padding:13px 15px;margin-bottom:16px}
  .pcard{border:1px solid var(--line2);border-radius:16px;overflow:hidden;margin-bottom:14px}
  .pitem{display:flex;gap:12px;padding:11px 15px;border-bottom:1px solid var(--line);font-size:.87rem}
  .pitem:last-child{border-bottom:none}
  .pitem .pl{flex:0 0 74px;color:var(--sub);font-weight:700}
  .pitem .pv{flex:1;color:var(--ink);line-height:1.55}
  .maplink{font-size:.78rem}
  .stags{display:flex;gap:6px;flex-wrap:wrap}
  .ptag{font-size:.74rem;font-weight:700;color:var(--accentD);background:var(--tint);border-radius:20px;padding:3px 10px}
  .ptag.dim{color:#9aa4ad;background:#f1f4f7;font-weight:400}
  .formlink{display:inline-block;color:var(--accentD);font-size:.8rem;font-weight:700;text-decoration:underline;margin-bottom:14px}
  .pacts{display:flex;flex-direction:column;gap:9px;margin:4px 0 12px}
  .pacts .btn{padding:15px;font-size:.95rem;border-radius:12px;display:flex;align-items:center;justify-content:center;gap:6px;
    border:1px solid var(--line2);background:#fff;color:var(--ink);cursor:pointer;font-family:inherit;font-weight:800;text-decoration:none}
  .pacts .btn.primary{background:var(--like);border-color:var(--like);color:#fff;font-size:1.05rem}
  .pacts .heartbtn{color:var(--like);border-color:#f3c2cf}
  .pacts .heartbtn.on{background:var(--like);color:#fff;border-color:var(--like)}
  .pofficial2{display:inline-block;margin:2px 0 14px;color:#8a94a0;font-size:.78rem;font-weight:700;text-decoration:underline}
  .adslot{margin:8px 0;min-height:90px}
  .poster{margin:8px 0 4px}
  .poster img{width:100%;border-radius:14px;border:1px solid var(--line2);display:block}
  .poster figcaption{font-size:.7rem;color:var(--sub);text-align:center;margin-top:5px}
  .poster.pdf a.btn{display:flex;align-items:center;justify-content:center;gap:6px;padding:14px;border:1px solid var(--line2);border-radius:12px;background:#fff;color:var(--accentD);font-weight:800;font-size:.9rem;text-decoration:none}
  .poster.pdf .pcap{font-size:.7rem;color:var(--sub);text-align:center;margin-top:5px}
  .rel{list-style:none;padding:0;margin:4px 0 8px}
  .rel li{padding:9px 2px;border-bottom:1px solid var(--line)}
  .rel a{font-weight:800;color:var(--accentD);text-decoration:none;font-size:.85rem}
  .rd{display:block;font-size:.72rem;color:var(--sub);margin-top:1px}
  .src{font-size:.72rem;color:var(--sub);margin:14px 2px 0;line-height:1.6}
  .foot{padding:22px 16px 30px;text-align:center;background:var(--bg);border-top:1px solid var(--line);margin-top:20px}
  .foot a{font-size:.8rem;font-weight:700;color:var(--accentD);margin:0 8px;text-decoration:none}
  .footcredit{margin-top:10px;font-size:.7rem;color:var(--sub)}
  .toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(16px);background:#0f1419;color:#fff;padding:8px 15px;border-radius:20px;font-size:.8rem;opacity:0;pointer-events:none;transition:.22s;z-index:90}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  .invitebox{margin-bottom:10px}
  .inviteimg{display:block;width:100%;max-width:220px;margin:0 auto 10px;border-radius:12px;border:1px solid var(--line2)}
  .ibtn{width:100%;border:1px solid var(--line2);background:#fff;border-radius:12px;padding:13px;font-size:.9rem;font-weight:800;color:var(--ink);cursor:pointer;font-family:inherit}
  .ibtn.img{background:var(--like);border-color:var(--like);color:#fff;font-size:1rem;margin-top:8px}
  .irow{display:flex;gap:8px}
  .irow .ibtn{flex:1;padding:11px;font-size:.82rem}
</style>
</head>
<body>
<div class="app">
  <div class="phead"><a class="bk" href="/" aria-label="盆踊り一覧へ戻る">←</a><div class="ptitle">${H(e.name)}</div></div>
  <div class="pbody">
    <div class="phero">
      <div class="pdt"><span class="bdg ${st.c}">${H(st.t)}</span>${e.kai ? " 第" + H(e.kai) + "回" : ""}</div>
      <div class="pname">${H(e.name)}</div>
      <div class="pdate">${H(dateRange(e))}</div>
      <div class="podori">♪ 踊り開始 <b>${e.time ? H(e.time) : "時間調査中"}</b>${(e.t_open || e.t_end) ? `<span style="font-size:.72rem;font-weight:500;color:var(--sub)"> （${e.t_open ? "開場" + H(e.t_open) : ""}${e.t_end ? (e.t_open ? "・" : "") + "終了" + H(e.t_end) : ""}）</span>` : ""}</div>
    </div>
    ${chips ? `<div class="chips">${chips}</div>` : ""}

    <div class="psec">開催情報</div>
    <div class="pcard">
      <div class="pitem"><span class="pl">踊り始め</span><span class="pv">${timeVal}</span></div>
      <div class="pitem"><span class="pl">会場</span><span class="pv">${mapCell}</span></div>
      <div class="pitem"><span class="pl">エリア</span><span class="pv">${H(e.area || "—")}${e.station ? " " + H(e.station) : ""}</span></div>
      ${e.organizer ? `<div class="pitem"><span class="pl">主催</span><span class="pv">${H(e.organizer)}</span></div>` : ""}
      <div class="pitem"><span class="pl">踊れる曲</span><span class="pv">${songVal}</span></div>
    </div>

    <div class="psec">概要</div>
    <div class="pnote">${summary}</div>

    <a class="formlink" href="${FORM_URL}" target="_blank" rel="noopener">この盆踊りの情報を提供・修正する</a>

    <div class="psec">友達を誘う</div>
    <div class="invitebox">
      <img id="inviteImg" class="inviteimg" alt="${H(e.name)}のお誘い画像">
      <div class="irow">
        <button class="ibtn" type="button" onclick="lineInvite()">LINE</button>
        <button class="ibtn" type="button" onclick="xInvite()">X</button>
        <button class="ibtn" type="button" onclick="copyInvite()">コピー</button>
      </div>
      <button class="ibtn img" type="button" onclick="shareImgFile()">画像を保存・共有</button>
    </div>
    <div class="pacts">
      <button class="btn heartbtn" id="hb" type="button"><span>♡ 行きたい</span> <b id="hc">0</b></button>
    </div>

    ${e.site ? `<a class="pofficial2" href="${H(e.site)}" target="_blank" rel="noopener">出典: 公式サイト</a>` : ""}

    <div class="adslot"><ins class="adsbygoogle" style="display:block" data-ad-client="${ADSENSE_CLIENT}" data-ad-format="auto" data-full-width-responsive="true"></ins><script>(adsbygoogle=window.adsbygoogle||[]).push({});</script></div>

    ${posterBlock ? `<div class="psec">ポスター</div>${posterBlock}` : ""}

    ${related.length ? `<div class="psec">${H(e.area)}の盆踊り</div><ul class="rel">${related.map(relRow).join("")}</ul>` : ""}
    ${near.length ? `<div class="psec">開催日が近い盆踊り</div><ul class="rel">${near.map(relRow).join("")}</ul>` : ""}

    <div class="src">変更・中止の場合あり。おでかけ前に公式でご確認ください。</div>
  </div>
  <footer class="foot">
    <a href="/">盆踊り一覧</a><a href="/guide.html">初心者ガイド</a><a href="/about.html">運営者情報</a><a href="/privacy.html">プライバシーポリシー</a>
    <div class="footcredit">おどったー｜日本最大級の盆踊り情報サイト</div>
  </footer>
</div>

<canvas id="shCanvas" width="1080" height="1920" style="display:none"></canvas>
<div class="toast" id="toast"></div>

<script>
var SH=${JSON.stringify(SH)};
function toast(m){var t=document.getElementById("toast");t.textContent=m;t.className="toast show";setTimeout(function(){t.className="toast";},2000);}
function copyInvite(){if(navigator.clipboard){navigator.clipboard.writeText(SH.invite).then(function(){toast("コピーしました。LINEに貼り付けて送ってね");}).catch(function(){toast("コピーできませんでした");});}else{window.prompt("コピーしてください",SH.invite);}}
function lineInvite(){window.open("https://line.me/R/msg/text/?"+encodeURIComponent(SH.invite),"_blank","noopener");}
function xInvite(){window.open("https://twitter.com/intent/tweet?text="+encodeURIComponent(SH.name+"（"+SH.date+"）に行こう！")+"&url="+encodeURIComponent(SH.url),"_blank","noopener");}
function rr(x,X,Y,W,Hh,R){x.beginPath();x.moveTo(X+R,Y);x.arcTo(X+W,Y,X+W,Y+Hh,R);x.arcTo(X+W,Y+Hh,X,Y+Hh,R);x.arcTo(X,Y+Hh,X,Y,R);x.arcTo(X,Y,X+W,Y,R);x.closePath();}
function wrap(x,text,X,Y,maxW,lh){var cs=Array.from(text),line="",yy=Y;for(var i=0;i<cs.length;i++){var t=line+cs[i];if(x.measureText(t).width>maxW&&line){x.fillText(line,X,yy);line=cs[i];yy+=lh;}else line=t;}if(line)x.fillText(line,X,yy);return yy;}
function drawCard(){var c=document.getElementById("shCanvas");c.width=1080;c.height=1920;var x=c.getContext("2d");
x.fillStyle="#1da1f2";x.fillRect(0,0,1080,1920);var g=x.createLinearGradient(0,0,0,1300);g.addColorStop(0,"#3cb0f7");g.addColorStop(1,"#1a97e6");x.fillStyle=g;x.fillRect(0,0,1080,1300);
x.textAlign="left";x.fillStyle="rgba(255,255,255,.9)";x.font="600 30px 'M PLUS Rounded 1c','Hiragino Sans',sans-serif";x.fillText("日本最大級の盆踊り情報サイト",60,92);x.fillText("2026年盆踊り日程一覧",60,134);
x.textAlign="center";x.fillStyle="#fff";x.font="900 168px 'M PLUS Rounded 1c','Hiragino Maru Gothic ProN','Hiragino Sans',sans-serif";x.fillText("おどったー",540,420);
x.font="800 54px 'M PLUS Rounded 1c','Hiragino Sans',sans-serif";x.fillStyle="rgba(255,255,255,.96)";x.fillText("Shall we BON dance?",540,520);
x.fillStyle="#fff";rr(x,70,660,940,600,40);x.fill();x.textAlign="left";x.fillStyle="#0f1419";x.font="900 66px 'M PLUS Rounded 1c','Hiragino Sans',sans-serif";
var yy=wrap(x,SH.kai+SH.name,120,762,800,80)+34;
function row(label,val){yy+=78;x.fillStyle="#8a94a0";x.font="bold 38px 'M PLUS Rounded 1c','Hiragino Sans',sans-serif";x.fillText(label,120,yy);x.fillStyle="#0f1419";x.font="40px 'M PLUS Rounded 1c','Hiragino Sans',sans-serif";x.fillText(val,300,yy);}
row("日程",SH.date);row("会場",SH.venue);row("最寄",SH.station+(SH.area?"・"+SH.area:""));return c;}
function renderInvite(){var c=drawCard();var img=document.getElementById("inviteImg");if(img)img.src=c.toDataURL("image/png");window._sf=null;window._blob=null;c.toBlob(function(b){if(!b)return;window._blob=b;if(navigator.canShare){try{var f=new File([b],"odottar.png",{type:"image/png"});if(navigator.canShare({files:[f]}))window._sf=f;}catch(e){}}},"image/png");}
if(document.fonts&&document.fonts.ready){document.fonts.ready.then(renderInvite);}else{renderInvite();}
function shareImgFile(){if(window._sf&&navigator.share){navigator.share({files:[window._sf],text:SH.invite}).catch(function(){});}else if(window._blob){var a=document.createElement("a");a.href=URL.createObjectURL(window._blob);a.download="odottar.png";document.body.appendChild(a);a.click();a.remove();}else{toast("画像を保存してください");}}
(function(){var EID=${JSON.stringify(e.eid)},KEY="odottar_kininaru_v2",CK="odottar_cid_v1";
function gl(){try{return JSON.parse(localStorage.getItem(KEY)||"{}")||{}}catch(e){return{}}}
function cid(){var c="";try{c=localStorage.getItem(CK)||"";if(!c){c=(self.crypto&&crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(36).slice(2));localStorage.setItem(CK,c);}}catch(e){}return c;}
var b=document.getElementById("hb"),c=document.getElementById("hc"),liked=!!gl()[EID],remote=null;
function paint(){b.className="btn heartbtn"+(liked?" on":"");b.firstChild.textContent=liked?"♥ 行きたい済":"♡ 行きたい";c.textContent=(remote!=null?remote:(liked?1:0));}
paint();
fetch("/api/counts").then(function(r){return r.json();}).then(function(j){if(j&&j[EID]!=null){remote=j[EID];paint();}}).catch(function(){});
b.addEventListener("click",function(){var L=gl(),op;if(L[EID]){delete L[EID];liked=false;op="dec";}else{L[EID]=true;liked=true;op="inc";}try{localStorage.setItem(KEY,JSON.stringify(L));}catch(e){}paint();fetch("/api/hit?k="+encodeURIComponent(EID)+"&op="+op+"&id="+encodeURIComponent(cid()),{method:"POST"}).then(function(r){return r.json();}).then(function(j){if(j&&j.count!=null){remote=j.count;paint();}}).catch(function(){});});
})();
</script>
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
    { loc: `${ORIGIN}/guide.html`, changefreq: "monthly", priority: "0.8" },
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
    if (url.pathname === "/api/counts" && request.method === "GET") return getCounts(env);
    if (url.pathname === "/api/hit" && request.method === "POST") return postHit(env, request);
    if (url.pathname.startsWith("/event/") && request.method === "GET") return getEventPage(env, request);
    if (url.pathname === "/sitemap.xml") return getSitemap(env, request);
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    for (const [h, v] of Object.entries(SECURITY_HEADERS)) headers.set(h, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
};
