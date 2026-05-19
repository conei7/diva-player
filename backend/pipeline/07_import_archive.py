"""
07_import_archive.py
=====================
H:\\Vocaloid_Archive 内の .m4a + .json サイドカーを
songs_v2 Qdrant コレクションへインポートするスクリプト。

処理フロー:
  1. PostgreSQL DB から語彙(上位プロデューサー・ボーカリスト・タグ IDF) を読み込む
  2. H:\\Vocaloid_Archive\\*.m4a を走査
  3. songs_v2 コレクションに未登録の曲を処理対象とする
  4. .m4a → 16kHz mono WAV に ffmpeg で変換
  5. YAMNet で 1024 次元音響ベクトルを抽出
  6. .json サイドカーから 924 次元メタデータベクトルを構築
  7. songs_v2 へ Named Vectors として upsert
  8. 処理済み VocaDB ID を import_processed.txt に記録

実行例:
  python 07_import_archive.py
  python 07_import_archive.py --limit 500   # 最大 500 曲で止める
  python 07_import_archive.py --batch 200   # upsert バッチサイズを変更
"""
import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf
import tensorflow as tf
import tensorflow_hub as hub
from tqdm import tqdm
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct

from utils.db import get_conn, QDRANT_GRPC_PORT, QDRANT_COLLECTION_NAMED

# ===================================================================
# 設定
# ===================================================================

ARCHIVE_DIR = Path(r"H:\Vocaloid_Archive")
PROCESSED_FILE = Path(__file__).parent / "import_processed.txt"

# 特徴量次元数 (03_extract_metadata_features.py と完全に一致させること)
AUDIO_DIM   = 1024
META_DIM    = 924
N_PRODUCER  = 500
N_VOCALIST  = 100
N_TAG       = 300

VOCALIST_TYPES = [
    'Vocaloid', 'UTAU', 'CeVIO', 'SynthesizerV', 'NEUTRINO',
    'VoiSona', 'Voiceroid', 'OtherVoiceSynthesizer', 'OtherVocalist', 'Unknown',
]
SONG_TYPES = [
    'Original', 'Cover', 'Remix', 'Remaster', 'Mashup',
    'MusicPV', 'DramaPV', 'Other', 'Unspecified',
]

SAMPLE_RATE      = 16000
MAX_DURATION_SEC = 300
BATCH_SIZE_DEFAULT = 500

# ===================================================================
# YAMNet
# ===================================================================

_yamnet_model = None


def get_yamnet():
    global _yamnet_model
    if _yamnet_model is None:
        print("YAMNet モデルを読み込み中...")
        _yamnet_model = hub.load('https://tfhub.dev/google/yamnet/1')
    return _yamnet_model


def extract_embedding(wav_path: str) -> Optional[np.ndarray]:
    """WAV ファイルから YAMNet 1024 次元特徴量を抽出する。"""
    try:
        data, sr = sf.read(wav_path, dtype='float32', always_2d=True)
        data = data.mean(axis=1)  # ステレオ → モノラル

        if sr != SAMPLE_RATE:
            from scipy.signal import resample_poly
            from math import gcd
            g = gcd(SAMPLE_RATE, sr)
            data = resample_poly(data, SAMPLE_RATE // g, sr // g).astype(np.float32)

        max_samples = MAX_DURATION_SEC * SAMPLE_RATE
        if len(data) > max_samples:
            data = data[:max_samples]

        waveform = tf.constant(data, dtype=tf.float32)
        _, embeddings, _ = get_yamnet()(waveform)  # (frames, 1024)
        mean_emb = embeddings.numpy().mean(axis=0)
        norm = np.linalg.norm(mean_emb)
        return mean_emb / norm if norm > 0 else mean_emb
    except Exception as e:
        tqdm.write(f'  [ERROR] YAMNet: {e}')
        return None


# ===================================================================
# 音声変換
# ===================================================================

def convert_to_wav(m4a_path: str, out_dir: str) -> Optional[str]:
    """
    ffmpeg で .m4a → 16kHz mono WAV に変換する。
    成功したら WAV のパスを返す。
    """
    stem = Path(m4a_path).stem
    wav_path = os.path.join(out_dir, f"{stem}.wav")
    if os.path.exists(wav_path):
        return wav_path

    cmd = [
        "ffmpeg", "-y", "-i", m4a_path,
        "-ar", "16000", "-ac", "1",
        "-f", "wav", wav_path,
        "-loglevel", "error",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=120)
        if result.returncode != 0 or not os.path.exists(wav_path):
            err = result.stderr.decode("utf-8", errors="replace")[:300]
            tqdm.write(f"  [ffmpeg ERROR] {err}")
            return None
        return wav_path
    except subprocess.TimeoutExpired:
        tqdm.write("  [ffmpeg] タイムアウト")
        return None
    except FileNotFoundError:
        tqdm.write("  [ERROR] ffmpeg が見つかりません。ffmpeg を PATH に追加してください。")
        return None


# ===================================================================
# 語彙の読み込み (PostgreSQL)
# ===================================================================

def load_vocabulary(conn) -> tuple:
    """
    DB から上位プロデューサー・ボーカリスト・タグ IDF を読み込む。
    03_extract_metadata_features.py と同じロジック。
    """
    with conn.cursor() as cur:
        # ── 総楽曲数
        cur.execute("SELECT COUNT(*) AS n FROM songs")
        N = cur.fetchone()['n']

        # ── タグ IDF
        cur.execute("SELECT tag_id, COUNT(DISTINCT song_id) AS df FROM song_tags GROUP BY tag_id")
        idf_rows = cur.fetchall()
        idf = {}
        for r in idf_rows:
            df = max(r['df'], 1)
            idf[r['tag_id']] = math.log((N + 1) / (df + 1)) + 1.0

        # ── 上位タグ (IDF 降順)
        top_tags = [tid for tid, _ in sorted(idf.items(), key=lambda x: -x[1])[:N_TAG]]

        # ── タグ親マップ
        cur.execute("SELECT id, parent_id FROM tags WHERE parent_id IS NOT NULL")
        parent_map = {r['id']: r['parent_id'] for r in cur.fetchall()}

        # ── 上位プロデューサー
        cur.execute("""
            SELECT artist_id, COUNT(*) AS cnt
            FROM song_artists WHERE is_producer = TRUE
            GROUP BY artist_id ORDER BY cnt DESC LIMIT %s
        """, (N_PRODUCER,))
        top_producers = [r['artist_id'] for r in cur.fetchall()]

        # ── 上位ボーカリスト
        cur.execute("""
            SELECT artist_id, COUNT(*) AS cnt
            FROM song_artists WHERE is_vocalist = TRUE
            GROUP BY artist_id ORDER BY cnt DESC LIMIT %s
        """, (N_VOCALIST,))
        top_vocalists = [r['artist_id'] for r in cur.fetchall()]

    tag_idx      = {tid: i for i, tid in enumerate(top_tags)}
    producer_idx = {aid: i for i, aid in enumerate(top_producers)}
    vocalist_idx = {aid: i for i, aid in enumerate(top_vocalists)}

    return idf, parent_map, tag_idx, producer_idx, vocalist_idx


# ===================================================================
# 祖先タグ展開
# ===================================================================

def get_tag_ancestors(tag_id: int, parent_map: dict, cache: dict) -> set:
    if tag_id in cache:
        return cache[tag_id]
    result = {tag_id}
    p = parent_map.get(tag_id)
    while p and p not in result:
        result.add(p)
        p = parent_map.get(p)
    cache[tag_id] = result
    return result


# ===================================================================
# メタデータベクトル構築 (JSON サイドカーから)
# ===================================================================

def build_meta_vector(
    song_json: dict,
    idf: dict,
    parent_map: dict,
    tag_idx: dict,
    producer_idx: dict,
    vocalist_idx: dict,
    ancestor_cache: dict,
) -> np.ndarray:
    """
    VocaDB JSON サイドカーから 924 次元メタデータベクトルを構築する。
    03_extract_metadata_features.py と同一のフィーチャー定義を使用。
    """
    DIM = N_TAG + (N_PRODUCER + 1) + (N_VOCALIST + 1) + len(VOCALIST_TYPES) + len(SONG_TYPES) + 3
    vec = np.zeros(DIM, dtype=np.float32)
    offset = 0

    # ── 1. タグ TF-IDF ────────────────────────────────────────────
    tags = song_json.get("tags") or []
    tf_sum: dict = {}
    for t in tags:
        # JSON 形式: {"count": N, "tag": {"id": X, "name": "..."}}
        tag_obj = t.get("tag") or t  # VocaDB fields=Tags の場合
        tag_id  = tag_obj.get("id") if isinstance(tag_obj, dict) else t.get("id")
        count   = t.get("count", 1)
        if tag_id is None:
            continue
        ancestors = get_tag_ancestors(tag_id, parent_map, ancestor_cache)
        for anc in ancestors:
            if anc in tag_idx:
                tf_sum[anc] = tf_sum.get(anc, 0) + count

    max_tf = max(tf_sum.values()) if tf_sum else 1
    for tid, tf in tf_sum.items():
        if tid in tag_idx:
            vec[offset + tag_idx[tid]] = (tf / max_tf) * idf.get(tid, 1.0)
    offset += N_TAG

    # ── 2. プロデューサー one-hot ─────────────────────────────────
    artists = song_json.get("artists") or []
    has_other_prod = False
    for a in artists:
        cats = (a.get("categories") or "").split(",")
        cats = [c.strip() for c in cats]
        if "Producer" in cats:
            artist_ref = a.get("artist") or {}
            aid = artist_ref.get("id") if isinstance(artist_ref, dict) else None
            if aid and aid in producer_idx:
                vec[offset + producer_idx[aid]] = 1.5
            else:
                has_other_prod = True
    if has_other_prod:
        vec[offset + N_PRODUCER] = 0.5
    offset += N_PRODUCER + 1

    # ── 3. ボーカリスト one-hot ───────────────────────────────────
    has_other_voc = False
    for a in artists:
        cats = (a.get("categories") or "").split(",")
        cats = [c.strip() for c in cats]
        if "Vocalist" in cats:
            artist_ref = a.get("artist") or {}
            aid = artist_ref.get("id") if isinstance(artist_ref, dict) else None
            if aid and aid in vocalist_idx:
                vec[offset + vocalist_idx[aid]] = 1.0
            else:
                has_other_voc = True
    if has_other_voc:
        vec[offset + N_VOCALIST] = 0.5
    offset += N_VOCALIST + 1

    # ── 4. ボーカリストタイプ one-hot ─────────────────────────────
    for a in artists:
        cats = (a.get("categories") or "").split(",")
        cats = [c.strip() for c in cats]
        if "Vocalist" in cats:
            artist_ref = a.get("artist") or {}
            atype = artist_ref.get("artistType") if isinstance(artist_ref, dict) else None
            if atype and atype in VOCALIST_TYPES:
                i = VOCALIST_TYPES.index(atype)
                vec[offset + i] = max(vec[offset + i], 1.0)
    offset += len(VOCALIST_TYPES)

    # ── 5. 楽曲タイプ one-hot ─────────────────────────────────────
    song_type = song_json.get("songType") or "Unspecified"
    if song_type in SONG_TYPES:
        vec[offset + SONG_TYPES.index(song_type)] = 1.0
    offset += len(SONG_TYPES)

    # ── 6. スカラー特徴量 ─────────────────────────────────────────
    length_sec = song_json.get("lengthSeconds") or 0
    length = min(length_sec / 600.0, 1.0)

    year = 0.0
    pub_date = song_json.get("publishDate") or ""
    if pub_date:
        try:
            y = int(pub_date[:4])
            year = max(0.0, min(1.0, (y - 2007) / 18.0))
        except (ValueError, IndexError):
            pass

    favorited = song_json.get("favoritedTimes") or 0
    popularity = min(math.log1p(favorited) / 15.0, 1.0)

    vec[offset]     = length
    vec[offset + 1] = year
    vec[offset + 2] = popularity
    offset += 3

    assert offset == DIM, f"次元数ミスマッチ: {offset} != {DIM}"

    # 正規化
    norm = np.linalg.norm(vec)
    if norm > 0:
        vec /= norm
    return vec


# ===================================================================
# 処理済み ID の管理
# ===================================================================

def load_processed_ids() -> set:
    if not PROCESSED_FILE.exists():
        return set()
    with open(PROCESSED_FILE, encoding="utf-8") as f:
        result = set()
        for line in f:
            line = line.strip()
            if line.isdigit():
                result.add(int(line))
        return result


def mark_processed_id(vocadb_id: int) -> None:
    with open(PROCESSED_FILE, "a", encoding="utf-8") as f:
        f.write(f"{vocadb_id}\n")


# ===================================================================
# メイン処理
# ===================================================================

def parse_args():
    parser = argparse.ArgumentParser(description="H:\\Vocaloid_Archive → songs_v2 インポーター")
    parser.add_argument("--limit", type=int, default=0, help="処理件数上限 (0 = 無制限)")
    parser.add_argument("--batch", type=int, default=BATCH_SIZE_DEFAULT, help="Qdrant upsert バッチサイズ")
    return parser.parse_args()


def main():
    args = parse_args()

    # ── Qdrant 接続 ───────────────────────────────────────────────
    qdrant = QdrantClient(
        host="localhost",
        grpc_port=QDRANT_GRPC_PORT,
        prefer_grpc=True,
        timeout=120,
    )

    # ── DB 接続 & 語彙読み込み ─────────────────────────────────────
    print("PostgreSQL から語彙を読み込み中...")
    conn = get_conn()
    idf, parent_map, tag_idx, producer_idx, vocalist_idx = load_vocabulary(conn)
    conn.close()
    print(f"  top_tags={len(tag_idx)}, top_producers={len(producer_idx)}, top_vocalists={len(vocalist_idx)}")

    # ── 処理済み ID の読み込み ─────────────────────────────────────
    processed_ids = load_processed_ids()

    # ── songs_v2 に既存の ID を取得 ──────────────────────────────
    print("songs_v2 の既存 ID を取得中...")
    existing_ids: set = set()
    offset_scroll = None
    while True:
        result, next_offset = qdrant.scroll(
            collection_name=QDRANT_COLLECTION_NAMED,
            limit=10000,
            offset=offset_scroll,
            with_payload=False,
            with_vectors=False,
        )
        for pt in result:
            existing_ids.add(pt.id)
        if next_offset is None:
            break
        offset_scroll = next_offset
    print(f"  songs_v2 既存: {len(existing_ids)} 件")

    # ── 処理対象ファイルの収集 ─────────────────────────────────────
    m4a_files = sorted(ARCHIVE_DIR.glob("*.m4a"), key=lambda p: int(p.stem))
    candidates = []
    for m4a in m4a_files:
        try:
            vocadb_id = int(m4a.stem)
        except ValueError:
            continue
        json_path = m4a.with_suffix(".json")
        if not json_path.exists():
            continue
        if vocadb_id in processed_ids or vocadb_id in existing_ids:
            continue
        candidates.append((vocadb_id, m4a, json_path))

    total = len(candidates)
    print(f"\n処理対象: {total} 曲 (スキップ済み: {len(m4a_files) - total} 曲)")

    if args.limit > 0:
        candidates = candidates[:args.limit]
        print(f"  --limit {args.limit} が指定されたため {len(candidates)} 曲に絞ります")

    # ── YAMNet ロード ─────────────────────────────────────────────
    yamnet = get_yamnet()
    ancestor_cache: dict = {}

    # ── バッチ upsert バッファ ─────────────────────────────────────
    batch_points: list[PointStruct] = []
    failed_ids: list = []

    with tempfile.TemporaryDirectory(prefix="import_archive_") as tmp_dir:
        for vocadb_id, m4a_path, json_path in tqdm(candidates, unit="song"):
            # ── JSON 読み込み ──────────────────────────────────────
            try:
                with open(json_path, encoding="utf-8") as f:
                    song_json = json.load(f)
            except Exception as e:
                tqdm.write(f"  [ERROR] JSON読み込み: {e}")
                mark_processed_id(vocadb_id)
                continue

            # ── WAV 変換 ───────────────────────────────────────────
            wav_path = convert_to_wav(str(m4a_path), tmp_dir)
            if wav_path is None:
                tqdm.write(f"  [SKIP] {vocadb_id}: ffmpeg 変換失敗")
                failed_ids.append(vocadb_id)
                mark_processed_id(vocadb_id)
                continue

            # ── YAMNet 特徴量抽出 ──────────────────────────────────
            audio_vec = extract_embedding(wav_path)

            # WAV は使い終わったら即削除してディスクを節約
            try:
                os.remove(wav_path)
            except OSError:
                pass

            if audio_vec is None:
                tqdm.write(f"  [SKIP] {vocadb_id}: 音響特徴量抽出失敗")
                failed_ids.append(vocadb_id)
                mark_processed_id(vocadb_id)
                continue

            # ── メタデータベクトル構築 ─────────────────────────────
            meta_vec = build_meta_vector(
                song_json, idf, parent_map,
                tag_idx, producer_idx, vocalist_idx,
                ancestor_cache,
            )

            # ── Qdrant PointStruct (Named Vectors) ────────────────
            batch_points.append(PointStruct(
                id=vocadb_id,
                vector={
                    "audio": audio_vec.tolist(),
                    "meta":  meta_vec.tolist(),
                },
                payload={
                    "song_id": vocadb_id,
                    "name":    song_json.get("name", ""),
                    "source":  "archive",
                },
            ))
            mark_processed_id(vocadb_id)

            # ── バッチ upsert ──────────────────────────────────────
            if len(batch_points) >= args.batch:
                qdrant.upsert(QDRANT_COLLECTION_NAMED, batch_points)
                tqdm.write(f"  → {args.batch} 件 upsert 完了 (累計処理数: {len(processed_ids)})")
                batch_points.clear()

        # ── 残りをフラッシュ ───────────────────────────────────────
        if batch_points:
            qdrant.upsert(QDRANT_COLLECTION_NAMED, batch_points)
            tqdm.write(f"  → 残り {len(batch_points)} 件 upsert 完了")

    print(f"\n[完了] 成功: {len(candidates) - len(failed_ids)} 曲 / 失敗: {len(failed_ids)} 曲")
    if failed_ids:
        print(f"  失敗 VocaDB ID: {failed_ids[:20]}{'...' if len(failed_ids) > 20 else ''}")


if __name__ == "__main__":
    main()
