"""
06_export_static_data.py

PostgreSQL から UI 用マスターデータを取得し、静的 JSON ファイルとして書き出す。
現在エクスポートするデータ:
  - hall_of_fame_singers.json: 殿堂入りタグ付き楽曲に関与したボイスシンセシスアーティスト一覧

使い方:
  python 06_export_static_data.py
  python 06_export_static_data.py --output ../../public/data/hall_of_fame_singers.json
  python 06_export_static_data.py --output /path/to/output/hall_of_fame_singers.json
"""

import argparse
import json
import os
import sys
from pathlib import Path

# utils パッケージを参照できるようにパスを追加
sys.path.insert(0, os.path.dirname(__file__))
from utils.db import get_conn

# 対象とする artist_type の一覧
VOICE_SYNTH_TYPES = [
    "Vocaloid",
    "UTAU",
    "CeVIO",
    "SynthesizerV",
    "OtherVoiceSynthesizer",
]

# デフォルト出力先: スクリプトから見て ../../public/data/ (フロントエンドの public/)
DEFAULT_OUTPUT = os.path.join(
    os.path.dirname(__file__),
    "../../public/data/hall_of_fame_singers.json",
)

SQL_HALL_OF_FAME_SINGERS = """
SELECT DISTINCT
    a.id,
    a.name,
    a.artist_type
FROM artists a
JOIN song_artists sa ON sa.artist_id = a.id
JOIN song_tags   st  ON st.song_id   = sa.song_id
JOIN tags        t   ON t.id         = st.tag_id
WHERE
    a.artist_type = ANY(%(types)s)
    AND t.name LIKE '%%殿堂入り%%'
ORDER BY
    a.artist_type,
    a.name;
"""


def export_hall_of_fame_singers(output_path: str) -> None:
    """
    殿堂入りタグ付き楽曲に関与したボイスシンセシスシンガーを
    artist_type をキーとした辞書にまとめて JSON に書き出す。
    """
    print("[06] 殿堂入りシンガーデータをエクスポート中...")

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(SQL_HALL_OF_FAME_SINGERS, {"types": VOICE_SYNTH_TYPES})
            rows = cur.fetchall()

    # artist_type ごとにグループ化
    by_type: dict[str, list[dict]] = {t: [] for t in VOICE_SYNTH_TYPES}
    all_list: list[dict] = []

    for row in rows:
        entry = {
            "id":          row["id"],
            "name":        row["name"],
            "artist_type": row["artist_type"],
        }
        artist_type = row["artist_type"]
        if artist_type in by_type:
            by_type[artist_type].append(entry)
        all_list.append(entry)

    # 空のタイプキーは除外
    by_type_filtered = {k: v for k, v in by_type.items() if v}

    result = {
        "exported_at": _now_iso(),
        "by_type":     by_type_filtered,
        "all":         all_list,
    }

    # 出力ディレクトリを作成
    out = Path(output_path).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    total = len(all_list)
    print(f"[06] 完了: {total} 件のシンガーを書き出しました → {out}")
    for t, singers in by_type_filtered.items():
        print(f"       {t}: {len(singers)} 件")


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="静的マスターデータを JSON ファイルとしてエクスポートする"
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help=(
            "出力先 JSON ファイルパス "
            f"(デフォルト: {DEFAULT_OUTPUT})"
        ),
    )
    args = parser.parse_args()

    export_hall_of_fame_singers(args.output)


if __name__ == "__main__":
    main()
