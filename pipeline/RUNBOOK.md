# odottar 盆踊りDB更新パイプライン RUNBOOK

掲載盆踊りの定期更新手順。Claudeに「盆踊りDB更新して（RUNBOOK通りに）」と言えば全工程を実行できる。

## 方式

ソースA（キュレーション）で発見 → ソースB（主催公式）で裏取り → 裏取り済みのみDATA反映。
公式が確認できないものは「要確認」シートに残し、掲載しない。

## 工程

### 1. 巡回（Claudeのweb検索/フェッチで実施）
- `sources.json` のソースを巡回。discovery系（bondance等）＋large系（Walkerplus/オマツリジャパン/ぴあ）の両方を必ず回る（大型の取りこぼし対策）。
- 対象: 東京・当年・実行日〜+90日。昨年日付の残骸（特にenjoytokyo）に注意。
- 出力: `pipeline/work/candidates_YYYY-MM-DD.json`
  ```json
  [{"name":"…","start":"2026-08-01","end":"2026-08-02","venue":"…","area":"◯◯区",
    "station":"…","time":"18:00","feature":"…","site":"…","siteType":"official|ref",
    "source":"bondance"}]
  ```

### 2. 名寄せ・トリアージ
```bash
cd pipeline
python3 triage.py work/candidates_YYYY-MM-DD.json ../index.html work/triage_YYYY-MM-DD.csv
```
- 既存＝スキップ／要確認＝人間レビュー行き／新規＝裏取りへ。

### 3. 公式裏取り（Claudeで実施）
- 「新規」各件について公式（町会/神社/商店街/実行委/区）を検索・確認。
- 確認項目: 今年開催の明記・日程・**踊り開始時刻（最重要）**・会場・雨天対応。
- 二次まとめ（uwasa-no等、sources.jsonのbanned_as_official）はofficialに採用しない。区公式は代替可。
- 公式確認できた件のみ `work/verified_YYYY-MM-DD.json`（candidatesと同スキーマ＋summary等任意項目）へ。

### 4. 反映
```bash
python3 apply.py work/verified_YYYY-MM-DD.json ../index.html ../odottar_db_merged_2026.csv
```
- eid自動付与（sha1(name|start|venue)先頭10桁＝サイトのいいねAPIと互換）
- index.htmlはバックアップ(.bak_日付)作成後、DATAにstart昇順で挿入
- マスターCSV追記＋CHANGELOG生成

### 4.5 重複整理
```bash
python3 dedupe.py ../index.html          # レポート確認
python3 dedupe.py ../index.html --apply  # 問題なければ適用
```
- 同一日×会場/名称類似の2重登録を検出・マージ。誤名寄せはEXCLUDE_PAIRS、機械検出漏れはFORCE_PAIRSに追記。
- apply後は必ず `python3 extract_data.py ../index.html > ../events.json` で再生成。

### 5. 検証・デプロイ
```bash
node -e "
const m=require('fs').readFileSync('../index.html','utf8').match(/let DATA = \[[\s\S]*?\n\];/)[0];
const DATA=new Function(m.replace('let DATA','const DATA')+' return DATA;')();
console.log('DATA OK:',DATA.length,'／eid重複:',DATA.length-new Set(DATA.map(e=>e.eid)).size);"
```
※日程未発表のエントリ（start空）9件が末尾にある想定。必須欠損チェックからは除外してよい。
- デプロイ（2026-07-31から自動化）:
```bash
python3 deploy.py   # index.html, events.json, マスターCSV を GitHub main へpush → Cloudflare自動反映
```
- トークン: `pipeline/.secrets/github_token`（gitignore済み）。未設定時は従来通りGitHub Web UIで手動アップロード。
- deploy.pyは毎回fresh cloneするのでローカル.gitとGitHub履歴の食い違い事故なし。wranglerは使わない。
- **sitemap.xml は deploy.py が自動再生成＋push対象に追加**（events.json を送るデプロイ時）。全イベント個別ページ /event/&lt;eid&gt; を全件収録。手動再生成は `python3 gen_sitemap.py`（`--check`で件数のみ）。lastmodはevents.jsonのmtime基準＝データ不変なら差分ゼロ。

## 補助スクリプト
- `extract_data.py` — index.htmlのDATA→JSON抽出（string/number/bool対応）
- `normalize.py` — 名称正規化・eid生成・名寄せキー
- `apply_overrides.py` — キュレーションCSV(人手の修正・オススメ)をevents.jsonに後がけ上書き
- `export_csv.py` — events.json→events.csv（人が一覧を閲覧する用）
- `gen_sitemap.py` — events.json→sitemap.xml（全イベント個別ページを全件収録／SEO発見性）
- `sources.json` — 巡回ソース定義（追加はここに）
- `SCHEMA.md` — 確定スキーマ（必須/推奨/任意・個別ページ表示先）

## 毎日自動運用（人手ゼロ）

正データ = `events.json`（git）。人の編集は「キュレーションSheet」に書き、パイプラインが読むだけ。
毎日の予約タスクが以下を無人実行する:

```bash
cd pipeline
# 1. 発見〜裏取り〜反映（上記 工程1〜4.5）→ index.html/events.json ベース更新
# 2. キュレーション(人手の修正・オススメ)を後がけ
python3 apply_overrides.py ../events.json "$CURATION_CSV_URL" > ../events.tmp.json && mv ../events.tmp.json ../events.json
# 3. 閲覧用CSV書き出し
python3 export_csv.py ../events.json > ../events.csv
# 4. デプロイ（events.json/events.csv/index.html/worker.js）
python3 deploy.py events.json events.csv index.html worker.js
```

### 人の関わり（毎日ではない・任意）
- **一覧を見る**: リポジトリの `events.csv` をGoogle Sheets/Excelで開く（読み取り専用の最新一覧）。
- **間違いを直す / イチオシを選ぶ**: 自分専用の「キュレーションSheet」を編集し公開CSVにする。
  列は events.csv と同じ。埋めたセルだけ上書きされる。マッチは eid（無ければ name|start|venue）。
  - イチオシ → `pick` 列に TRUE
  - 修正 → 直したい列に正しい値（例: `time` に 19:00）
  - name/start/venue は eid凍結のため上書き不可（変更は別運用）。
  - このSheetのCSV公開URLを `CURATION_CSV_URL` に設定。

### 設定（1回だけ・人手）
- `pipeline/.secrets/github_token` … PAT。無いと自動デプロイ不可。
- `CURATION_CSV_URL` … キュレーションSheetの公開CSV URL（env or deploy設定）。未設定なら overrides 0件で素通し。

## 注意
- index.htmlはローカルが最新のことがある（GitHub側と履歴別）。反映前にローカルを正とする。
- 中止・延期情報も巡回時に拾い、該当既存イベントがあればfeatureに反映 or 削除判断。
- 将来方向: 投稿型（主催者からの情報受付）への移行を優先検討（別途）。
