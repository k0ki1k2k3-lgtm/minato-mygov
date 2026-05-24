// minato-mygov Service Worker v1.4
// Web Push受信 → プロフィールと照合 → 関係あれば通知表示

const CACHE_NAME = "minato-mygov-v1.4";
const DB_NAME = "minato-mygov-db";
const DB_VERSION = 1;

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
    data = { type: "new_items", title: "新着情報", body: "アプリを開いて確認してください" };
  }

  if (data.type === "new_drafts") {
    // 管理者向け通知
    await self.registration.showNotification("📥 新しい草稿が届きました", {
      body: `${data.count || "複数"}件の新制度候補があります`,
      icon: "/icon-192.png",
      badge: "/icon-72.png",
      tag: "admin-draft",
      data: { url: "/admin/" },
    });
    return;
  }

  if (data.type === "new_items") {
    // ユーザー向け：プロフィールと照合
    await handleUserPush(data);
  }
}

async function handleUserPush(data) {
  try {
    // プロフィール取得
    const profile = await dbGet("profile", "current") || {};
    const seenIds = await dbGet("seen", "ids") || [];
    const lastSeenAt = await dbGet("seen", "updatedAt") || "";

    // 新着がない場合はスキップ
    if (data.updatedAt && data.updatedAt === lastSeenAt) return;

    // items-db.jsonを取得
    // SW scopeからitems-db.jsonのパスを解決
    const dbUrl = self.registration.scope + "items-db.json?" + Date.now();
    const res = await fetch(dbUrl);
    const db = await res.json();
    const allItems = db.items || [];
    const allIds = allItems.map(it => it.id);

    // 新着IDを特定
    const newIds = allIds.filter(id => !seenIds.includes(id));
    if (newIds.length === 0) return;

    // プロフィールが未入力の場合は全員に通知
    if (Object.keys(profile).length === 0) {
      await self.registration.showNotification("🆕 新しい制度が追加されました", {
        body: `${newIds.length}件の新着制度があります。アプリを開いて確認してください。`,
        icon: "/icon-192.png",
        badge: "/icon-72.png",
        tag: "new-items",
        data: { url: "/" },
      });
      return;
    }

    // プロフィールと照合して関係ある制度を絞り込む
    const newItems = allItems.filter(it => newIds.includes(it.id));
    const relevantItems = newItems.filter(item => isRelevant(item, profile));

    if (relevantItems.length === 0) {
      // 関係ない → 通知しないが既読として記録
      await dbSet("seen", "ids", allIds);
      await dbSet("seen", "updatedAt", data.updatedAt || "");
      return;
    }

    // 関係ある制度がある → 通知表示
    const title = relevantItems.length === 1
      ? `🆕 ${relevantItems[0].title}`
      : `🆕 あなたに関係する新制度が${relevantItems.length}件`;

    const body = relevantItems.length === 1
      ? relevantItems[0].catch || "アプリを開いて詳細を確認してください"
      : relevantItems.map(it => it.title).join("、");

    await self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/icon-72.png",
      tag: "new-items",
      data: { url: "/" },
    });

  } catch (e) {
    // エラー時はシンプルな通知
    await self.registration.showNotification("🆕 新しい制度が追加されました", {
      body: "アプリを開いて確認してください",
      icon: "/icon-192.png",
      tag: "new-items",
      data: { url: "/" },
    });
  }
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

  // missingForがある（未回答の質問がある）→ 可能性ありとして通知
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

// ── 通知タップ → アプリを開く ──
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});

// ── アプリからのメッセージ受信（プロフィール保存） ──
self.addEventListener("message", event => {
  if (event.data?.type === "SAVE_PROFILE") {
    dbSet("profile", "current", event.data.profile);
  }
  if (event.data?.type === "SAVE_SEEN") {
    dbSet("seen", "ids", event.data.ids);
    dbSet("seen", "updatedAt", event.data.updatedAt);
  }
});
