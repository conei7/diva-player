#!/usr/bin/env python3
"""Bounded read-only audit run on the SBC: compare live API paths with before/after DB rows."""
import argparse
import datetime
import json
from pathlib import Path
import statistics
import subprocess
import time
import urllib.parse
import urllib.request


def database_rows(ids):
    if not ids or any(not isinstance(value, int) or value <= 0 for value in ids):
        raise ValueError('Positive integer IDs required')
    sql = """BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json) FROM (
 SELECT s.id, s.name, s.artist_string, s.youtube_views, s.nico_views,
        s.raw_json->>'name' AS raw_name, s.raw_json->>'defaultName' AS default_name,
        s.raw_json->>'artistString' AS raw_artist_string,
        COALESCE(s.raw_json->'pvs','[]'::jsonb) AS pvs,
        EXISTS(SELECT 1 FROM song_features sf WHERE sf.song_id=s.id AND sf.audio_computed IS TRUE) AS audio_computed, aa.bpm, aa.musical_key, aa.key_mode, aa.key_confidence,
        aa.chorus_start_seconds, aa.chorus_end_seconds, aa.chorus_confidence,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('key',sai.instrument_key,'score',sai.score) ORDER BY sai.rank)
                  FROM song_audio_instruments sai WHERE sai.song_id=s.id AND sai.score>=0.08),'[]'::jsonb) AS audio_instruments
 FROM songs s LEFT JOIN song_audio_analysis aa ON aa.song_id=s.id WHERE s.id IN (""" + ','.join(map(str, ids)) + ") ORDER BY s.id) r; COMMIT;"
    result = subprocess.run(['docker', 'exec', '-i', 'vocadb_postgres', 'psql', '-X', '-qAt',
                             '-v', 'ON_ERROR_STOP=1', '-U', 'vocadb', '-d', 'vocadb_recommender'],
                            input=sql, text=True, capture_output=True, timeout=25, check=True)
    return {row['id']: row for row in json.loads(result.stdout)}


def pv_keys(pvs):
    return sorted((str(pv.get('service')), str(pv.get('pvId')), bool(pv.get('disabled', False))) for pv in pvs)


def compare_song(song, row):
    expected = {'name': row['raw_name'] or row['name'], 'defaultName': row['default_name'] or row['name'],
                'artistString': row['artist_string'] or '', 'youtubeViews': row['youtube_views'],
                'nicoViews': row['nico_views'], 'audioComputed': row['audio_computed'],
                'bpm': row['bpm'], 'musicalKey': row['musical_key'], 'keyMode': row['key_mode'],
                'keyConfidence': row['key_confidence'], 'chorusStartSeconds': row['chorus_start_seconds'],
                'chorusEndSeconds': row['chorus_end_seconds'], 'chorusConfidence': row['chorus_confidence'],
                'audioInstruments': row['audio_instruments']}
    differences = {key: {'expected': value, 'actual': song.get(key)} for key, value in expected.items()
                   if song.get(key) != value}
    if pv_keys(song.get('pvs', [])) != pv_keys(row['pvs']):
        differences['pvs'] = {'expected': pv_keys(row['pvs']), 'actual': pv_keys(song.get('pvs', []))}
    return differences


def audit(routes, repeats=3):
    timings, payloads, failures = [], [], []
    def fetch(label, base, path):
        started = time.perf_counter()
        try:
            request = urllib.request.Request(base.rstrip('/') + path, headers={'User-Agent': 'DIVA-ReadOnly-Audit/1.0', 'Origin': 'https://diva-player.pages.dev'})
            with urllib.request.urlopen(request, timeout=25) as response:
                body = response.read()
                data = json.loads(body)
                timings.append({'route': label, 'path': path, 'ms': round((time.perf_counter()-started)*1000, 1),
                                'bytes': len(body), 'status': response.status,
                                'serverTiming': response.headers.get('Server-Timing')})
                return data
        except Exception as error:
            failures.append({'route': label, 'path': path, 'error': str(error)})
            return None
    # Popular, newly added and less-viewed songs: bounded selection, no random full-table sort.
    selections = []
    for sort, order in [('YoutubeViews','desc'), ('AdditionDate','desc'), ('YoutubeViews','asc')]:
        path = f'/api/songs/search?sort={sort}&order={order}&maxResults=8&start=0&onlyWithPVs=true&compact=true'
        data = fetch(*routes[0], path)
        if data:
            selections.extend(data['items'])
            payloads.append((routes[0][0], path, data['items']))
    ids = list(dict.fromkeys(song['id'] for song in selections))
    before = database_rows(ids)
    joined = ','.join(map(str, ids))
    seed = selections[0]['id']
    paths = [f'/api/songs/batch?ids={joined}', f'/api/songs/details?ids={joined}', f'/api/songs/views?ids={joined}',
             '/api/songs/search?query=wowaka&sort=FavoritedTimes&order=desc&maxResults=24&start=0&compact=true',
             f'/api/recommend/metadata?songId={seed}&count=12&offset=0&cards=true',
             f'/api/recommend/audio?songId={seed}&count=12&offset=0&cards=true']
    for label, base in routes:
        for path in paths:
            for iteration in range(repeats):
                data = fetch(label, base, path)
                if data is None:
                    continue
                if path.startswith('/api/songs/views'):
                    for identifier, views in data.items():
                        payloads.append((label, path, [{'id': int(identifier), **views}]))
                elif path.startswith(('/api/songs/batch','/api/songs/details')):
                    payloads.append((label, path, data['items']))
                    missing = sorted(set(ids) - {song['id'] for song in data['items']})
                    if missing: failures.append({'route': label, 'path': path, 'missingIds': missing})
                elif iteration == 0 and isinstance(data, dict):
                    # Include independently selected search/recommendation cards in the DB comparison.
                    cards = data.get('cards') or data.get('items', [])
                    payloads.append((label, path, [song for song in cards if 'id' in song]))
    all_ids = sorted(set(ids) | {song['id'] for _, _, songs in payloads for song in songs})
    after = database_rows(all_ids)
    differences, changed = [], []
    for label, path, songs in payloads:
        for song in songs:
            identifier = song['id']; row = after.get(identifier)
            if not row:
                failures.append({'route': label, 'id': identifier, 'error': 'Missing DB row'}); continue
            if identifier in before and before[identifier] != row:
                changed.append(identifier); continue
            if path.startswith('/api/songs/views'):
                diff = {key: {'expected': row[column], 'actual': song.get(key)} for key,column in
                        [('youtubeViews','youtube_views'),('nicoViews','nico_views')] if song.get(key) != row[column]}
            else:
                diff = compare_song(song, row)
            if diff: differences.append({'route': label, 'path': path, 'id': identifier, 'fields': diff})
    groups = {}
    for item in timings:
        key = item['route'] + ' ' + item['path'].split('?')[0]
        groups.setdefault(key, []).append(item['ms'])
    return {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sampleIds': ids,
            'comparedIds': all_ids, 'timings': timings, 'timingSummary': {key: {'n':len(values),
            'medianMs': statistics.median(values), 'maxMs':max(values)} for key,values in groups.items()},
            'differences': differences, 'changedDuringAudit': sorted(set(changed)), 'failures': failures}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = audit([('lan','http://127.0.0.1:5000'), ('public','https://diva-player.pages.dev/backend-api')])
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output: args.output.write_text(rendered, encoding='utf-8')
    print(rendered)
    raise SystemExit(1 if result['differences'] or result['failures'] else 0)


if __name__ == '__main__':
    main()
