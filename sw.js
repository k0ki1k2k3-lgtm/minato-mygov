// minato-mygov Service Worker v1.4
// Web Push受信 → プロフィールと照合 → 関係あれば通知表示

const CACHE_NAME = "minato-mygov-v1.4";
const DB_NAME = "minato-mygov-db";
const DB_VERSION = 1;

// scope = "https://k0ki1k2k3-lgtm.github.io/minato-mygov/"
const APP_URL   = self.registration.scope;
const ADMIN_URL = self.registration.scope + "admin/";
const ICON      = self.registration.scope + "icon-192.png";
const BADGE     = self.registration.scope + "icon-72.png";

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
  const tag = data.tag || data.type || "";

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
  try {
    const profile    = await dbGet("profile", "current") || {};
    const seenIds    = await dbGet("seen", "ids")        || [];
    const lastSeenAt = await dbGet("seen", "updatedAt")  || "";

    if (data.updatedAt && data.updatedAt === lastSeenAt) return;

    const dbUrl = self.registration.scope + "items-db.json?" + Date.now();
    const res = await fetch(dbUrl, { cache: "no-store" });
    const db  = await res.json();
    const allItems = db.items || [];
    const allIds   = allItems.map(it => it.id);

    const newIds = allIds.filter(id => !seenIds.includes(id));
    if (newIds.length === 0) return;

    // プロフィール未設定 → 汎用通知
    if (Object.keys(profile).length === 0) {
      await self.registration.showNotification("🆕 新しい制度が追加されました", {
        body: `${newIds.length}件の新着制度があります。アプリを開いて確認してください。`,
        icon: ICON, badge: BADGE, tag: "new-items", data: { url: APP_URL },
      });
      return;
    }

    // interestScores を IDB から取得
    const interestScores = profile.interestScores || {};

    const newItems = allItems.filter(it => newIds.includes(it.id));

    // 通知マトリクスに基づいてフィルタリング
    const toNotify = [];
    for (const item of newItems) {
      const decision = shouldNotify(item, profile, interestScores);
      if (decision.notify) toNotify.push({ item, decision });
    }

    if (toNotify.length === 0) {
      await dbSet("seen", "ids",       allIds);
      await dbSet("seen", "updatedAt", data.updatedAt || "");
      return;
    }

    // 1制度ずつ通知（最大2件）
    for (const { item, decision } of toNotify.slice(0, 2)) {
      const notifTitle = item.title || item.officialName || "新しい制度";
      const notifBody  = decision.useMiniQuiz
        ? (item.miniQuizText || "詳細はアプリで確認してください")
        : (item.notifHook || item.catch || "詳細はアプリで確認してください");

      await self.registration.showNotification(notifTitle, {
        body:  notifBody,
        icon:  ICON,
        badge: BADGE,
        tag:   `minato-${item.id}`,
        data:  {
          url:          APP_URL,
          itemId:       item.id,
          notifyLevel:  item.notifyLevel  || "mid",
          miniQuizKey:  item.miniQuizKey  || "",
          miniQuizText: item.miniQuizText || "",
          categoryHint: item.categoryHint || "",
        },
      });
    }

  } catch (e) {
    await self.registration.showNotification("🆕 新しい制度が追加されました", {
      body:  data.body || "アプリを開いて確認してください",
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

// SW内で使うinterestScore計算（index.htmlのgetItemInterestScoreと同一ロジック）
function getItemInterestScoreSW(item, interestScores) {
  if (!item?.interestTags || !interestScores) return 0;
  const {l1, l2, l3} = item.interestTags;
  return (interestScores[`l1:${l1}`]||0) * 0.3
       + (interestScores[`l2:${l2}`]||0) * 0.4
       + (interestScores[`l3:${l3}`]||0) * 0.3;
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
  let score = el.baseScore || 0;
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

// ── アプリからのメッセージ受信（プロフィール・既読共有） ──
self.addEventListener("message", event => {
  const { type, profile, ids, updatedAt } = event.data || {};
  if (type === "SAVE_PROFILE" && profile) {
    dbSet("profile", "current", profile);
  }
  if (type === "SAVE_SEEN") {
    if (ids       !== undefined) dbSet("seen", "ids",       ids);
    if (updatedAt !== undefined) dbSet("seen", "updatedAt", updatedAt);
  }
});
