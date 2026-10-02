#!/usr/bin/env python3
"""Compare the actual old/new ranking history SQL; only session-local test tables are written."""
import argparse
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'backend/api/VocadbRecommender/Services/DbService.cs'


def history_prefix(source):
    method = source.index('private async Task<string> ExecuteTrendingSongsJsonAsync(')
    start = source.index('WITH latest_watermark AS (', method)
    end = source.index('            latest AS (', start)
    return source[start:end].rstrip().removesuffix(',')


def signatures(prefix):
    return prefix + """
        SELECT COUNT(*) AS rows,
               SUM(hashtextextended(ROW(song_id, recorded_at, youtube_views, nico_views,
                   normal_baseline_at, fallback_baseline_at, fallback_youtube_views,
                   fallback_nico_views)::text, 0)::numeric) AS checksum
        FROM history_windows
    """


def run_psql(sql, args):
    command = ['docker', 'exec', '-i', args.container, 'psql', '-X', '-q', '-A', '-t',
               '-v', 'ON_ERROR_STOP=1', '-U', 'vocadb', '-d', 'vocadb_recommender']
    result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=210, check=True)
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-ref', default='a3b2281')
    parser.add_argument('--container', default='vocadb_postgres')
    parser.add_argument('--benchmark', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    original = subprocess.check_output(['git', '-C', str(ROOT), 'show', args.baseline_ref + ':' + SOURCE], text=True)
    candidate = (ROOT / SOURCE).read_text()
    old, new = history_prefix(original), history_prefix(candidate)
    assert 'history_observation_groups AS MATERIALIZED' in old
    assert 'history_observation_groups AS NOT MATERIALIZED' in new
    assert new.count('FROM history_observation_groups h') == 1

    if not args.benchmark:
        # Independent observations, genuine zeros, regressions, equal times,
        # short/missing baselines and the 21-day cutoff must remain identical.
        fixture = """
        CREATE TEMP TABLE view_history (
            id bigint, song_id integer, recorded_at timestamptz,
            youtube_views bigint, nico_views bigint,
            youtube_observed boolean, nico_observed boolean);
        INSERT INTO view_history VALUES
            (1,1,'2026-09-10',99999,99999,true,true),
            (2,1,'2026-09-12',0,100,true,true),
            (3,1,'2026-09-22',100,999999,true,false),
            (4,1,'2026-09-22',150,120,true,true),
            (5,1,'2026-09-25',90,999999,true,false),
            (6,1,'2026-10-02',300,180,true,true),
            (7,2,'2026-09-22',999999,0,false,true),
            (8,2,'2026-09-29',200,999999,true,false),
            (9,2,'2026-10-02',999999,20,false,true),
            (10,3,'2026-10-02',0,0,true,true),
            (11,4,'2026-09-27',100,100,true,true),
            (12,4,'2026-10-02',150,110,true,true);
        """
        sql = fixture + f"""
        CREATE TEMP TABLE original_rows AS {old} SELECT * FROM history_windows;
        CREATE TEMP TABLE candidate_rows AS {new} SELECT * FROM history_windows;
        SELECT json_build_object('originalRows', (SELECT count(*) FROM original_rows),
            'differences', (SELECT count(*) FROM (
                (SELECT * FROM original_rows EXCEPT ALL SELECT * FROM candidate_rows)
                UNION ALL
                (SELECT * FROM candidate_rows EXCEPT ALL SELECT * FROM original_rows)
            ) differences));
        """
        result = json.loads(run_psql(sql, args))
        assert result['originalRows'] == 11 and result['differences'] == 0, result
    else:
        # One read-only production snapshot, one execution per variant. No
        # statistics reset, persistent data write, work_mem change or writer stop.
        sql = """
        CREATE TEMP TABLE original_signature (rows bigint, checksum numeric);
        CREATE TEMP TABLE candidate_signature (rows bigint, checksum numeric);
        BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
        SET LOCAL statement_timeout = '90s';
        """
        for name, prefix in [('original', old), ('candidate', new)]:
            sql += f"""
            EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)
                INSERT INTO {name}_signature {signatures(prefix)};
            SELECT row_to_json(s) FROM {name}_signature s;
            """
        sql += 'ROLLBACK;'
        output = run_psql(sql, args)
        decoder = json.JSONDecoder()
        objects = []
        while output.strip():
            value, end = decoder.raw_decode(output.lstrip())
            objects.append(value)
            output = output.lstrip()[end:]
        old_plan, old_signature, new_plan, new_signature = objects
        assert old_signature == new_signature, (old_signature, new_signature)
        def stats(plan):
            return {'executionMs': plan[0]['Execution Time'],
                    'tempWrittenBlocks': plan[0]['Plan'].get('Temp Written Blocks', 0),
                    'tempReadBlocks': plan[0]['Plan'].get('Temp Read Blocks', 0)}
        result = {'signature': old_signature, 'original': stats(old_plan), 'candidate': stats(new_plan),
                  'plans': {'original': old_plan, 'candidate': new_plan}}
        assert result['candidate']['tempWrittenBlocks'] < result['original']['tempWrittenBlocks'], result
    result.update(status='success', baselineRef=args.baseline_ref)
    if args.output:
        args.output.write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items() if k != 'plans'}))


if __name__ == '__main__':
    main()
