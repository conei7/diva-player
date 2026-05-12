"""
04_extract_audio_features.py
=============================
YouTube から音声をダウンロードし、YAMNet (TensorFlow Hub) で
512次元の音響特徴量ベクトルを抽出して Qdrant に格納する。

GPU (RTX 3080) を使用して高速化。1TBストレージを考慮し、
BATCH_SIZE 件ずつ処理してからダウンロードした音声を削除する。

実行例:
  python 04_extract_audio_features.py --batch-size 500
  python 04_extract_audio_features.py --resume        # チェックポイントから再開
"""
import os
import sys
import argparse
import tempfile
import subprocess
import numpy as np
import soundfile as sf
import tensorflow as tf
import tensorflow_hub as hub
from tqdm import tqdm
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct, OptimizersConfigDiff
from utils.db import get_conn, QDRANT_URL, QDRANT_COLLECTION_AUDIO

AUDIO_DIM   = 512          # YAMNet embeddings 次元数
SAMPLE_RATE = 16000        # YAMNet は 16kHz モノラル
MAX_DURATION_SEC = 300     # 最大5分の音声を使用
BATCH_SIZE_DEFAULT = 500
CHECKPOINT_KEY = 'audio_last_song_id'

print('Loading YAMNet from TF Hub ...')
_yamnet_model = None


def get_yamnet():
    global _yamnet_model
    if _yamnet_model is None:
        _yamnet_model = hub.load('https://tfhub.dev/google/yamnet/1')
    return _yamnet_model


def extract_embedding(wav_path: str) -> np.ndarray | None:
    """
    WAV ファイルから YAMNet 音響特徴量 (512次元) を抽出する。
    複数フレームの平均を楽曲レベルの表現として使用。
    """
    try:
        data, sr = sf.read(wav_path, dtype='float32', always_2d=True)
        data = data.mean(axis=1)   # ステレオ → モノラル

        # リサンプリング (librosa不要: soundfile + scipy)
        if sr != SAMPLE_RATE:
            from scipy.signal import resample_poly
            from math import gcd
            g = gcd(SAMPLE_RATE, sr)
            data = resample_poly(data, SAMPLE_RATE // g, sr // g).astype(np.float32)

        # 長さを制限
        max_samples = MAX_DURATION_SEC * SAMPLE_RATE
        if len(data) > max_samples:
            data = data[:max_samples]

        waveform = tf.constant(data, dtype=tf.float32)
        _, embeddings, _ = get_yamnet()(waveform)  # embeddings: (frames, 512)

        mean_emb = embeddings.numpy().mean(axis=0)   # (512,)
        norm = np.linalg.norm(mean_emb)
        return mean_emb / norm if norm > 0 else mean_emb
    except Exception as e:
        print(f'  Embedding error: {e}', file=sys.stderr)
        return None


def download_audio(youtube_id: str, out_dir: str) -> str | None:
    """
    yt-dlp で YouTube から音声のみをダウンロード。
    WAV に変換して返す。
    """
    out_template = os.path.join(out_dir, f'{youtube_id}.%(ext)s')
    wav_path     = os.path.join(out_dir, f'{youtube_id}.wav')

    if os.path.exists(wav_path):
        return wav_path

    cmd = [
        'yt-dlp',
        '-x',                          # 音声のみ
        '--audio-format', 'wav',
        '--audio-quality', '0',        # 最高品質
        '-o', out_template,
        '--no-playlist',
        '--quiet',
        '--no-warnings',
        '--socket-timeout', '30',
        f'https://www.youtube.com/watch?v={youtube_id}',
    ]
    result = subprocess.run(cmd, capture_output=True, timeout=120)
    if result.returncode != 0 or not os.path.exists(wav_path):
        return None
    return wav_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--batch-size', type=int, default=BATCH_SIZE_DEFAULT)
    parser.add_argument('--resume',     action='store_true', help='チェックポイントから再開')
    args = parser.parse_args()

    conn   = get_conn()
    qdrant = QdrantClient(url=QDRANT_URL)

    # Qdrant コレクション
    existing = [c.name for c in qdrant.get_collections().collections]
    if QDRANT_COLLECTION_AUDIO not in existing:
        qdrant.create_collection(
            collection_name=QDRANT_COLLECTION_AUDIO,
            vectors_config=VectorParams(size=AUDIO_DIM, distance=Distance.COSINE),
            optimizers_config=OptimizersConfigDiff(indexing_threshold=10000),
        )
        print(f'Created Qdrant collection: {QDRANT_COLLECTION_AUDIO}')

    # 未処理楽曲を取得 (YouTube PV がある曲のみ)
    last_id = 0
    if args.resume:
        from utils.db import get_sync_state
        val = get_sync_state(CHECKPOINT_KEY)
        last_id = int(val) if val else 0
        print(f'Resuming from song_id > {last_id}')

    with conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT s.id AS song_id, p.pv_id AS youtube_id
            FROM songs s
            JOIN pvs p ON p.song_id = s.id
                AND p.service = 'Youtube'
                AND p.disabled = FALSE
                AND p.pv_type = 'Original'
            LEFT JOIN song_features sf ON sf.song_id = s.id
            WHERE (sf.audio_computed IS NULL OR sf.audio_computed = FALSE)
              AND s.id > %s
            ORDER BY s.id
        """, (last_id,))
        targets = cur.fetchall()

    print(f'Songs to process: {len(targets)}')

    # GPU設定
    gpus = tf.config.list_physical_devices('GPU')
    if gpus:
        for gpu in gpus:
            tf.config.experimental.set_memory_growth(gpu, True)
        print(f'Using GPU: {gpus[0].name}')
    else:
        print('No GPU found, using CPU')

    # プリロード
    get_yamnet()

    with tempfile.TemporaryDirectory(prefix='vocadb_audio_') as tmp_dir:
        batch_points: list[PointStruct] = []

        for row in tqdm(targets, unit='song'):
            song_id    = row['song_id']
            youtube_id = row['youtube_id']

            wav_path = download_audio(youtube_id, tmp_dir)
            if not wav_path:
                continue

            emb = extract_embedding(wav_path)

            # 処理後すぐに削除してストレージを節約
            try:
                os.remove(wav_path)
            except OSError:
                pass

            if emb is None:
                continue

            batch_points.append(PointStruct(
                id=song_id,
                vector=emb.tolist(),
                payload={'song_id': song_id, 'youtube_id': youtube_id},
            ))

            # DB に audio_computed フラグを更新
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO song_features (song_id, audio_dim, audio_computed, computed_at)
                    VALUES (%s, %s, TRUE, now())
                    ON CONFLICT (song_id) DO UPDATE SET
                        audio_dim = EXCLUDED.audio_dim,
                        audio_computed = TRUE,
                        computed_at = now()
                """, (song_id, AUDIO_DIM))
            conn.commit()

            if len(batch_points) >= args.batch_size:
                qdrant.upsert(QDRANT_COLLECTION_AUDIO, batch_points)
                batch_points.clear()
                from utils.db import set_sync_state
                set_sync_state(CHECKPOINT_KEY, str(song_id))

        if batch_points:
            qdrant.upsert(QDRANT_COLLECTION_AUDIO, batch_points)

    print('Audio feature extraction complete.')
    conn.close()


if __name__ == '__main__':
    main()
