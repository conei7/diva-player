"""
04_extract_audio_features.py
=============================
Producer-Consumer 並列アーキテクチャ:
  - Producer × N_DOWNLOADERS: yt-dlp でダウンロード (IOバウンド)
  - Consumer × 1: YAMNet で特徴量抽出 (GPU/CPUバウンド)
  - 両者の間にキューを置き、DL待機中も推論を継続 → 約3-4倍の高速化

高速化ポイント:
  - N_DOWNLOADERS=3 の並列ダウンロード (スレッドをSTAGGER_DELAYsずらして起動)
  - yt-dlp に --postprocessor-args で 16kHz mono 直接変換 (WAVサイズ削減)
  - ダウンロードスレッドごとに独立したスリープ管理

対象拡大 (UTAU・CeVIO等を網羅):
  - Vocaloid/主要エンジン: rating_score >= 150
  - UTAU/CeVIO/SynthesizerV 等: rating_score >= 80
  - pv_type IN ('Original', 'Reprint') で PV網羅率向上

実行例:
  python 04_extract_audio_features.py
  python 04_extract_audio_features.py --limit 0       # 全件（夜間バッチ推奨）
  python 04_extract_audio_features.py --workers 2     # 並列数を2に下げる
"""
import os
import sys
import argparse
import tempfile
import subprocess
import random
import time
import threading
import queue
import numpy as np
import soundfile as sf
import tensorflow as tf
import tensorflow_hub as hub
from tqdm import tqdm
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct, OptimizersConfigDiff
from utils.db import get_conn, QDRANT_URL, QDRANT_GRPC_PORT, QDRANT_COLLECTION_AUDIO, QDRANT_COLLECTION_NAMED

# ========== 定数 ==========
AUDIO_DIM        = 1024    # YAMNet embeddings 次元数
META_DIM         = 924     # メタデータベクトル次元数（songs_v2 Named Vectors用）
SAMPLE_RATE      = 16000   # YAMNet は 16kHz モノラル
MAX_DURATION_SEC = 300     # 最大5分
BATCH_SIZE_DEFAULT = 500   # Qdrant upsert バッチサイズ

N_DOWNLOADERS_DEFAULT = 3  # 並列ダウンロードスレッド数
QUEUE_MAXSIZE    = 8       # ダウンロードキューバッファ (ディスク節約)
DL_SLEEP_MIN     = 40      # ダウンロード成功後スリープ最小 (秒/スレッド)
DL_SLEEP_MAX     = 80      # ダウンロード成功後スリープ最大 (秒/スレッド)
DL_FAIL_SLEEP    = 8       # ダウンロード失敗後スリープ (秒)
STAGGER_DELAY    = 15      # スレッド起動間隔 (秒, BAN回避)

# 対象楽曲の閾値: favorited_times >= 12
FAVORITED_THRESHOLD = 12

# ========== YAMNet ==========
_yamnet_model = None
_yamnet_lock  = threading.Lock()


def get_yamnet():
    global _yamnet_model
    if _yamnet_model is None:
        with _yamnet_lock:
            if _yamnet_model is None:
                _yamnet_model = hub.load('https://tfhub.dev/google/yamnet/1')
    return _yamnet_model


def extract_embedding(wav_path: str) -> np.ndarray | None:
    """WAV ファイルから YAMNet 1024次元特徴量を抽出する。"""
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
        tqdm.write(f'  [ERROR] Embedding: {e}', file=sys.stderr)
        return None


def download_audio(youtube_id: str, out_dir: str) -> str | None:
    """
    yt-dlp で YouTube から音声をダウンロードし、16kHz mono WAV に変換。
    --postprocessor-args で ffmpeg に直接 16kHz/mono を指定することで
    ファイルサイズを削減し後処理コストを最小化する。
    """
    out_template = os.path.join(out_dir, f'{youtube_id}.%(ext)s')
    wav_path     = os.path.join(out_dir, f'{youtube_id}.wav')

    if os.path.exists(wav_path):
        return wav_path

    cmd = [
        sys.executable, '-m', 'yt_dlp',
        '-x',
        '--audio-format', 'wav',
        '--audio-quality', '5',              # 中品質 (YAMNet推論には十分)
        '--postprocessor-args', 'ffmpeg:-ar 16000 -ac 1',  # 16kHz mono直接出力
        '-o', out_template,
        '--no-playlist',
        '--quiet',
        '--no-warnings',
        '--socket-timeout', '30',
        # SABR ストリーミング回避
        '--extractor-args', 'youtube:player_client=default',
        f'https://www.youtube.com/watch?v={youtube_id}',
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=180)
    except subprocess.TimeoutExpired:
        return None
    if result.returncode != 0 or not os.path.exists(wav_path):
        if result.stderr:
            tqdm.write(f'  [yt-dlp stderr] {result.stderr.decode("utf-8", errors="replace")[:300]}', file=sys.stderr)
        return None
    return wav_path


# ========== Producer (ダウンローダー) ==========

def downloader_worker(
    worker_id: int,
    task_q: queue.Queue,
    result_q: queue.Queue,
    tmp_dir: str,
    fail_ids: list,
) -> None:
    """yt-dlp でダウンロードし、結果キューに積む。複数PVを順番に試みる。"""
    while True:
        row = task_q.get()
        if row is None:
            task_q.task_done()
            break

        song_id     = row['song_id']
        youtube_ids = row['youtube_ids']  # 複数PVのリスト

        wav_path = None
        used_yt_id = None
        for youtube_id in youtube_ids:
            wav_path = download_audio(youtube_id, tmp_dir)
            if wav_path:
                used_yt_id = youtube_id
                break

        task_q.task_done()

        if not wav_path:
            fail_ids.append(song_id)
            tqdm.write(f'  [DL-{worker_id}] FAIL song_id={song_id} (tried {len(youtube_ids)} PVs)')
            time.sleep(random.uniform(DL_FAIL_SLEEP, DL_FAIL_SLEEP * 3))
            continue

        # row に実際に使用した youtube_id をセット
        row = dict(row)
        row['youtube_id'] = used_yt_id

        # 結果キューに積む (満杯なら自然にブロック = バックプレッシャー)
        result_q.put((row, wav_path))

        sleep_sec = random.uniform(DL_SLEEP_MIN, DL_SLEEP_MAX)
        tqdm.write(f'  [DL-{worker_id}] OK song_id={song_id} ({used_yt_id}) → sleep {sleep_sec:.0f}s')
        time.sleep(sleep_sec)


# ========== Consumer (推論 + DB書き込み) ==========

def consumer_worker(
    result_q: queue.Queue,
    qdrant: QdrantClient,
    batch_size: int,
    pbar: tqdm,
) -> None:
    """YAMNet 推論 → Qdrant upsert → DB フラグ更新 (シングルスレッド)。"""
    conn = get_conn()
    batch_points_audio:  list[PointStruct] = []
    batch_points_named:  list[PointStruct] = []

    while True:
        item = result_q.get()
        if item is None:
            result_q.task_done()
            break

        row, wav_path = item
        song_id    = row['song_id']
        youtube_id = row['youtube_id']

        emb = extract_embedding(wav_path)

        try:
            os.remove(wav_path)
        except OSError:
            pass

        result_q.task_done()

        if emb is None:
            pbar.update(1)
            continue

        # audio コレクション (後方互換)
        batch_points_audio.append(PointStruct(
            id=song_id,
            vector=emb.tolist(),
            payload={'song_id': song_id, 'youtube_id': youtube_id},
        ))

        # songs_v2 Named Vectors: audio のみ更新（meta は 05 スクリプトで格納）
        batch_points_named.append(PointStruct(
            id=song_id,
            vector={'audio': emb.tolist()},
            payload={'song_id': song_id, 'youtube_id': youtube_id},
        ))

        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO song_features (song_id, audio_dim, audio_computed, computed_at)
                VALUES (%s, %s, TRUE, now())
                ON CONFLICT (song_id) DO UPDATE SET
                    audio_dim      = EXCLUDED.audio_dim,
                    audio_computed = TRUE,
                    computed_at    = now()
            """, (song_id, AUDIO_DIM))
        conn.commit()

        if len(batch_points_audio) >= batch_size:
            qdrant.upsert(QDRANT_COLLECTION_AUDIO, batch_points_audio)
            batch_points_audio.clear()
        if len(batch_points_named) >= batch_size:
            qdrant.upsert(QDRANT_COLLECTION_NAMED, batch_points_named)
            batch_points_named.clear()

        pbar.update(1)

    # 残余フラッシュ
    if batch_points_audio:
        qdrant.upsert(QDRANT_COLLECTION_AUDIO, batch_points_audio)
    if batch_points_named:
        qdrant.upsert(QDRANT_COLLECTION_NAMED, batch_points_named)

    conn.close()


# ========== メイン ==========

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--batch-size', type=int, default=BATCH_SIZE_DEFAULT)
    parser.add_argument('--limit',   type=int, default=0,
                        help='処理する曲数の上限 (0=無制限, デフォルト: 全件)')
    parser.add_argument('--workers', type=int, default=N_DOWNLOADERS_DEFAULT,
                        help=f'並列ダウンロード数 (デフォルト: {N_DOWNLOADERS_DEFAULT})')
    args = parser.parse_args()
    n_workers = max(1, args.workers)

    conn   = get_conn()
    qdrant = QdrantClient(host='localhost', grpc_port=QDRANT_GRPC_PORT, prefer_grpc=True, timeout=120)

    # Qdrant コレクション
    existing = [c.name for c in qdrant.get_collections().collections]
    if QDRANT_COLLECTION_AUDIO not in existing:
        qdrant.create_collection(
            collection_name=QDRANT_COLLECTION_AUDIO,
            vectors_config=VectorParams(size=AUDIO_DIM, distance=Distance.COSINE),
            optimizers_config=OptimizersConfigDiff(indexing_threshold=10000),
        )
        print(f'Created Qdrant collection: {QDRANT_COLLECTION_AUDIO}')

    # songs_v2 Named Vectors コレクション（audio: 1024次元, meta: 924次元）
    if QDRANT_COLLECTION_NAMED not in existing:
        qdrant.create_collection(
            collection_name=QDRANT_COLLECTION_NAMED,
            vectors_config={
                'audio': VectorParams(size=AUDIO_DIM, distance=Distance.COSINE),
                'meta':  VectorParams(size=META_DIM,  distance=Distance.COSINE),
            },
            optimizers_config=OptimizersConfigDiff(indexing_threshold=10000),
        )
        print(f'Created Named Vectors collection: {QDRANT_COLLECTION_NAMED}')

    # ターゲット取得: favorited_times >= FAVORITED_THRESHOLD、未処理のみ
    # 各楽曲の全 YouTube PV を取得し、ダウンロード時に順番に試みる
    # (Original 優先、数字始まりのMusic Premium専用IDを後回し)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                s.id AS song_id,
                s.favorited_times,
                ARRAY_AGG(
                    p.pv_id
                    ORDER BY
                        CASE p.pv_type WHEN 'Original' THEN 0 ELSE 1 END,
                        -- 数字始まり（YouTube Music Premium専用）を後回しに
                        CASE WHEN p.pv_id ~ '^[A-Za-z]' THEN 0 ELSE 1 END,
                        p.pv_id
                ) AS youtube_ids
            FROM songs s
            JOIN pvs p ON p.song_id = s.id
                AND p.service = 'Youtube'
                AND p.disabled = FALSE
                AND p.pv_type IN ('Original', 'Reprint')
            LEFT JOIN song_features sf ON sf.song_id = s.id
            WHERE (sf.audio_computed IS NULL OR sf.audio_computed = FALSE)
              AND s.favorited_times >= %s
            GROUP BY s.id, s.favorited_times
        """, (FAVORITED_THRESHOLD,))
        all_targets = cur.fetchall()

    all_targets.sort(key=lambda r: r.get('favorited_times') or 0, reverse=True)
    targets = all_targets[:args.limit] if args.limit > 0 else all_targets
    conn.commit()
    conn.close()

    print(f'ターゲット: {len(targets)}曲 (favorited_times >= {FAVORITED_THRESHOLD})')
    print(f'並列ダウンローダー数: {n_workers}, スタガー: {STAGGER_DELAY}s')

    # GPU
    gpus = tf.config.list_physical_devices('GPU')
    if gpus:
        for gpu in gpus:
            tf.config.experimental.set_memory_growth(gpu, True)
        print(f'GPU: {gpus[0].name}')
    else:
        print('GPU not found, using CPU')

    # YAMNet プリロード
    print('Loading YAMNet ...')
    get_yamnet()
    print('YAMNet loaded.')

    # キュー
    task_queue   = queue.Queue()
    result_queue = queue.Queue(maxsize=QUEUE_MAXSIZE)
    fail_ids: list = []

    for row in targets:
        task_queue.put(row)
    for _ in range(n_workers):
        task_queue.put(None)  # sentinel

    with tempfile.TemporaryDirectory(prefix='vocadb_audio_') as tmp_dir:
        pbar = tqdm(total=len(targets), unit='song')

        # ダウンローダースレッド (スタガー起動)
        dl_threads = []
        for i in range(n_workers):
            t = threading.Thread(
                target=downloader_worker,
                args=(i, task_queue, result_queue, tmp_dir, fail_ids),
                daemon=True,
            )
            t.start()
            dl_threads.append(t)
            if i < n_workers - 1:
                time.sleep(STAGGER_DELAY)

        # コンシューマースレッド
        consumer_t = threading.Thread(
            target=consumer_worker,
            args=(result_queue, qdrant, args.batch_size, pbar),
            daemon=True,
        )
        consumer_t.start()

        # 全ダウンローダーの終了を待つ
        for t in dl_threads:
            t.join()

        # コンシューマーに終了シグナル
        result_queue.put(None)
        consumer_t.join()
        pbar.close()

    if fail_ids:
        print(f'ダウンロード失敗: {len(fail_ids)}曲 → {fail_ids[:10]}...')
    print('Audio feature extraction complete.')


if __name__ == '__main__':
    main()
