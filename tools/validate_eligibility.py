#!/usr/bin/env python3
"""
eligibility 語彙検証

items-db.json の eligibility 条件（certain / exclude / matchRules / profileCheck）が、
アプリ（index.html）が実際に保存するプロフィール値と一致しているかを検証する。

目的: 「disabilityGrade:"1-2"（実際は"1-2級（重度）"）」「taxStatus:"均等割のみ"
（実際は"均等割のみ課税"）」のような“文字列不一致で判定が永久に不発”するバグを
CI で自動検出し、再発を防ぐ。

許容値は index.html の定義（PROFILE_FIELDS / DETAIL_FIELD_GROUPS / UNIFIED_GROUPS /
ALL_PROFILE_QUESTIONS / BOOL_KEYS）から自動抽出するため、語彙のドリフトに強い。

異常があれば終了コード 1。
"""
import json
import re
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")  # Windowsコンソールでも絵文字/日本語を出力可に
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
INDEX_HTML = ROOT / "index.html"
ITEMS_DB = ROOT / "items-db.json"

# evalCondition が特別扱いする仮想・年齢・世帯キー（値の語彙チェック対象外）
VIRTUAL_KEYS = {
    "_always", "_alwaysExclude", "ageMin", "ageMax", "ageBetween",
    "taxExemptLikely", "householdMin", "householdMax",
    "householdChildCount", "householdChildCohabitCount", "householdElderCount",
    "householdDisabledCount", "householdIncomeCount",
    "ageNum", "birthday", "town", "household",
}


def age_min_mentions(text: str) -> set:
    """本文から「N歳以上」の N を集合で返す（内容の年齢整合チェック用）。"""
    if not text:
        return set()
    return {int(n) for n in re.findall(r"(\d+)\s*歳以上", text)}


def extract_vocab(html: str) -> dict:
    """index.html から key -> 許容“保存値”集合 を抽出する。"""
    allowed: dict[str, set] = {}

    # --- グローバル BOOL_KEYS ブロック ---
    bool_map: dict[str, dict] = {}
    m = re.search(r"const\s+BOOL_KEYS\s*=\s*\{(.*?)\n\};", html, re.S)
    if m:
        for line in m.group(1).splitlines():
            lm = re.match(r'\s*(\w+)\s*:\s*\{(.*)\}\s*,?\s*$', line)
            if lm:
                bool_map.setdefault(lm.group(1), {}).update(
                    dict(re.findall(r'"([^"]*)"\s*:\s*"([^"]*)"', lm.group(2))))

    def add(key, opts, inline_bool=None):
        mapping = {}
        mapping.update(bool_map.get(key, {}))
        if inline_bool:
            mapping.update(inline_bool)
        s = allowed.setdefault(key, set())
        for o in opts:
            s.add(mapping.get(o, o))  # boolKeys があれば保存値へ変換

    # --- フォーマットA: {key:"X", ... opts:[...] (, boolKeys:{...})?} ---
    for line in html.splitlines():
        km = re.search(r'key\s*:\s*"(\w+)"', line)
        om = re.search(r'opts\s*:\s*\[([^\]]*)\]', line)
        if km and om:
            opts = re.findall(r'"([^"]*)"', om.group(1))
            bm = re.search(r'boolKeys\s*:\s*\{([^}]*)\}', line)
            inline = dict(re.findall(r'"([^"]*)"\s*:\s*"([^"]*)"', bm.group(1))) if bm else None
            add(km.group(1), opts, inline)

    # --- フォーマットB: ALL_PROFILE_QUESTIONS の  name: {label:"...", opts:[...]} ---
    for line in html.splitlines():
        km = re.match(r'\s*(\w+)\s*:\s*\{label\s*:', line)
        om = re.search(r'opts\s*:\s*\[([^\]]*)\]', line)
        if km and om:
            opts = re.findall(r'"([^"]*)"', om.group(1))
            add(km.group(1), opts)

    return allowed


def collect_values(cond):
    """条件 dict から (key, [比較値…]) を取り出す。"""
    inner = cond.get("if", cond) if isinstance(cond, dict) else cond
    out = []
    if not isinstance(inner, dict):
        return out
    for k, v in inner.items():
        vals = []
        if isinstance(v, str):
            vals = [v]
        elif isinstance(v, list):
            vals = [x for x in v if isinstance(x, str)]
        elif isinstance(v, dict):
            if isinstance(v.get("not"), str):
                vals.append(v["not"])
            if isinstance(v.get("notIn"), list):
                vals += [x for x in v["notIn"] if isinstance(x, str)]
        out.append((k, vals))
    return out


def main() -> int:
    html = INDEX_HTML.read_text(encoding="utf-8")
    allowed = extract_vocab(html)
    db = json.loads(ITEMS_DB.read_text(encoding="utf-8"))
    items = db.get("items", db) if isinstance(db, dict) else db

    errors, warnings = [], []
    for it in items:
        iid = it.get("id", "?")
        el = it.get("eligibility") or {}
        groups = [("certain", el.get("certain") or []),
                  ("exclude", el.get("exclude") or []),
                  ("matchRules", el.get("matchRules") or [])]
        for where, arr in groups:
            for cond in arr:
                for key, vals in collect_values(cond):
                    if key in VIRTUAL_KEYS:
                        continue
                    if key not in allowed:
                        errors.append(f"{iid} [{where}] 未知のプロフィールキー: {key}")
                        continue
                    for val in vals:
                        if val not in allowed[key]:
                            errors.append(
                                f"{iid} [{where}] {key} の値「{val}」はアプリの保存値に無い"
                                f"（候補: {sorted(allowed[key])}）→ 判定が不発します")
        for pc in (el.get("profileCheck") or []):
            f = pc.get("field")
            if f and f not in allowed and f not in VIRTUAL_KEYS:
                errors.append(f"{iid} [profileCheck] 未知の field: {f}")
        # 参考: sourceUrl 欠落
        if not it.get("sourceUrl"):
            warnings.append(f"{iid}: sourceUrl が未設定")
        # 通知設定の健全性（judgmentType=eligibility）。
        #  アプリ/SW(eligibility-engine.js)は matchScore>=40 で「関係あり」＝通知。
        #  matchScore = baseScore + 合致した matchRules の加点（certain合致は確定=100）。
        #  baseScore 未指定はエンジン既定=40。管理画面は既定で 0 を書き込む点に注意。
        if it.get("judgmentType") == "eligibility":
            certain = el.get("certain") or []
            match_rules = el.get("matchRules") or []
            base = el.get("baseScore", 40)  # エンジンと同じ: 未指定なら 40
            includers = bool(certain) or bool(match_rules)
            if not includers:
                # 対象を選ぶルールが無い → 全員が matchScore=base になる
                if base >= 40:
                    warnings.append(
                        f"{iid}: 対象ルールが無く baseScore={base}（>=40）"
                        f"→ 全ユーザーに通知されます（ターゲティング無し）。意図的か確認")
                else:
                    warnings.append(
                        f"{iid}: 対象ルールが無く baseScore={base}（<40）"
                        f"→ 誰にも通知されません（対象者ゼロ）。baseScoreを40にするか対象ルールを追加")
            elif not certain:
                # matchRules はあるが、最大加点でも 40 に届かなければ誰も対象にならない
                max_score = base + sum((r.get("score") or 0) for r in match_rules)
                if max_score < 40:
                    warnings.append(
                        f"{iid}: matchRules を全て満たしても matchScore 最大 {max_score}（<40）"
                        f"→ 誰も通知対象になりません。配点か baseScore を見直し")
            # 過剰通知（koreisha型）: certain/matchRules で絞っているのに baseScore が高い/未指定
            #  → 未回答ユーザーが baseScore だけで matchScore>=40 に達し、全員に通知されてしまう。
            base_unspecified = "baseScore" not in el
            has_always = any(
                (c.get("if", c) if isinstance(c, dict) else {}).get("_always") is True
                for c in certain)
            if includers and base >= 40 and not has_always:
                if base_unspecified:
                    errors.append(
                        f"{iid}: baseScore未指定（エンジン既定=40）かつ certain/matchRules で絞り込み"
                        f"→ 未回答ユーザーが score40 で過剰通知されます。baseScore:0 を明示してください")
                else:
                    warnings.append(
                        f"{iid}: baseScore={base}（>=40）で絞り込みあり"
                        f"→ 未回答ユーザーにも通知される可能性。意図的か確認（属性ゲート給付は baseScore:0 が原則）")

        # 先行除外（freeschool型）: exclude の否定条件に ifSet:true が無いと、
        #  未回答ユーザーも除外され、通知もクイズも来ない（拾うべき未確定者を取りこぼす）。
        for cond in (el.get("exclude") or []):
            if not isinstance(cond, dict):
                continue
            for k, v in cond.items():
                if k in VIRTUAL_KEYS:
                    continue
                if isinstance(v, dict) and ("not" in v or "notIn" in v) and not v.get("ifSet"):
                    warnings.append(
                        f"{iid} [exclude] 「{k}」の否定条件に ifSet:true が無い"
                        f"→ 未回答ユーザーを先行除外（通知もクイズも来ない）。ifSet:true を付けてください")

        # 内容の年齢整合（best-effort）: body と officialBody で「N歳以上」が食い違う＝内容誤りの兆候。
        body_ages = age_min_mentions(it.get("body", ""))
        ob_ages = age_min_mentions(it.get("officialBody", ""))
        if body_ages and ob_ages and body_ages.isdisjoint(ob_ages):
            warnings.append(
                f"{iid}: body と officialBody で「N歳以上」が不一致 "
                f"(body={sorted(body_ages)} / officialBody={sorted(ob_ages)}) → 内容の年齢を要確認")

    print(f"🔎 eligibility語彙検証: {len(items)}件 / 語彙キー {len(allowed)}種")
    for w in warnings:
        print(f"  ⚠️  {w}")
    if errors:
        print(f"\n❌ 不整合 {len(errors)}件:")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("✅ すべての eligibility 条件がアプリの保存値と整合しています")
    return 0


if __name__ == "__main__":
    sys.exit(main())
