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
        # 通知設定の健全性: judgmentType=eligibility なのに eligibility が空
        #  → 誰にもターゲティングされず（baseScore既定=40で）全員に通知される。意図確認用。
        if it.get("judgmentType") == "eligibility":
            has_rules = any((el.get(k) for k in ("certain", "exclude", "matchRules", "missingFor")))
            if not has_rules:
                warnings.append(
                    f"{iid}: judgmentType=eligibility だが eligibility が空 "
                    f"→ 全ユーザーに通知されます（ターゲティング無し）。意図的か確認")

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
