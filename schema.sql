-- odottar いいねカウンタ (Cloudflare D1)
-- 実行: Cloudflare ダッシュボード > D1 > odottar-likes > Console にこの内容を貼って実行
--
-- 設計:
--  likes … 1いいね = 1行 (eid, cid)。PRIMARY KEY で二重いいねを DB レベルで拒否。
--          INSERT OR IGNORE / DELETE はアトミックなので read-modify-write のレース(カウント落ち)が起きない。
--  seed  … 旧KV方式(名前キー・単一JSON)で貯まっていたカウントの引き継ぎ用ベース値。
--          表示カウント = seed.n + likes の行数。

CREATE TABLE IF NOT EXISTS likes (
  eid TEXT NOT NULL,               -- イベント不変ID (index.html の DATA.eid)
  cid TEXT NOT NULL,               -- クライアントID (localStorage の UUID)
  ts  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (eid, cid)
);
CREATE INDEX IF NOT EXISTS idx_likes_eid ON likes(eid);

CREATE TABLE IF NOT EXISTS seed (
  eid TEXT PRIMARY KEY,
  n   INTEGER NOT NULL DEFAULT 0
);

-- 旧KVカウントの移行 (2026-07-11 時点の /api/counts の値。「テスト会場」はテストデータのため除外)
INSERT INTO seed (eid, n) VALUES ('b9af28bb93', 4) ON CONFLICT(eid) DO UPDATE SET n = excluded.n;  -- 上池袋さくら公園
INSERT INTO seed (eid, n) VALUES ('669c16c9ff', 5) ON CONFLICT(eid) DO UPDATE SET n = excluded.n;  -- 下北沢盆踊り
INSERT INTO seed (eid, n) VALUES ('2c3634c0c6', 9) ON CONFLICT(eid) DO UPDATE SET n = excluded.n;  -- 大正大学 鴨台(おうだい)盆踊り
INSERT INTO seed (eid, n) VALUES ('61678039ae', 3) ON CONFLICT(eid) DO UPDATE SET n = excluded.n;  -- 土支田八幡宮
