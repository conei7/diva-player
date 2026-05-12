"""
VocaDB API クライアント (レート制限付き)
"""
import time
import requests
from typing import Any

BASE_URL = 'https://vocadb.net/api'
DEFAULT_LANG = 'Japanese'
DEFAULT_FIELDS = 'PVs,Artists,Tags,WebLinks'
RATE_LIMIT_DELAY = 0.5   # 秒 (2 req/s)


def _get(path: str, params: dict[str, Any] | None = None) -> Any:
    url = f'{BASE_URL}{path}'
    defaults = {'lang': DEFAULT_LANG}
    if params:
        defaults.update(params)
    for attempt in range(3):
        try:
            resp = requests.get(url, params=defaults, timeout=30)
            if resp.status_code == 429:
                time.sleep(10)
                continue
            resp.raise_for_status()
            time.sleep(RATE_LIMIT_DELAY)
            return resp.json()
        except requests.RequestException as e:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def get_songs_page(start: int, max_results: int = 100, since_date: str | None = None) -> dict:
    params: dict[str, Any] = {
        'start': start,
        'maxResults': max_results,
        'fields': DEFAULT_FIELDS,
        'sort': 'AdditionDate',
        'onlyWithPVs': 'true',
        'getTotalCount': 'true',
    }
    if since_date:
        params['afterDate'] = since_date
    return _get('/songs', params)


def get_song(song_id: int) -> dict:
    return _get(f'/songs/{song_id}', {'fields': DEFAULT_FIELDS})


def get_tags_page(start: int, max_results: int = 200) -> dict:
    return _get('/tags', {
        'start': start,
        'maxResults': max_results,
        'fields': 'Parent',
        'getTotalCount': 'true',
    })
