# minato-mygov — プロジェクト引き継ぎ書

---

## 🔰 新しいセッションの始め方

**アプリのチャットで新しい会話を始めるとき、最初にこの一文を送るだけ：**

> 「`C:\Users\Kohta\minato-mygov\CLAUDE.md` を読んで、プロジェクトの続きをやりたい」

Claudeがこのファイルを読んで、プロジェクトの全体像・実装済み内容・残タスクを
すべて把握した状態で会話を始めてくれる。それだけでOK。黒い画面は不要。

---

## プロジェクト概要

港区（東京都）の行政制度・給付情報をパーソナライズして届けるPWA。
ユーザーのプロフィール（年齢・ライフステージ・子供の有無など）と照合し、
関係ある制度だけを表示・Web Push通知する。

---

## 関連リポジトリ・サービス一覧

| 項目 | 内容 |
|---|---|
| GitHubユーザー | k0ki1k2k3-lgtm |
| フロントエンド | https://k0ki1k2k3-lgtm.github.io/minato-mygov/ |
| 管理画面（ローカル/GitHub Pages） | `/admin-v1.3.html`（ルートに置いてある。`admin/`ではない） |
| メインリポジトリ（Public） | https://github.com/k0ki1k2k3-lgtm/minato-mygov |
| クローラーリポジトリ（Private） | https://github.com/k0ki1k2k3-lgtm/minato-mygov-crawler |
| Cloudflare Worker URL | https://minato-mygov-push.k-0k-i1k-2k-3.workers.dev |
| Cloudflareアカウント | k.0k.i1k.2k.3@gmail.com |
| push-workerローカルパス | `F:\OneDrive\ドキュメント\Claude\Projects\行政情報一括配信アプリ\push-worker\` |
| Claudeモデル名（正） | **`claude-sonnet-4-6`**（`claude-sonnet-4-20250514`は404エラー） |

---

## システム全体フロー

```
[minato-mygov-crawler リポジトリ]
  GitHub Actions (collect.yml) → 毎日23:00 UTC
    ├─ rss_watcher.py    : RSS監視 → data/rss-new.json
    ├─ pdf_extractor.py  : 広報みなとPDF解析 → data/pdf-new.json
    ├─ deep_crawler.py   : 深掘りクロール → data/crawl-new.json
    └─ analyzer.py       : AI統合分析 (claude-sonnet-4-6) → data/drafts.json
                           → GitHub Issueも作成（管理者通知）

[管理者作業]
  admin-v1.3.html でdrafts.jsonを確認
    → 「✏️ 編集して追加」で制度を編集・追加
    → items-db.jsonにGitHub API経由で書き込み
    → mainブランチへPush

[minato-mygov リポジトリ（Public）]
  items-db.json が更新される
    → notify.yml が起動
    → Python で新着制度を特定して通知文を生成
    → POST /notify/users → Cloudflare Worker にキュー追加

[Cloudflare Worker (push-worker)]
  Cron Trigger (0 * * * * = 毎時0分)
    → KVの通知キューを確認
    → 各ユーザーのライフステージ別送信時刻と照合
    → 1日最大2件でWeb Pushを送信

[ブラウザ (PWA)]
  sw.js: Push受信 → shouldNotify() でプロフィールと照合
    → 関係ある制度のみ通知表示
    → 通知タップ → NOTIF_OPEN postMessage → DetailModal表示
```

---

## ファイル構成

### `C:\Users\Kohta\minato-mygov\`（メインリポジトリ）

| ファイル | 役割 |
|---|---|
| `index.html` | メインPWA（React, ~4000行, Babel Standalone） |
| `sw.js` | Service Worker（Push受信・プロフィール照合・通知表示） |
| `admin-v1.3.html` | 管理画面（草稿レビュー・制度登録・編集） |
| `items-db.json` | 制度データベース（50件 + festivals） |
| `interest-tags-master.json` | インタレストタグ分類マスター（l1/l2/l3三階層） |
| `manifest.json` | PWAマニフェスト |
| `icon-192.png`, `icon-72.png` | PWAアイコン |
| `minato-mygov (7).html` | **古いドラフト。削除してよい。** |
| `.github/workflows/notify.yml` | items-db.json更新時にPush通知を送るCI |

### `C:\Users\Kohta\minato-mygov-crawler\`（クローラーリポジトリ）

| ファイル | 役割 |
|---|---|
| `.github/workflows/collect.yml` | 収集・分析の全ジョブ定義 |
| `scripts/rss_watcher.py` | RSS監視スクリプト |
| `scripts/pdf_extractor.py` | 広報みなとPDF解析 |
| `scripts/deep_crawler.py` | 深掘りクロール |
| `scripts/analyzer.py` | AI統合分析（Claude API使用） |
| `data/drafts.json` | 管理者レビュー待ちの草稿 |
| `data/city-config.json` | RSSフィード・クロール対象・除外キーワード定義 |

### `F:\OneDrive\...\push-worker\`（Cloudflare Workers）

| ファイル | 役割 |
|---|---|
| `src/index.ts` | Workerメイン（VAPID送信・キュー管理・Cron） |
| `wrangler.toml` | KV設定・Cron設定（`0 * * * *`） |

---

## items-db.json 制度データのスキーマ

```json
{
  "id": "unique_id",
  "gov": "国|東京都|港区",
  "icon": "👶",
  "colorKey": "blue|green|orange|purple|red|gray",
  "tag": "子育て|医療|仕事|住宅|教育|年金|障害|生活",
  "title": "表示タイトル",
  "officialName": "正式名称",
  "catch": "キャッチコピー（一覧カードに表示）",
  "body": "本文説明",
  "officialBody": "公式文章（条文等）",
  "deadline": "申請期限",
  "urgent": false,
  "subsidyType": "cash|service|discount",
  "subsidyFixed": 120000,
  "subsidyRules": [...],
  "subsidyLabelRules": [...],
  "potentialSubsidy": 360000,
  "potentialLabel": "第3子なら年36万円",
  "reminderLabel": "申請の確認",
  "sourceUrl": "https://...",
  "easyTitle": "やさしい言葉での説明",

  "eligibility": {
    "certain": [条件配列],      // 全条件が合致すれば確実対象
    "exclude": [条件配列],      // どれか合致すれば除外
    "matchRules": [             // スコア加算ルール
      { "if": {条件}, "score": 60 }
    ],
    "baseScore": 0,
    "missingFor": ["profileKey"], // 未回答で「可能性あり」とする
    "excludeReasons": { "key": "説明" },
    "hints": {}
  },

  // 通知関連フィールド（新規追加分のみ、既存itemsには未付与）
  "notifyLevel": "high|mid|low",
  "judgmentType": "eligibility|interest",
  "interestTags": { "l1": "...", "l2": "...", "l3": "..." },
  "miniQuizKey": "hasNewborn",
  "miniQuizText": "最近、赤ちゃんが生まれましたか？🍼",
  "categoryHint": "子育て・出産",
  "notifHook": "今年も始まりました🏖️"
}
```

**⚠️ 既存の50件には `notifyLevel` / `judgmentType` / `interestTags` が未設定。**
新規追加分（admin経由）のみ持っている。

---

## ユーザープロフィールのキー一覧

localStorage / IndexedDB に `mgov_profile` として保存。

| キー | 値の例 | 説明 |
|---|---|---|
| `age` | `"30代"` | 年代 |
| `ageNum` | `35` | 年齢（数値。evalCondが参照） |
| `stage` | `"社会人（会社員）"` | ライフステージ（通知時刻決定に使用） |
| `studentLevel` | `"大学生"` | 学校種別（stageが「学生」のとき） |
| `hasKids` | `"いる（または予定あり）"` | 子供の有無 |
| `kidsAge` | `"0〜2歳"` | 子供の年齢層 |
| `housing` | `"賃貸"` | 住居形態 |
| `gps` | `"許可"` | GPS許可状況 |
| `town` | `"麻布十番"` | 地区名（28地区） |
| `coords` | `{lat,lng}` | GPS座標 |
| `festivalCoords` | `{lat,lng}` | お祭りタブ用座標 |
| `festivalTown` | `{name,lat,lng}` | お祭りタブ用地区オブジェクト |
| `interestScores` | `{"l1:子育て":0.6,...}` | いいね/申請済みから計算された興味スコア |

---

## 通知マトリクス（shouldNotify ロジック・v2.2〜）

`eligibility-engine.js` の `shouldNotify()`（`sw.js` が importScripts して push 判定に使用）。
戻り値 `action`: `"notify"`(個別通知) / `"digest"`(まとめ1通に集約) / `"none"`(出さない)。
**興味は給付(eligibility)に無関係。ホーム表示の可否はゲートせず、興味は並び順と通知のみに作用。**

| kind | 条件 | action |
|---|---|---|
| eligibility | exclude 該当 | none |
| eligibility | 確定該当（certain合致 or 実マッチ matchScore≥40 ※profileCheck の maybe 床は使わない） | notify（mid は miniQuiz、high は notifHook） |
| eligibility | 未確定（未確定 かつ 判定に必要な未回答質問 ≥3） | digest（SWが集約し「🆕 新着の給付がN件」1通でクイズ誘導） |
| eligibility | 未確定（質問 1〜2） | none（pushせずアプリ内インラインクイズ） |
| eligibility | 未確定（質問 0）/非該当 | none |
| interest | interestScore > 閾値（high>0.1 / mid>0.2 / low>0.4） | notify |
| interest | 閾値以下 | none |

- 質問数 = `countDecidingQuestions()`（missingFor 未回答 ＋ profileCheck 未回答 の重複排除）。
- 新規（プロフィール空）は現状維持で全配信（オンボーディング）。

---

## ライフステージ別通知時刻（Cloudflare Cron）

| ライフステージ | 朝 | 夜 |
|---|---|---|
| 学生 | 12:00 | 20:00 |
| 社会人（会社員） | 8:00 | 18:00 |
| 社会人（フリーランス・自営） | 10:00 | 18:00 |
| 育休・産休中 | 10:00 | 15:00 |
| 主婦・主夫 | 10:00 | 15:00 |
| 年金生活者 | 10:00 | 14:00 |
| その他・無職 | 12:00 | 18:00 |
| （未設定） | 8:00 | 18:00 |

---

## Cloudflare Worker APIエンドポイント

| メソッド | パス | 説明 | 認証 |
|---|---|---|---|
| GET | `/vapid-public-key` | VAPID公開鍵取得 | 不要 |
| POST | `/subscribe` | サブスクリプション登録（`stage`も受け取る） | 不要 |
| DELETE | `/subscribe` | 解除 | 不要 |
| POST | `/update-profile` | ライフステージ更新 | 不要 |
| POST | `/notify` | 通知キューに追加（スケジュール配信） | Bearer |
| POST | `/notify/now` | 即時全員送信（テスト用） | Bearer |
| GET | `/queue` | キュー内容確認 | Bearer |
| GET | `/subscriptions` | 登録数確認 | Bearer |
| GET | `/health` | ヘルスチェック | 不要 |

**KV構造：**
- `{endpointKey}` → PushSubscriptionData（endpoint + keys + stage）
- `notify_queue` → QueueItem[] （グローバルキュー）
- `daily:{endpointKey}` → `{date, count}` （1日の送信件数、TTL 2日）
- `sent:{endpointKey}` → string[] （送信済みキューID、TTL 7日）

---

## GitHub Actions Secrets 一覧

### minato-mygov-crawler リポジトリ
| シークレット | 用途 |
|---|---|
| `GH_PAT` | リポジトリへのpush権限 |
| `ANTHROPIC_API_KEY` | analyzer.py / pdf_extractor.py |

### minato-mygov リポジトリ
| シークレット | 用途 |
|---|---|
| `NOTIFY_SECRET` | Cloudflare Worker `/notify` の Bearer認証 |

### Cloudflare Workers（wrangler secret）
| シークレット | 用途 |
|---|---|
| `VAPID_PUBLIC_KEY` | VAPID公開鍵 |
| `VAPID_PRIVATE_KEY` | VAPID秘密鍵（32バイト生スカラー、Base64URL） |
| `NOTIFY_SECRET` | notify.ymlと一致させる |

---

## 管理画面（admin-v1.3.html）の使い方

1. ブラウザでローカルファイルとして開くか、GitHub Pagesの `/admin-v1.3.html` にアクセス
2. GitHub Personal Access Token（PAT）を入力してログイン
3. `DraftsTab`：クローラーが生成した草稿を確認
   - 「✏️ 編集して追加」→ EditTabに移動（直接公開しない設計）
4. `EditTab`：制度の全フィールドを編集
   - `NotifySection`：通知設定（notifyLevel/judgmentType/interestTags）を設定
   - 「🤖 AIで自動生成」：claude-sonnet-4-6が通知テキストを生成
5. 「保存」→ GitHub APIでitems-db.jsonを更新 → GitHub Pagesに自動デプロイ → notify.yml起動

**注意：** admin-v1.3.html は GitHub Pages の `/admin-v1.3.html` に置かれているが、
sw.js の `ADMIN_URL` は `scope + "admin/"` を参照している（不一致あり、要確認）。

---

## localStorage / IDB キー一覧

| キー | 保存先 | 内容 |
|---|---|---|
| `mgov_profile` | localStorage + IDB | ユーザープロフィール |
| `mgov_liked` | localStorage | いいね済みID配列 |
| `mgov_reminded` | localStorage | リマインド済みID配列 |
| `mgov_done` | localStorage | 申請済みID配列 |
| `mgov_hidden` | localStorage | 非表示ID配列 |
| `mgov_phase` | localStorage | `"splash"` or `"main"` |
| `mgov_last_seen_at` | localStorage | 最終確認updatedAt |
| `mgov_seen_ids` | localStorage | 確認済み制度ID配列 |
| `mgov_easy` | localStorage | やさしい言葉モード |
| `mgov_dark` | localStorage | ダークモード |
| `mgov_festival_notified` | localStorage | リマインド済みお祭りID配列 |
| `mgov_festival_radius` | localStorage | お祭り表示半径（m） |
| `mgov_festival_fireworksRadius` | localStorage | 花火表示半径（m） |
| `mgov_notif_deferred` | localStorage | 通知許可モーダル表示済みフラグ |
| `mgov_toggle_tried` | localStorage | ダークモードトグル試行フラグ |
| `profile` (IDB) | IndexedDB | SW用プロフィール（interestScores含む） |
| `ids` (IDB seen store) | IndexedDB | SW用既読ID配列 |
| `updatedAt` (IDB seen store) | IndexedDB | SW用最終確認updatedAt |

---

## 実装済み機能チェックリスト

### フロントエンド（index.html）
- [x] プロフィール設定クイズ（RevealScreen）
- [x] eligibility判定（certain/exclude/matchRules/score）
- [x] HomeTab：confidence順 → interestScore順ソート
- [x] interestScores計算（liked=1票, done=2票の割合）
- [x] judgmentType="interest" + interestScore > 0.1 で表示
- [x] 28地区 TownPickerUI + TOWN_COORDS
- [x] ダークモード（localStorage永続化）
- [x] やさしい言葉モード
- [x] DetailModal（miniQuiz・申請済み・いいね・リマインド）
- [x] NewItemsPopup（新着ポップ・miniQuiz対応）
- [x] NotifTab（通知起動・リマインド管理）
- [x] FestivalTab（お祭り・花火表示、localStorage永続化）
- [x] ProfileTab（プロフィール編集・開発テストボタン）
- [x] SW NOTIF_OPEN postMessage受信 → NotifLaunchQuiz or DetailModal
- [x] Web Push購読（subscribePush にstage送信）
- [x] profile.stage変化時にWorker KV自動更新（updatePushStage）
- [x] IDB同期（saveProfileToIDB / saveSeenToIDB）

### Service Worker（sw.js）
- [x] Push受信 → handleUserPush（プロフィール照合）
- [x] shouldNotify()（notifyLevel × judgmentType × interestScore）
- [x] 最大2件通知 / 制度ごとのtag（`minato-{id}`）
- [x] notificationclick → NOTIF_OPEN postMessage（アプリ開いてれば）
- [x] notificationclick → URL params付きopenWindow（アプリ閉じてれば）
- [x] SAVE_PROFILE / SAVE_SEEN メッセージ受信

### Cloudflare Workers（push-worker）
- [x] VAPID Web Push送信
- [x] KVサブスクリプション管理
- [x] `/subscribe` でstage保存
- [x] `/update-profile` でstage更新
- [x] `/notify` → キュー追加（即時送信なし）
- [x] `/notify/now` → 即時全員送信（テスト用）
- [x] Cron Trigger 毎時0分 → ステージ別送信時刻で配信
- [x] 1日2件キャップ + 送信済み追跡

### クローラー（minato-mygov-crawler）
- [x] RSS監視（6フィード）
- [x] 広報みなとPDF解析（claude-sonnet-4-6）
- [x] 深掘りクロール（9カテゴリ）
- [x] AI統合分析 → drafts.json
- [x] GitHub Issue自動作成（管理者通知）

### 管理画面（admin-v1.3.html）
- [x] GitHub PAT認証
- [x] DraftsTab（草稿レビュー・信頼度・要確認項目表示）
- [x] 「✏️ 編集して追加」→ EditTabへ移動（直接公開なし）
- [x] EditTab（全フィールド編集）
- [x] NotifySection（notifyLevel/judgmentType/interestTags/miniQuiz/notifHook）
- [x] l1→l2→l3 カスケード選択（interest-tags-master.jsonから）
- [x] 「🤖 AIで自動生成」ボタン（claude-sonnet-4-6）
- [x] items-db.json GitHub API書き込み

---

## ⚠️ 未実装・既知の問題・TODO

### 優先度：高
1. **既存50件に通知フィールドが未付与**
   - `notifyLevel` / `judgmentType` / `interestTags` が全既存itemsに存在しない
   - sw.js は `item.notifyLevel || "mid"` でデフォルト補完するが、interestTagsは空
   - → 管理画面で1件ずつ編集するか、一括スクリプトで補完が必要

2. **admin-v1.3.html の URL不一致**
   - sw.js の `ADMIN_URL = scope + "admin/"` だが実際のファイルは `/admin-v1.3.html`
   - admin-draft通知タップ時に正しいURLに遷移しない可能性がある

3. **`minato-mygov (7).html` の削除**
   - リポジトリルートに古いドラフトが残っている。削除してよい。

### 優先度：中
4. **interest-tags-master.json の活用**
   - マスターファイルはリポジトリに追加済みだが、ユーザーが独自タグ追加 → マスターに蓄積する仕組みが未実装（admin UIには追記したが保存ロジック未確認）

5. **notify.yml の /notify/users エンドポイント**
   - `notify.yml` は `/notify/users` に POST しているが、Workerでは `/notify` と `/notify/users` を同じ処理にしている（問題なし。念のため確認）

6. **AI生成ボタンのAPIキー**
   - NotifySection の「🤖 AIで自動生成」は `sessionStorage.getItem("anthropic_key")` を参照しているが、管理画面のセッションストレージにAnthropicキーを保存する仕組みがない
   - → ボタンを押したときにプロンプトで入力させるか、別途対応が必要

### 優先度：低
7. **Web Push の iOS対応確認**
   - web-push-browser ライブラリはApple Push Service対応を謳っているが未テスト

8. **クローラーの analyze ジョブ**
   - `needs: [rss, pdf, crawl]` だが常に `always()` で実行可能
   - workflow_dispatch で `mode: analyze` のみ実行可能（前段なしで）

---

## デプロイ手順

### メインアプリ更新
```
# items-db.json を編集（管理画面経由またはローカル編集）
git add items-db.json
git commit -m "..."
git push origin main
# → GitHub Pages自動デプロイ + notify.yml起動
```

### Cloudflare Worker更新
```
cd "F:\OneDrive\ドキュメント\Claude\Projects\行政情報一括配信アプリ\push-worker"
npm run deploy   # wrangler deploy
# ログインが切れていれば: npx wrangler login
```

### クローラー手動実行
GitHub Actions → minato-mygov-crawler → 制度情報自動収集 → Run workflow
- `mode: analyze` → 既存crawl候補をAI分析してdrafts.json生成

---

## よくあるエラー・注意事項

| 状況 | 原因・対処 |
|---|---|
| Claude APIが404 | モデル名が間違い。`claude-sonnet-4-6` を使う（`claude-sonnet-4-20250514`は存在しない） |
| git push が rejected | remote に先があるため。`git pull --rebase origin main` してから push |
| SW が古いデータを通知 | IDBの `seen` が空になっている。`loadItemsDB()` が `saveSeenToIDB` を呼んでいるか確認 |
| お祭りタブに「設定情報がありません」 | `festivalSettings` が null。プロフィール設定（初回クイズ）を完了しているか確認 |
| Workerデプロイでログインエラー | `npx wrangler login` でブラウザ認証 |
| 通知が深夜に届く | Cron実装済みのため `/notify` はキュー追加になった。即時送信は `/notify/now` |
| `admin-draft` 通知がキューに積まれる | tag判定で `admin-draft` は即時送信に分岐している（問題なし） |
