#!/usr/bin/env python3
"""
金額の定期再照合

公開中の items-db.json の「金額が明示されている cash 制度」について、その金額が
公式ページ(sourceUrl)本文に今も存在するかを照合する。年度改定などで金額・締切が
変わると本文に現れなくなるため、「要再確認」候補として検出する。

性質: これは“エラー”ではなく“人が再確認すべき候補”の検出（ソフトシグナル）。
GitHub Actions から定期実行し、要再確認があれば Issue を作る運用を想定。

- savings（節約系=アプリ試算で公式に数値が無い）は対象外。
- 金額が変動制で本文に現れない制度は item に "_skipAmountRecheck": true を付けて除外可。
- 自己完結（標準ライブラリのみ・他リポジトリ非依存）。
"""
import json
import os
import re
import sys
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
ITEMS_DB = ROOT / "items-db.json"
SKIP_FILE = Path(__file__).resolve().parent / "amount-recheck-skip.json"  # id -> 除外理由
SLEEP = 0.6
MAX_CHARS = 8000


class _TextParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self._skip = 0
        self._skip_tags = {"script", "style", "noscript"}

    def handle_starttag(self, tag, attrs):
        if tag in self._skip_tags:
            self._skip += 1

    def handle_endtag(self, tag):
        if tag in self._skip_tags:
            self._skip = max(0, self._skip - 1)

    def handle_data(self, data):
        if self._skip == 0 and data.strip():
            self.parts.append(data.strip())


def fetch_text(url: str) -> str:
    if not url or re.search(r"\.(pdf|xlsx?|docx?|zip|csv|pptx)(\?|$)", url.lower()):
        return ""
    try:
        req = Request(url, headers={
            "User-Agent": "MinatoMyGovBot/2.0 (amount-recheck)",
            "Accept-Language": "ja,en;q=0.9",
        })
        with urlopen(req, timeout=25) as r:
            raw = r.read()
            ct = r.headers.get("Content-Type", "")
            enc = "utf-8"
            if "charset=" in ct:
                enc = ct.split("charset=")[-1].split(";")[0].strip()
            html = raw.decode(enc, errors="replace")
    except Exception:
        return ""
    p = _TextParser()
    try:
        p.feed(html)
    except Exception:
        pass
    return re.sub(r"\s+", " ", " ".join(p.parts))[:MAX_CHARS]


def amount_variants(n: int) -> set:
    """金額 n を本文に現れうる複数表記に展開。"""
    v = {f"{n:,}", str(n)}
    if n >= 10000:
        man = n / 10000
        v.add(f"{int(man)}万" if man == int(man) else f"{man:.1f}万")
    return v


def label_amounts(label: str) -> set:
    """potentialLabel から金額表記を抽出。「○万」は実数（例 30万→300,000）にも展開する。"""
    out = set()
    for m in re.findall(r"\d[\d,]*\.?\d*\s*万?", label or ""):
        t = m.replace(" ", "")
        if not t or t in ("0", "0万"):
            continue
        out.add(t)
        # 「○万」「○.○万」→ 円の実数表記にも展開（本文が "300,000" 等のケースを拾う）
        mm = re.match(r"^([\d,]*\.?\d+)万$", t)
        if mm:
            try:
                yen = int(float(mm.group(1).replace(",", "")) * 10000)
                out |= {f"{yen:,}", str(yen)}
            except ValueError:
                pass
    return out


def claimed_amounts(it: dict) -> set:
    out = set()
    for key in ("subsidyFixed", "potentialSubsidy"):
        n = it.get(key)
        if isinstance(n, int) and n > 0:
            out |= amount_variants(n)
    for r in (it.get("subsidyRules") or []):
        a = r.get("amount")
        if isinstance(a, int) and a > 0:
            out |= amount_variants(a)
    out |= label_amounts(it.get("potentialLabel", ""))
    return out


def main() -> int:
    db = json.loads(ITEMS_DB.read_text(encoding="utf-8"))
    items = db.get("items", db) if isinstance(db, dict) else db
    skip = {}
    if SKIP_FILE.exists():
        skip = json.loads(SKIP_FILE.read_text(encoding="utf-8"))

    targets = [it for it in items
               if it.get("subsidyType") == "cash"
               and it.get("id") not in skip
               and claimed_amounts(it)]
    print(f"💴 金額再照合: 対象 {len(targets)}件（cash・金額明示・除外リスト{len(skip)}件を除く）\n")

    stale, unavailable, ok = [], [], 0
    for it in targets:
        amts = claimed_amounts(it)
        text = fetch_text(it.get("sourceUrl", ""))
        time.sleep(SLEEP)
        if not text:
            unavailable.append(it)
            print(f"  ❓ 取得不可: {it['id']} ({it.get('sourceUrl')})")
            continue
        hit = sorted(a for a in amts if a in text)
        if hit:
            ok += 1
        else:
            stale.append((it, sorted(amts)))
            print(f"  ⚠️ 要再確認: {it['id']} | 主張額={sorted(amts)} | {it.get('potentialLabel')}")

    print(f"\n📊 一致 {ok} / 要再確認 {len(stale)} / 取得不可 {len(unavailable)}")

    # Actions 連携
    gho = os.environ.get("GITHUB_OUTPUT", "")
    if gho:
        with open(gho, "a") as f:
            f.write(f"has_stale={'true' if stale else 'false'}\n")
            f.write(f"stale_count={len(stale)}\n")
    report = ["# 💴 金額 再照合レポート", "",
              f"- 一致: {ok}件 / 要再確認: {len(stale)}件 / 取得不可: {len(unavailable)}件", ""]
    if stale:
        report += ["## ⚠️ 要再確認（公式ページ本文に主張額が見つからない）", ""]
        for it, amts in stale:
            report.append(f"- **{it.get('title')}** (`{it['id']}`) 主張額 {amts} / {it.get('potentialLabel')}\n  - {it.get('sourceUrl')}")
    if unavailable:
        report += ["", "## ❓ 取得不可（ボット遮断・PDF等。手動確認推奨）", ""]
        for it in unavailable:
            report.append(f"- {it.get('title')} (`{it['id']}`) {it.get('sourceUrl')}")
    report += ["", "※ 「要再確認」は誤りとは限りません（変動制・端数・表記差）。年度改定の追従確認に使ってください。"]
    (ROOT / "amount-recheck-report.md").write_text("\n".join(report), encoding="utf-8")
    print("\n📝 amount-recheck-report.md を出力")
    return 0  # ソフトシグナルのため常に0


if __name__ == "__main__":
    sys.exit(main())
