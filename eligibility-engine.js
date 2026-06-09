// minato-mygov 判定エンジン（共有モジュール）
// ─────────────────────────────────────────────────────────────
// アプリ本体(index.html)とService Worker(sw.js)が「制度がユーザーに関係あるか」を
// 判定するためのロジックを単一ファイルに集約したもの。以前は両者に別実装があり、
// SW側がアプリ側より簡略で、誕生日→年齢/世帯仮想キー/配列プロフィール/taxExemptLikely
// 等を取りこぼし、OS通知の対象選別がアプリ画面の判定と食い違っていた。
//
// このファイルは plain classic JS（JSX/DOM/window 依存なし）。
//   - index.html : <script src="eligibility-engine.js"></script> で読み込み（globalに乗る）
//   - sw.js      : importScripts("eligibility-engine.js") で読み込み（self global に乗る）
// どちらの環境でも同一コードで判定するため、二度と乖離しない。
// ※ 変更時は両環境（ブラウザ／Service Worker）で動くこと（DOM非依存）を必ず保つこと。

// ── 中間状態（申請中・購入予定など）。確定判定の対象外にする値 ──
const INTERIM_VALUES = ["申請中","購入予定","購入予定（軽自動車）","購入予定（普通車）","購入予定（EV）","飼育予定"];

// ── 誕生日(YYYY-MM-DD)/生まれ年月(YYYY-MM)から年齢を算出 ──
function ageFromBirthday(bd){
  if(!bd) return null;
  const [y,m,d] = String(bd).split("-").map(Number);
  if(!y) return null;
  const n=new Date(); let a=n.getFullYear()-y;
  const cm=n.getMonth()+1, cd=n.getDate();
  if(m){ if(cm<m || (cm===m && d && cd<d)) a--; }
  return a<0?null:a;
}

// ── 世帯人数（本人＋同居者） ──
function householdSize(profile){
  if(!Array.isArray(profile.household) || profile.household.length===0) return 1;
  return profile.household.filter(m=>m.isSelf||m.cohabit).length || 1;
}

// ── 住民税非課税の近似判定（全国共通の式・35万/人ベース） ──
function isLikelyTaxExempt(profile){
  // taxStatus を直接申告していればそれを最優先（確定）
  if(profile.taxStatus==="非課税") return true;
  if(profile.taxStatus==="課税世帯") return false;
  // 年収区分（新9段階）→ 給与年収のおおよその上限(万円)
  const incomeTop = {
    "100万円未満":99,"100〜150万円":150,"150〜250万円":250,"250〜350万円":350,
    "350〜450万円":450,"450〜600万円":600,"600〜800万円":800,"800〜1000万円":1000,"1000万円以上":1200,
    // 旧区分フォールバック
    "～200万円":200,"200～400万円":400,"400～600万円":600,"600～800万円":800,"800万円～":1000,
  }[profile.income];
  if(incomeTop===undefined) return false;
  const size = householdSize(profile);
  const threshold = 110 + (size-1)*50; // 単身110万・1人増ごと+50万
  return incomeTop <= threshold;
}

// ── 値が中間状態か ──
function isInterim(pv){
  const arr = Array.isArray(pv) ? pv : [pv];
  return arr.some(v => INTERIM_VALUES.includes(v));
}

// ── 世帯構成から属性別人数を集計する仮想キー ──
function calcHouseholdStats(profile){
  const hh = Array.isArray(profile.household) ? profile.household : [];
  const cohabit = hh.filter(m=>m.isSelf||m.cohabit);
  // 子どもの人数（同居・別居問わず。rel=child で登録されている人）
  const childCount = hh.filter(m=>m.rel==="child").length;
  // 同居している子どもの人数
  const childCohabitCount = cohabit.filter(m=>m.rel==="child").length;
  // 同居の高齢者（65歳以上）
  const elderCount = cohabit.filter(m=>{ const a=ageFromBirthday(`${m.birthYear}-${m.birthMonth||1}`); return a!==null&&a>=65; }).length;
  // 障害がある同居メンバーの人数
  const disabledCount = cohabit.filter(m=>m.disability&&m.disability!=="なし"&&m.disability!=="").length;
  // 収入がある同居メンバーの人数（本人含む・収入なし以外）
  const incomeCount = cohabit.filter(m=>m.work&&m.work!=="収入なし").length;
  return { childCount, childCohabitCount, elderCount, disabledCount, incomeCount };
}

// 数値比較ヘルパー（{ gte:2 } / { lte:1 } / { eq:0 } / 数値直接指定）
function matchCount(actual, expected){
  if(typeof expected === "number") return actual === expected;
  if(typeof expected === "object"){
    if("gte" in expected && actual < expected.gte) return false;
    if("lte" in expected && actual > expected.lte) return false;
    if("gt"  in expected && actual <= expected.gt)  return false;
    if("lt"  in expected && actual >= expected.lt)  return false;
    if("eq"  in expected && actual !== expected.eq)  return false;
  }
  return true;
}

// ── データ駆動型条件評価 ──────────────────────────────────
function evalCondition(cond, profile) {
  // 年齢は birthday があれば自動算出を優先
  const autoAge = ageFromBirthday(profile.birthday);
  const a = (autoAge!==null) ? autoAge : (profile.ageNum ? Number(profile.ageNum) : null);
  // 世帯構成集計（毎回計算するが軽い）
  const hhStats = calcHouseholdStats(profile);
  for (const [key, val] of Object.entries(cond)) {
    // 特殊キー
    if (key === "_always") return val === true;
    if (key === "_alwaysExclude") return val === true;
    if (key === "ageMin") { if (a === null || a < val) return false; continue; }
    if (key === "ageMax") { if (a === null || a > val) return false; continue; }
    if (key === "ageBetween") { if (a === null || a < val[0] || a >= val[1]) return false; continue; }
    // 仮想条件：住民税非課税の見込み
    if (key === "taxExemptLikely") { if (isLikelyTaxExempt(profile) !== (val===true)) return false; continue; }
    // 仮想条件：世帯人数
    if (key === "householdMin") { if (householdSize(profile) < val) return false; continue; }
    if (key === "householdMax") { if (householdSize(profile) > val) return false; continue; }
    // 仮想条件：世帯構成集計キー
    if (key === "householdChildCount")        { if (!matchCount(hhStats.childCount, val))        return false; continue; }
    if (key === "householdChildCohabitCount") { if (!matchCount(hhStats.childCohabitCount, val)) return false; continue; }
    if (key === "householdElderCount")        { if (!matchCount(hhStats.elderCount, val))        return false; continue; }
    if (key === "householdDisabledCount")     { if (!matchCount(hhStats.disabledCount, val))     return false; continue; }
    if (key === "householdIncomeCount")       { if (!matchCount(hhStats.incomeCount, val))       return false; continue; }
    // 通常キー（配列値にも対応）
    const pv = profile[key];
    const pvArr = (pv===null||pv===undefined) ? [] : (Array.isArray(pv) ? pv : [pv]);
    if (val === null || val === undefined) { if (pvArr.length>0) return false; continue; }
    if (typeof val === "string") { if (!pvArr.includes(val)) return false; continue; }
    if (Array.isArray(val)) { if (!val.some(v=>pvArr.includes(v))) return false; continue; }
    if (typeof val === "object") {
      if ("not" in val) { if (pvArr.includes(val.not)) return false; continue; }
      if ("notIn" in val) {
        if (val.ifSet && pvArr.length===0) continue; // 未設定なら無視
        if (val.notIn.some(v=>pvArr.includes(v))) return false; continue;
      }
    }
  }
  return true;
}

function evalCondArray(condArray, profile, mode = "and") {
  if (!condArray || condArray.length === 0) return mode === "and" ? true : false;
  if (mode === "and") return condArray.every(c => evalCondition(c, profile));
  if (mode === "or")  return condArray.some(c  => evalCondition(c, profile));
  return false;
}

// ── profileCheck（対象確認ミニ質問）の判定 ──────────────────
// フィールドごとの再質問間隔（日）。回答が古くなったら再度確認する
const PROFILE_RECHECK_DAYS = {
  vehicleType:730, housingDetail:730, housingLoan:730, housing:730,
  disabilityType:1825, nationalityStatus:1825,
  leaveStatus:365, petType:365, taxStatus:365, childcareStatus:365,
  pregnancyStatus:90, hasMynumber:180,
};
// その field を（再）質問すべきか：未回答→true / 回答済み記録なし→false / 記録が古い→true
function shouldAsk(field, profile){
  const v = profile[field];
  const answered = !(v===undefined || v===null || v==="");
  if(!answered) return true;
  const at = profile.profileAnsweredAt && profile.profileAnsweredAt[field];
  if(!at) return false;
  return Date.now()-at > (PROFILE_RECHECK_DAYS[field] ?? 365)*86400000;
}
// 回答済みの profileCheck をマッチ評価： true / false / "interim" / null(未回答あり)
function evaluateProfileCheckMatch(pcList, profile){
  if(!pcList || !pcList.length) return null;
  const results = pcList.map(check=>{
    const saved = profile[check.field];
    if(saved===undefined || saved===null || saved==="") return null; // 未回答
    const values = Array.isArray(saved) ? saved : [saved];
    if(values.some(v=>INTERIM_VALUES.includes(v))) return "interim";
    const match = check.match || [];
    if(check.type==="yesno" && match.length===0) return saved==="true" || saved===true;
    return match.some(m=>values.includes(m));
  });
  if(results.some(r=>r===null)) return null;
  if(results.some(r=>r==="interim")) return "interim";
  return results.every(r=>r===true);
}
// profileCheck の総合ステータス： skip / certain / excluded / maybe / maybe_forced / needs_quiz
function checkProfileQuiz(el, profile){
  const pc = (el && el.profileCheck) || [];
  if(!pc.length) return {status:"skip"};
  if(pc.length>=3) return {status:"maybe_forced"}; // 3問以上は確定させず「関係あるかも」固定
  const missing = pc.filter(c => shouldAsk(c.field, profile));
  if(missing.length===0){
    const r = evaluateProfileCheckMatch(pc, profile);
    if(r==="interim" || r===null) return {status:"maybe"};
    return {status: r ? "certain" : "excluded"};
  }
  return {status:"needs_quiz", questions:missing};
}

// ── 制度判定 ──────────────────────────────────────────────
function calcEligibilityData(profile, el) {
  if (!el) return { certain: false, matchScore: 0, missing: [] };
  // exclude チェック（1つでもtrueなら非表示）
  if (el.exclude && el.exclude.some(c => evalCondition(c, profile)))
    return { certain: false, matchScore: 0, missing: [] };

  // profileCheck（対象確認ミニ質問）による判定
  const pq = checkProfileQuiz(el, profile);
  // profileCheck で対象外が確定 → 非表示
  if (pq.status === "excluded")
    return { certain: false, matchScore: 0, missing: [] };
  // profileCheck の未回答質問はキーとして missing に合流させ、クイズで聞く
  const pcMissing = pq.status === "needs_quiz" ? pq.questions.map(q => q.field) : [];
  // profileCheck が無い(skip) か、回答が一致(certain)した場合のみ「確定」を許可
  const pcOK = pq.status === "skip" || pq.status === "certain";

  // certain チェック（全条件AND）
  const certainMatch = !!(el.certain && el.certain.length > 0 && evalCondArray(el.certain, profile, "and"));
  if (certainMatch && pcOK && pcMissing.length === 0) {
    // certain条件が参照するキーが「中間状態（申請中・購入予定）」なら確定させず保留
    const refsInterim = (el.certain||[]).some(cond =>
      Object.keys(cond).some(k => isInterim(profile[k]))
    );
    if (refsInterim) {
      // 中間状態 → 「関係あるかも」（やや高めのスコア）
      return { certain: false, matchScore: 60, missing: [], interim: true };
    }
    return { certain: true, matchScore: 100, missing: [] };
  }
  // missing キー検出（missingFor ＋ profileCheck 未回答を統合）
  const baseMissing = (el.missingFor || []).filter(k => !profile[k] || profile[k] === "");
  const missing = Array.from(new Set([...baseMissing, ...pcMissing]));
  // スコア計算
  let score = el.baseScore !== undefined ? el.baseScore : 40;
  if (el.matchRules) {
    el.matchRules.forEach(rule => {
      if (rule["if"] && evalCondition(rule["if"], profile)) score += rule.score;
    });
  }
  // profileCheck が3問以上 or 中間状態などで保留(maybe) のときは最低限のスコアを確保
  if (pq.status === "maybe_forced" || pq.status === "maybe")
    score = Math.max(score, 50);
  return { certain: false, matchScore: Math.min(score, 95), missing };
}

// ── 興味タグ・スコア ──────────────────────────────────────
function getItemTags(item) {
  const t = item && item.interestTags;
  if (!t) return [];
  if (Array.isArray(t)) return t.filter(x => x && (x.l1 || x.l2 || x.l3));
  return (t.l1 || t.l2 || t.l3) ? [t] : [];
}

// 制度の興味スコア（複数タグなら最も高いタグのスコアを採用）
function getItemInterestScore(item, interestScores) {
  if (!interestScores) return 0;
  const tags = getItemTags(item);
  if (!tags.length) return 0;
  return Math.max(...tags.map(({l1, l2, l3}) =>
    (interestScores[`l1:${l1}`]||0) * 0.3
  + (interestScores[`l2:${l2}`]||0) * 0.4
  + (interestScores[`l3:${l3}`]||0) * 0.3
  ));
}

// ── 通知の対象選別（SW/アプリ共通） ──────────────────────────
// 制度がこのユーザーに「関係あるか」。calcEligibilityData ベースに統一することで、
// exclude / profileCheck / 仮想キー / 配列値 / 誕生日→年齢 を自動的に正しく評価する。
function isRelevant(item, profile) {
  const el = item.eligibility;
  if (!el) return true;
  const r = calcEligibilityData(profile, el);
  return r.certain || r.matchScore >= 40;
}

// ── 通知マトリクス判定 ──────────────────────────────────────
// notifyLevel: "high" | "mid" | "low"
// judgmentType: "eligibility" | "interest"
function shouldNotify(item, profile, interestScores) {
  const level        = item.notifyLevel  || "mid";
  const jType        = item.judgmentType || "eligibility";
  const interestScore = getItemInterestScore(item, interestScores);

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
