"""
04b_extract_audio_from_local.py
================================
ローカルアーカイブ（H:\\Vocaloid_Archive 等）から音響特徴量を抽出して
Qdrant および PostgreSQL に格納するスクリプト。

04_extract_audio_features.py（YouTube ダウンロード版）の
ローカルファイル対応版。ファイル名が "{song_id}.m4a" / "{song_id}.mp4" の
形式であることを前提とし、ダウンロード不要で直接処理する。

実行例:
  python 04b_extract_audio_from_local.py
  python 04b_extract_audio_from_local.py --archive "H:\\Vocaloid_Archive"
  python 04b_extract_audio_from_local.py --limit 100   # テスト実行（100曲のみ）
  python 04b_extract_audio_from_local.py --workers 4   # 並列変換数を4に
"""
import os
import sys
import argparse
import tempfile
import subprocess
import threading
import queue
import numpy as np
import soundfile as sf
import tensorflow as tf
import tensorflow_hub as hub
from pathlib import Path
from tqdm import tqdm
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct, OptimizersConfigDiff
from utils.db import get_conn, QDRANT_URL, QDRANT_GRPC_PORT, QDRANT_COLLECTION_AUDIO, QDRANT_COLLECTION_NAMED

# ========== 定数 ==========
AUDIO_DIM         = 1024
META_DIM          = 924
SAMPLE_RATE       = 16000
MAX_DURATION_SEC  = 300
BATCH_SIZE_DEFAULT = 500

DEFAULT_ARCHIVE   = r"H:\Vocaloid_Archive"
AUDIO_EXTENSIONS  = {".m4a", ".mp4", ".wav", ".mp3", ".flac", ".ogg"}

N_WORKERS_DEFAULT = 3   # 並列変換スレッド数
QUEUE_MAXSIZE     = 16  # 変換キューバッファサイズ

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
        embeddings_np = embeddings.numpy()
        if embeddings_np.shape[0] == 0:
            return None  # 音声が短すぎてフレームが生成されなかった
        mean_emb = embeddings_np.mean(axis=0)
        if np.isnan(mean_emb).any():
            return None  # NaN埋め込みは破損した音声として扱う
        norm = np.linalg.norm(mean_emb)
        return mean_emb / norm if norm > 0 else mean_emb
    except Exception as e:
        tqdm.write(f'  [ERROR] Embedding: {e}', file=sys.stderr)
        return None


def convert_to_wav(src_path: str, tmp_dir: str) -> str | None:
    """ffmpeg で音声ファイルを 16kHz mono WAV に変換する。"""
    song_id_str = Path(src_path).stem
    wav_path = os.path.join(tmp_dir, f'{song_id_str}.wav')

    if os.path.exists(wav_path):
        return wav_path

    cmd = [
        'ffmpeg',
        '-y',
        '-i', src_path,
        '-ar', '16000',
        '-ac', '1',
        '-f', 'wav',
        wav_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired:
        return None

    if result.returncode != 0 or not os.path.exists(wav_path):
        if result.stderr:
            tqdm.write(f'  [ffmpeg stderr] {result.stderr.decode("utf-8", errors="replace")[:200]}',
                       file=sys.stderr)
        return None
    return wav_path


# ========== Producer（ファイル変換） ==========

def converter_worker(
    worker_id: int,
    task_q: queue.Queue,
    result_q: queue.Queue,
    tmp_dir: str,
    fail_ids: list,
) -> None:
    """ローカルファイルを WAV に変換してキューに積む。"""
    while True:
        item = task_q.get()
        if item is None:
            task_q.task_done()
            break

        song_id, src_path = item
        wav_path = convert_to_wav(src_path, tmp_dir)
        task_q.task_done()

        if not wav_path:
            fail_ids.append(song_id)
            tqdm.write(f'  [CONV-{worker_id}] FAIL song_id={song_id} ({src_path})')
            continue

        result_q.put((song_id, wav_path))
        tqdm.write(f'  [CONV-{worker_id}] OK song_id={song_id}')


# ========== Consumer（推論 + DB書き込み） ==========

def consumer_worker(
    result_q: queue.Queue,
    qdrant: QdrantClient,
    batch_size: int,
    pbar: tqdm,
) -> None:
    """YAMNet 推論 → Qdrant upsert → DB フラグ更新（シングルスレッド）。"""
    conn = get_conn()
    batch_points_audio: list[PointStruct] = []
    batch_points_named: list[PointStruct] = []

    while True:
        item = result_q.get()
        if item is None:
            result_q.task_done()
            break

        song_id, wav_path = item
        emb = extract_embedding(wav_path)

        try:
            os.remove(wav_path)
        except OSError:
            pass

        result_q.task_done()

        if emb is None:
            pbar.update(1)
            continue

        batch_points_audio.append(PointStruct(
            id=song_id,
            vector=emb.tolist(),
            payload={'song_id': song_id},
        ))
        batch_points_named.append(PointStruct(
            id=song_id,
            vector={'audio': emb.tolist()},
            payload={'song_id': song_id},
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
    parser.add_argument('--archive', default=DEFAULT_ARCHIVE,
                        help=f'音声ファイルのディレクトリ (デフォルト: {DEFAULT_ARCHIVE})')
    parser.add_argument('--batch-size', type=int, default=BATCH_SIZE_DEFAULT)
    parser.add_argument('--limit', type=int, default=0,
                        help='処理する曲数の上限 (0=全件)')
    parser.add_argument('--workers', type=int, default=N_WORKERS_DEFAULT,
                        help=f'並列変換スレッド数 (デフォルト: {N_WORKERS_DEFAULT})')
    parser.add_argument('--skip-db-check', action='store_true',
                        help='DB の audio_computed チェックをスキップして全ファイルを処理')
    args = parser.parse_args()

    archive_dir = args.archive
    n_workers = max(1, args.workers)

    if not os.path.isdir(archive_dir):
        print(f'[ERROR] Archive directory not found: {archive_dir}', file=sys.stderr)
        sys.exit(1)

    # -------- Qdrant 接続 / コレクション確認 --------
    qdrant_host = os.environ.get('QDRANT_HOST', 'localhost')
    qdrant = QdrantClient(host=qdrant_host, grpc_port=QDRANT_GRPC_PORT, prefer_grpc=True, timeout=120)
    existing = [c.name for c in qdrant.get_collections().collections]

    if QDRANT_COLLECTION_AUDIO not in existing:
        qdrant.create_collection(
            collection_name=QDRANT_COLLECTION_AUDIO,
            vectors_config=VectorParams(size=AUDIO_DIM, distance=Distance.COSINE),
            optimizers_config=OptimizersConfigDiff(indexing_threshold=10000),
        )
        print(f'Created Qdrant collection: {QDRANT_COLLECTION_AUDIO}')

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

    # -------- 処理済み song_id を DB から取得 --------
    processed_ids: set[int] = set()
    if not args.skip_db_check:
        conn = get_conn()
        with conn.cursor() as cur:
            cur.execute("SELECT song_id FROM song_features WHERE audio_computed = TRUE")
            processed_ids = {row['song_id'] for row in cur.fetchall()}
        conn.close()
        print(f'DB 処理済み曲数: {len(processed_ids)}')

    # -------- アーカイブをスキャンしてターゲット一覧を作成 --------
    targets: list[tuple[int, str]] = []
    for fname in os.listdir(archive_dir):
        stem, ext = os.path.splitext(fname)
        if ext.lower() not in AUDIO_EXTENSIONS:
            continue
        try:
            song_id = int(stem)
        except ValueError:
            continue  # ファイル名が数字でない場合はスキップ

        if song_id in processed_ids:
            continue
        targets.append((song_id, os.path.join(archive_dir, fname)))

    # song_id 昇順でソート（再現性のため）
    targets.sort(key=lambda x: x[0])

    if args.limit > 0:
        targets = targets[:args.limit]

    total = len(targets)
    print(f'処理対象: {total} 曲 (スキップ済み: {len(processed_ids)})')
    if total == 0:
        print('処理する曲がありません。')
        return

    # -------- GPU 確認 --------
    gpus = tf.config.list_physical_devices('GPU')
    if gpus:
        for gpu in gpus:
            tf.config.experimental.set_memory_growth(gpu, True)
        print(f'GPU: {gpus[0].name}')
    else:
        print('GPU not found, using CPU')

    # -------- YAMNet プリロード --------
    print('Loading YAMNet ...')
    get_yamnet()
    print('YAMNet loaded.')

    # -------- キュー / スレッド 起動 --------
    with tempfile.TemporaryDirectory(prefix='diva_audio_') as tmp_dir:
        task_q   = queue.Queue(maxsize=QUEUE_MAXSIZE * n_workers)
        result_q = queue.Queue(maxsize=QUEUE_MAXSIZE)
        fail_ids: list[int] = []

        # Producer スレッド群（ファイル変換）
        converter_threads = []
        for i in range(n_workers):
            t = threading.Thread(
                target=converter_worker,
                args=(i, task_q, result_q, tmp_dir, fail_ids),
                daemon=True,
            )
            t.start()
            converter_threads.append(t)

        # Consumer スレッド（推論 + DB 書き込み）
        pbar = tqdm(total=total, desc='Extract', unit='song')
        consumer_t = threading.Thread(
            target=consumer_worker,
            args=(result_q, qdrant, args.batch_size, pbar),
            daemon=True,
        )
        consumer_t.start()

        # タスクをキューに投入
        for song_id, src_path in targets:
            task_q.put((song_id, src_path))

        # 終了シグナル（各 converter に None を送る）
        for _ in range(n_workers):
            task_q.put(None)

        # Converter 完了待ち
        for t in converter_threads:
            t.join()

        # Consumer 終了シグナル → 完了待ち
        result_q.put(None)
        consumer_t.join()
        pbar.close()

    print(f'\n完了: 失敗 {len(fail_ids)} 曲')
    if fail_ids:
        print(f'失敗 song_id: {fail_ids[:20]}{"..." if len(fail_ids) > 20 else ""}')


if __name__ == '__main__':
    main()
