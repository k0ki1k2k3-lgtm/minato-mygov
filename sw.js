// minato-mygov Service Worker v1.6
// Web Push受信 → プロフィールと照合 → 関係あれば通知表示
// v1.5: 判定基準をアプリと一致(baseScore既定40)＋プッシュ重複防止を pushedIds に分離（既読レース解消）
// v1.6: skipWaiting + clients.claim で更新を即時有効化（waiting で止まらない）
// v1.7: 新着OS通知を「サーバ確定の新着id(payload.ids)」基準に変更（端末既読での握りつぶし解消）
// v1.8: GET_VERSION/SKIP_WAITING メッセージ対応（アプリで版確認・手動更新できるように）
// v1.9: 新着通知はサーバ文言を直接表示（items-db取得＋関係判定をやめ、Pages反映レース/握りつぶしを解消）
// v2.0: payload.items を同梱しSWはfetchせずローカルprofileで個人化判定（反映ラグ回避＋ターゲティング復活）

const CACHE_NAME = "minato-mygov-v2.0";
const DB_NAME = "minato-mygov-db";
const DB_VERSION = 1;

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
      const toNotify = [];
      for (const item of data.items) {
        if (!item || !item.id) continue;
        if (Array.isArray(data.ids) && pushed.includes(item.id)) continue; // 既送
        if (noProfile) { toNotify.push({ item, decision: { notify: true, useMiniQuiz: false } }); continue; }
        const decision = shouldNotify(item, profile, interestScores);
        if (decision.notify) toNotify.push({ item, decision });
      }
      if (toNotify.length === 0) { await advance(); return; } // この端末には関係なし＝正しく非表示
      for (const { item, decision } of toNotify.slice(0, 2)) {
        const t = item.title || item.officialName || "新しい制度";
        const b = decision.useMiniQuiz
          ? (item.miniQuizText || data.body || "詳細はアプリで確認してください")
          : (item.notifHook || item.catch || data.body || "詳細はアプリで確認してください");
        await self.registration.showNotification(t, {
          body: b, icon: ICON, badge: BADGE, tag: `minato-${item.id}`,
          data: { url: APP_URL, itemId: item.id, notifyLevel: item.notifyLevel || "mid",
                  miniQuizKey: item.miniQuizKey || "", miniQuizText: item.miniQuizText || "",
                  categoryHint: item.categoryHint || "" },
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
// notifyLevel: "high" | "mid" | "low"
// judgmentType: "eligibility" | "interest"
function shouldNotify(item, profile, interestScores) {
  const level        = item.notifyLevel  || "mid";
  const jType        = item.judgmentType || "eligibility";
  const interestScore = getItemInterestScoreSW(item, interestScores);

  if (jType === "eligibility") {
    const relevant = isRelevant(item, profile);
    if (!relevant) return { notify: false };
    if (level === "high") return { notify: true,  useMiniQuiz: false };
    if (level === "mid")  return { notify: true,  useMiniQuiz: true  };
    // low → 通知しない（新着ポップのみ）
    return { notify: false };
  }

  // judgmentType === "interest"
  if (level === "high") return { notify: true,  useMiniQuiz: false };
  if (level === "mid")  return { notify: true,  useMiniQuiz: true  };
  // low → 興味スコア 0.2 超のみ通知
  if (level === "low" && interestScore > 0.2) return { notify: true, useMiniQuiz: false };
  return { notify: false };
}

// SW内で使うinterestScore計算（index.htmlのgetItemInterestScoreと同一ロジック・複数タグ対応）
function getItemTagsSW(item) {
  const t = item && item.interestTags;
  if (!t) return [];
  if (Array.isArray(t)) return t.filter(x => x && (x.l1 || x.l2 || x.l3));
  return (t.l1 || t.l2 || t.l3) ? [t] : [];
}
function getItemInterestScoreSW(item, interestScores) {
  if (!interestScores) return 0;
  const tags = getItemTagsSW(item);
  if (!tags.length) return 0;
  return Math.max(...tags.map(({l1, l2, l3}) =>
    (interestScores[`l1:${l1}`]||0) * 0.3
  + (interestScores[`l2:${l2}`]||0) * 0.4
  + (interestScores[`l3:${l3}`]||0) * 0.3
  ));
}

// ── プロフィールと制度の照合 ──
function isRelevant(item, profile) {
  const el = item.eligibility;
  if (!el) return true;

  // 除外条件チェック
  if (el.exclude && el.exclude.some(c => evalCond(c, profile))) return false;

  // 確実対象
  if (el.certain && el.certain.length > 0 && el.certain.every(c => evalCond(c, profile))) return true;

  // スコアチェック（40点以上なら関係あり）
  // ※ baseScore 既定値はアプリ(index.html calcEligibilityData)と必ず一致させる(=40)。
  //   0 にすると空/低eligibilityの制度をアプリは「関係あり」と表示するのにSWは通知を
  //   握りつぶす不整合が起き、OS通知が出ない（アプリ内ポップのみ）原因になる。
  let score = (el.baseScore !== undefined) ? el.baseScore : 40;
  if (el.matchRules) {
    el.matchRules.forEach(rule => {
      if (rule["if"] && evalCond(rule["if"], profile)) score += rule.score;
    });
  }

  // missingFor がある（未回答の質問がある）→ 可能性ありとして通知
  if (el.missingFor && el.missingFor.some(k => !profile[k] || profile[k] === "")) return true;

  return score >= 40;
}

function evalCond(cond, profile) {
  const a = profile.ageNum ? Number(profile.ageNum) : null;
  for (const [key, val] of Object.entries(cond)) {
    if (key === "_always") return val === true;
    if (key === "_alwaysExclude") return val === true;
    if (key === "ageMin") { if (a === null || a < val) return false; continue; }
    if (key === "ageMax") { if (a === null || a > val) return false; continue; }
    if (key === "ageBetween") { if (a === null || a < val[0] || a >= val[1]) return false; continue; }
    const pv = profile[key];
    if (typeof val === "string") { if (pv !== val) return false; continue; }
    if (Array.isArray(val)) { if (!val.includes(pv)) return false; continue; }
    if (typeof val === "object") {
      if ("not" in val) { if (pv === val.not) return false; continue; }
      if ("notIn" in val) {
        if (val.ifSet && (!pv || pv === "")) continue;
        if (val.notIn.includes(pv)) return false; continue;
      }
    }
  }
  return true;
}

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
