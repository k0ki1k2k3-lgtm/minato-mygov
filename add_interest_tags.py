"""
既存50件の items-db.json に interestTags (l1/l2) を一括付与するスクリプト。
実行: py -3 add_interest_tags.py
環境変数 ANTHROPIC_API_KEY が必要。
"""
import json, os, re, sys, urllib.request, time
from pathlib import Path

CLAUDE_MODEL = "claude-sonnet-4-6"
API_URL = "https://api.anthropic.com/v1/messages"
DB_PATH = Path(__file__).parent / "items-db.json"
BATCH_SIZE = 10

INTEREST_TAGS_TREE = """
お金・給付金         : 給付・手当 / 補助・助成 / お得・節約 / 金融支援
子育て・教育         : 妊娠・出産 / 乳幼児・保育 / 学齢期 / 高等教育 / 子育て支援
健康・医療           : 予防・検診 / 医療費・助成 / こころの健康 / 介護・リハビリ / 身体障害 / 知的障害 / 精神障害 / 難病 / 性別・ライフステージ別 / 歯科・口腔
住まい・生活         : 一戸建て / マンション・アパート / 住宅購入・ローン / 引越し・移住 / 生活費支援 / 生活インフラ
仕事・キャリア       : 正規雇用 / 非正規雇用 / 自営業・フリーランス / 農業・漁業・林業 / スキルアップ / 労働環境・権利 / 多様な働き方
レジャー・趣味       : 文化・芸術 / 学習・知識 / 旅行・お出かけ / アウトドア / ものづくり・趣味 / グルメ・食 / デジタル・エンタメ / 乗り物 / ライフスタイル
スポーツ・フィットネス: 球技 / ラケット競技 / 水泳・マリンスポーツ / 山・自然 / 格闘技・武道 / 陸上・ランニング / ウィンタースポーツ / フィットネス / ゴルフ / eスポーツ / 施設利用
交通・移動           : 自動車 / バイク・原付 / 自転車 / 小型モビリティ / 公共交通 / 移動支援 / 道路・インフラ
環境・防災           : 防災・災害対策 / 防犯・安全 / 再生可能エネルギー / 省エネ・節電 / カーボン・気候変動 / 自然環境保護 / 廃棄物・リサイクル / 食の安全
多文化・国際支援     : 永住者・定住者 / 技能実習・特定技能 / 留学生 / 配偶者・家族滞在 / 難民・人道支援 / 生活支援 / 教育・言語 / 文化・交流 / 海外関連
ペット               : 犬 / 猫 / 特定動物 / 鳥 / 小動物 / 魚・水生生物 / ペットの健康・医療 / ペットと暮らし / ペットの保護・権利 / ペットのケア・看取り
法律・権利支援       : 法律相談・手続き / 家族・相続 / 被害・トラブル / 人権・権利 / 知的財産・情報 / 医療・労働の権利
市民参加・ボランティア: 地域活動 / ボランティア / 社会参加 / 支援・寄付 / NPO・社会起業 / 子ども・青少年
"""


def call_claude(api_key: str, prompt: str) -> str:
    payload = json.dumps({
        "model": CLAUDE_MODEL,
        "max_tokens": 2000,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")
    req = urllib.request.Request(
        API_URL, data=payload,
        headers={"Content-Type": "application/json", "x-api-key": api_key,
                 "anthropic-version": "2023-06-01"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())["content"][0]["text"]


def parse_json(text: str) -> list:
    text = text.strip()
    try:
        start = text.index("["); end = text.rindex("]") + 1
        return json.loads(text[start:end])
    except Exception:
        return []


def assign_tags_batch(api_key: str, items: list) -> dict:
    """items のリストに対して interestTags を付与し {id: [tags]} を返す"""
    slim = [{"id": it["id"], "title": it.get("title",""),
             "officialName": it.get("officialName",""),
             "tag": it.get("tag",""), "body": it.get("body","")} for it in items]
    prompt = f"""以下の行政制度リストに interestTags を付与してください。

【interestTagsツリー（l1 → 利用可能なl2）】
{INTEREST_TAGS_TREE}

ルール:
- 制度に関係する l1・l2 タグをすべて配列で設定する（複数可）
- l1・l2 は必ずツリーの値から選ぶ（自由記述不可）
- l3 は付けない

制度リスト:
{json.dumps(slim, ensure_ascii=False, indent=2)}

出力形式（JSONのみ・前後のテキスト不要）:
[
  {{"id": "制度id", "interestTags": [{{"l1":"...", "l2":"..."}}]}},
  ...
]"""
    text = call_claude(api_key, prompt)
    results = parse_json(text)
    return {r["id"]: r["interestTags"] for r in results if "id" in r and "interestTags" in r}


def main():
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        api_key = input("ANTHROPIC_API_KEY: ").strip()
    if not api_key:
        print("APIキーが必要です"); sys.exit(1)

    db = json.loads(DB_PATH.read_text(encoding="utf-8"))
    items = db["items"]

    targets = [it for it in items if not it.get("interestTags")]
    print(f"対象: {len(targets)}件 / 全{len(items)}件")

    updated = 0
    for i in range(0, len(targets), BATCH_SIZE):
        batch = targets[i:i + BATCH_SIZE]
        ids = [it["id"] for it in batch]
        print(f"  バッチ {i//BATCH_SIZE + 1}: {ids}")
        try:
            tag_map = assign_tags_batch(api_key, batch)
            for item in items:
                if item["id"] in tag_map:
                    item["interestTags"] = tag_map[item["id"]]
                    updated += 1
                    print(f"    ✅ {item['id']}: {item['interestTags']}")
        except Exception as e:
            print(f"    ❌ バッチ失敗: {e}")
        if i + BATCH_SIZE < len(targets):
            time.sleep(1)

    db["items"] = items
    DB_PATH.write_text(json.dumps(db, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n完了: {updated}件更新 → items-db.json に保存しました")


if __name__ == "__main__":
    main()
