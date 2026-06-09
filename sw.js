// minato-mygov Service Worker v1.6
// Web Push受信 → プロフィールと照合 → 関係あれば通知表示
// v1.5: 判定基準をアプリと一致(baseScore既定40)＋プッシュ重複防止を pushedIds に分離（既読レース解消）
// v1.6: skipWaiting + clients.claim で更新を即時有効化（waiting で止まらない）
// v1.7: 新着OS通知を「サーバ確定の新着id(payload.ids)」基準に変更（端末既読での握りつぶし解消）
// v1.8: GET_VERSION/SKIP_WAITING メッセージ対応（アプリで版確認・手動更新できるように）
// v1.9: 新着通知はサーバ文言を直接表示（items-db取得＋関係判定をやめ、Pages反映レース/握りつぶしを解消）
// v2.0: payload.items を同梱しSWはfetchせずローカルprofileで個人化判定（反映ラグ回避＋ターゲティング復活）
// v2.1: 判定ロジックを eligibility-engine.js に一本化（importScripts）。アプリ(index.html)と
//        同一コードで shouldNotify/isRelevant/calcEligibilityData を実行＝通知選別とアプリ表示の
//        乖離（誕生日→年齢・世帯仮想キー・配列プロフィール・taxExemptLikely の取りこぼし）を根絶。
// v2.2: shouldNotify を action型({notify|digest|none})に。給付=対象者へ(興味無関係)・確定該当は
//        個別通知／未確定(質問3問以上)はまとめ1通(digest)でクイズ誘導／1〜2問はpushせずアプリ内。
//        イベント(interest)は興味スコア>閾値(high0.1/mid0.2/low0.4)のみ通知。

const CACHE_NAME = "minato-mygov-v2.2";
const DB_NAME = "minato-mygov-db";
const DB_VERSION = 1;

// 判定エンジン（アプリ index.html と共有する単一実装）。同階層に配置。
importScripts("eligibility-engine.js");

// scope = "https://k0ki1k2k3-lgtm.github.io/minato-mygov/"
const APP_URL   = self.registration.scope;
const ADMIN_URL = self.registration.scope + "admin-v1.3.html";
const ICON      = self.registration.scope + "icon-192.png";
const BADGE     = self.registration.scope + "icon-72.png";

// ── 即時有効化（更新が「待機」で止まらないように）──
// これが無いと新SWはwaitingのままで、iOSではアプリを完全終了するまで切り替わらない。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

// ── IndexedDB操作ヘルパー ──
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("profile")) {
        db.createObjectStore("profile", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("seen")) {
        db.createObjectStore("seen", { keyPath: "key" });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function dbGet(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = e => resolve(e.target.result?.value);
    req.onerror = e => reject(e.target.error);
  });
}

async function dbSet(storeName, key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

// ── Push受信 ──
self.addEventListener("push", event => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    // ペイロードがJSONでない場合は新着制度通知として扱う
    data = { title: event.data ? event.data.text() : "新着情報" };
  }

  // tag または type で振り分け（Worker は tag を送る、旧コードとの互換で type も見る）
  const tag  = data.tag || data.type || "";
  const type = data.type || "";

  // 再確認・季節・テスト通知：ペイロードをそのまま表示（新着差分ロジックを通さない）
  if (type === "RECHECK" || type === "SEASONAL" || type === "TEST") {
    await self.registration.showNotification(data.title || "港区からのお知らせ", {
      body:  data.body || "",
      icon:  ICON,
      badge: BADGE,
      tag:   data.tag || type,
      data:  { url: APP_URL, type, field: data.field || "", value: data.value || "" },
    });
    return;
  }

  // 管理者向け通知（admin-draft / new_drafts 両対応）
  if (tag === "admin-draft" || tag === "new_drafts") {
    await self.registration.showNotification(
      data.title || "📥 新しい草稿が届きました",
      {
        body:  data.body || `${data.count || "複数"}件の新制度候補があります`,
        icon:  ICON,
        badge: BADGE,
        tag:   "admin-draft",
        data:  { url: ADMIN_URL },
      }
    );
    return;
  }

  // ユーザー向け：プロフィールと照合して通知
  await handleUserPush(data);
}

async function handleUserPush(data) {
  // 方針(v2.0): notify.yml が payload.items に「新着アイテム本体（判定/表示に必要な分）」を
  // 同梱する。SWは items-db.json を取りに行かず、端末内 profile だけで関係/興味判定して表示。
  //  → GitHub Pages 反映ラグの影響を受けず（取得しない）、かつ個人化(ターゲティング)を維持。
  //  → 重複防止は pushedIds（push実績でのみ前進）。data.items 無し時はサーバ文言を直接表示。
  try {
    const pushed = (await dbGet("seen", "pushedIds")) || [];

    // 重複防止ゲート
    if (Array.isArray(data.ids)) {
      if (data.ids.filter(id => !pushed.includes(id)).length === 0) return; // 通知済み/編集のみ
    } else {
      const lastAt = await dbGet("seen", "lastPushAt");
      if (data.updatedAt && data.updatedAt === lastAt) return;
    }
    const advance = async () => {
      if (Array.isArray(data.ids)) {
        await dbSet("seen", "pushedIds", Array.from(new Set([...pushed, ...data.ids])));
      }
      if (data.updatedAt) await dbSet("seen", "lastPushAt", data.updatedAt);
    };

    // ── 個人化経路：payload.items をローカル profile で判定（fetchしない）──
    if (Array.isArray(data.items) && data.items.length) {
      const profile = await dbGet("profile", "current") || {};
      const noProfile = Object.keys(profile).length === 0;
      const interestScores = profile.interestScores || {};
      // action 別に振り分け（notify=個別 / digest=まとめ1通 / none=出さない）
      const toNotify = [];     // 確定該当の給付・興味十分なイベント → 個別通知
      const digestItems = [];  // 未確定(質問3問以上)の給付 → まとめ1通
      for (const item of data.items) {
        if (!item || !item.id) continue;
        if (Array.isArray(data.ids) && pushed.includes(item.id)) continue; // 既送
        if (noProfile) { toNotify.push({ item, useMiniQuiz: false }); continue; } // 新規は全配信(現状維持)
        const d = shouldNotify(item, profile, interestScores);
        if (d.action === "notify") toNotify.push({ item, useMiniQuiz: !!d.useMiniQuiz });
        else if (d.action === "digest") digestItems.push(item);
        // none → 何もしない
      }
      if (toNotify.length === 0 && digestItems.length === 0) { await advance(); return; }
      // 個別通知（確定該当・興味イベント）。1回あたり最大2件。
      for (const { item, useMiniQuiz } of toNotify.slice(0, 2)) {
        const t = item.title || item.officialName || "新しい制度";
        const b = useMiniQuiz
          ? (item.miniQuizText || data.body || "詳細はアプリで確認してください")
          : (item.notifHook || item.catch || data.body || "詳細はアプリで確認してください");
        await self.registration.showNotification(t, {
          body: b, icon: ICON, badge: BADGE, tag: `minato-${item.id}`,
          data: { url: APP_URL, itemId: item.id, notifyLevel: item.notifyLevel || "mid",
                  miniQuizKey: item.miniQuizKey || "", miniQuizText: item.miniQuizText || "",
                  categoryHint: item.categoryHint || "" },
        });
      }
      // 未確定給付（要・複数質問）はまとめて1通でクイズへ誘導
      if (digestItems.length > 0) {
        const ids = digestItems.map(i => i.id);
        await self.registration.showNotification(`🆕 新着の給付が${digestItems.length}件あります`, {
          body: "あてはまるか、かんたんな質問で確認しましょう",
          icon: ICON, badge: BADGE, tag: "minato-digest",
          data: { url: `${APP_URL}?notif_digest=1`, digest: true, ids },
        });
      }
      await advance();
      return;
    }

    // ── フォールバック：items 無し（4KB超で省略 等）→ サーバ文言を直接表示 ──
    const fresh = Array.isArray(data.ids) ? data.ids.filter(id => !pushed.includes(id)) : [];
    const single = fresh.length === 1 ? fresh[0] : "";
    await self.registration.showNotification(data.title || "🆕 新しい制度が追加されました", {
      body: data.body || "アプリで新着を確認してください",
      icon: ICON, badge: BADGE, tag: single ? `minato-${single}` : "new-items",
      data: { url: APP_URL, itemId: single },
    });
    await advance();
  } catch (e) {
    await self.registration.showNotification("🆕 新しい制度が追加されました", {
      body:  data.body || "アプリで新着を確認してください",
      icon:  ICON, badge: BADGE, tag: "new-items", data: { url: APP_URL },
    });
  }
}

// ── 通知マトリクス判定 ──────────────────────────────────────
// shouldNotify / isRelevant / calcEligibilityData / evalCondition などの判定関数は
// eligibility-engine.js（importScripts 済み）に集約。アプリ index.html と同一コードを共有する
// ため、通知の対象選別とアプリ画面の「関係あり」表示が必ず一致する。

// ── 通知タップ → アプリを開く + NOTIF_OPEN postMessage ──
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const data = event.notification.data || {};
  const { itemId, notifyLevel, miniQuizKey, miniQuizText, categoryHint, url } = data;
  const openUrl = itemId
    ? `${APP_URL}?notif_item=${encodeURIComponent(itemId)}&notif_level=${encodeURIComponent(notifyLevel || "mid")}`
    : (url || APP_URL);

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
      const existing = clientList.find(c => c.url.startsWith(APP_URL));
      if (existing) {
        existing.focus();
        // アプリが開いていれば postMessage で直接制度を開かせる
        if (itemId) {
          existing.postMessage({
            type:         "NOTIF_OPEN",
            itemId,
            notifyLevel:  notifyLevel  || "mid",
            miniQuizKey:  miniQuizKey  || "",
            miniQuizText: miniQuizText || "",
            categoryHint: categoryHint || "",
          });
        }
        return existing;
      }
      // アプリが閉じていれば URL パラメーター付きで開く
      return clients.openWindow(openUrl);
    })
  );
});

// ── アプリからのメッセージ受信（プロフィール・既読共有・版確認・更新）──
self.addEventListener("message", event => {
  const { type, profile, ids, updatedAt } = event.data || {};
  if (type === "SAVE_PROFILE" && profile) {
    dbSet("profile", "current", profile);
  }
  if (type === "SAVE_SEEN") {
    if (ids       !== undefined) dbSet("seen", "ids",       ids);
    if (updatedAt !== undefined) dbSet("seen", "updatedAt", updatedAt);
  }
  if (type === "GET_VERSION") {
    // MessageChannel で版を返す（アプリが現在のSW版を表示できるように）
    event.ports?.[0]?.postMessage({ version: CACHE_NAME });
  }
  if (type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
