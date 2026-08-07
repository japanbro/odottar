#!/usr/bin/env python3
"""events.json から sitemap.xml を全件生成する。

- 静的ページ（トップ / guide / about / privacy）＋ 全イベント個別ページ /event/<eid>
- events.json は worker.js が /event/<eid> をSSRする際の正データ。ここを唯一の真実として使う。
- 優先度/更新頻度は開催状況で出し分け:
    開催予定(終了日>=今日 JST)  priority 0.7 / changefreq weekly
    終了(過去)                  priority 0.4 / changefreq yearly   ※来年の資産として残す
    日付無                      priority 0.5 / changefreq monthly
- lastmod は events.json の更新日(JST)。

usage: python3 pipeline/gen_sitemap.py            # sitemap.xml を書き換え
       python3 pipeline/gen_sitemap.py --check    # 生成せず件数だけ表示
"""
import json, os, sys, datetime
from xml.sax.saxutils import escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVENTS = os.path.join(ROOT, "events.json")
OUT = os.path.join(ROOT, "sitemap.xml")
ORIGIN = "https://odottar.com"
JST = datetime.timezone(datetime.timedelta(hours=9))

# 静的ページ: (path, changefreq, priority)
STATIC = [
    ("/", "daily", "1.0"),
    ("/guide.html", "monthly", "0.8"),
    ("/about.html", "yearly", "0.3"),
    ("/privacy.html", "yearly", "0.3"),
]

def today_jst():
    return datetime.datetime.now(JST).date().isoformat()

def data_mtime_date():
    ts = os.path.getmtime(EVENTS)
    return datetime.datetime.fromtimestamp(ts, JST).date().isoformat()

def event_rank(e, today):
    """(changefreq, priority) を開催状況から決める。"""
    end = e.get("end") or e.get("start") or ""
    if not (e.get("start") or e.get("end")):
        return ("monthly", "0.5")      # 日付無
    if end >= today:
        return ("weekly", "0.7")       # 開催予定
    return ("yearly", "0.4")           # 終了

def url_block(loc, lastmod, changefreq, priority):
    return (
        "  <url>\n"
        f"    <loc>{escape(loc)}</loc>\n"
        f"    <lastmod>{lastmod}</lastmod>\n"
        f"    <changefreq>{changefreq}</changefreq>\n"
        f"    <priority>{priority}</priority>\n"
        "  </url>"
    )

def build():
    data = json.load(open(EVENTS, encoding="utf-8"))
    today = today_jst()
    lastmod = data_mtime_date()

    blocks = [url_block(f"{ORIGIN}{p}", lastmod, cf, pr) for (p, cf, pr) in STATIC]

    seen, n_event = set(), 0
    for e in data:
        eid = e.get("eid")
        if not eid or eid in seen:
            continue
        seen.add(eid)
        cf, pr = event_rank(e, today)
        blocks.append(url_block(f"{ORIGIN}/event/{eid}", lastmod, cf, pr))
        n_event += 1

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(blocks)
        + "\n</urlset>\n"
    )
    return xml, len(STATIC), n_event

def main():
    xml, n_static, n_event = build()
    if "--check" in sys.argv:
        print(f"[check] static={n_static} events={n_event} total={n_static + n_event}")
        return
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(xml)
    print(f"[gen_sitemap] wrote {OUT}: static={n_static} events={n_event} total={n_static + n_event}")

if __name__ == "__main__":
    main()
