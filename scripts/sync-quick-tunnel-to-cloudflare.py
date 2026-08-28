#!/usr/bin/env python3
"""Register a Quick Tunnel origin without exposing credentials in argv/env."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
from urllib import error, parse, request


QUICK_TUNNEL_PATTERN = re.compile(
    r"^https://[a-z0-9-]+\.trycloudflare\.com$", re.IGNORECASE
)
SYNC_HOST = "diva-player.pages.dev"
SYNC_PATH = "/tunnel-admin/update"
MAX_ENV_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 64 * 1024
RETRY_DELAYS_SECONDS = (5, 10, 15, 20, 25, 30, 30, 30)
RETRYABLE_HTTP_CODES = frozenset({424, 429, 500, 502, 503, 504})


class SyncError(RuntimeError):
    """Expected, safely reportable sync failure."""


class NoRedirectHandler(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _parse_value(raw: str, key: str, line_number: int) -> str:
    raw = raw.strip()
    if raw.startswith('"'):
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise SyncError(f"invalid quoted {key} on line {line_number}") from exc
        if not isinstance(value, str):
            raise SyncError(f"invalid quoted {key} on line {line_number}")
        return value
    if raw.startswith("'"):
        if len(raw) < 2 or not raw.endswith("'"):
            raise SyncError(f"invalid quoted {key} on line {line_number}")
        return raw[1:-1]
    return re.split(r"[ \t]+#", raw, maxsplit=1)[0].rstrip()


def load_environment(path: Path) -> dict[str, str]:
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise SyncError("Cloudflare environment file is unavailable") from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise SyncError("Cloudflare environment must be a regular non-symlink file")
    if metadata.st_size > MAX_ENV_BYTES:
        raise SyncError("Cloudflare environment file is unexpectedly large")
    if os.name == "posix":
        if metadata.st_uid != os.geteuid():
            raise SyncError("Cloudflare environment must be owned by the service caller")
        if stat.S_IMODE(metadata.st_mode) & 0o077:
            raise SyncError("Cloudflare environment must not be accessible by group/other")

    wanted = {"PAGES_SYNC_TOKEN", "PAGES_ORIGIN_PROOF_KEY", "PAGES_SYNC_URL"}
    values: dict[str, str] = {}
    try:
        contents = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise SyncError("Cloudflare environment could not be read as UTF-8") from exc
    for line_number, line in enumerate(contents.splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.fullmatch(
            r"(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)", line
        )
        if not match:
            continue
        key, raw = match.groups()
        if key not in wanted:
            continue
        if key in values:
            raise SyncError(f"duplicate {key} in Cloudflare environment")
        value = _parse_value(raw, key, line_number)
        if any(character in value for character in ("\x00", "\r", "\n")):
            raise SyncError(f"invalid control character in {key}")
        values[key] = value

    for required in ("PAGES_SYNC_TOKEN", "PAGES_ORIGIN_PROOF_KEY"):
        if not values.get(required):
            raise SyncError(f"missing required Cloudflare environment key: {required}")
    if len(values["PAGES_ORIGIN_PROOF_KEY"]) < 32:
        raise SyncError("PAGES_ORIGIN_PROOF_KEY is unexpectedly short")
    values.setdefault(
        "PAGES_SYNC_URL", f"https://{SYNC_HOST}{SYNC_PATH}"
    )
    return values


def validate_sync_url(value: str) -> str:
    parsed = parse.urlsplit(value)
    try:
        port = parsed.port
    except ValueError as exc:
        raise SyncError("PAGES_SYNC_URL has an invalid port") from exc
    if (
        parsed.scheme != "https"
        or parsed.hostname != SYNC_HOST
        or port not in (None, 443)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != SYNC_PATH
        or parsed.query
        or parsed.fragment
    ):
        raise SyncError("PAGES_SYNC_URL is outside the fixed Pages update endpoint")
    return value


def build_payload(
    proof_key: str, tunnel_url: str, origin_role: str, timestamp: int
) -> tuple[bytes, str]:
    message = f"{timestamp}\n{origin_role}\n{tunnel_url}".encode()
    proof = hmac.new(proof_key.encode(), message, hashlib.sha256).hexdigest()
    payload = json.dumps(
        {
            "tunnelUrl": tunnel_url,
            "originRole": origin_role,
            "timestamp": timestamp,
            "proof": proof,
        },
        separators=(",", ":"),
    ).encode()
    return payload, proof


def post_update(
    sync_url: str,
    token: str,
    proof_key: str,
    tunnel_url: str,
    origin_role: str,
) -> None:
    opener = request.build_opener(NoRedirectHandler())
    body = b""
    status_code = 0
    for attempt in range(len(RETRY_DELAYS_SECONDS) + 1):
        # A proof is accepted for only five minutes. Refresh it on every
        # attempt so a slow Quick Tunnel DNS rollout never makes later retries
        # fail authentication with a stale timestamp.
        payload, _ = build_payload(
            proof_key,
            tunnel_url,
            origin_role,
            int(time.time()),
        )
        update_request = request.Request(
            sync_url,
            data=payload,
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "User-Agent": "diva-player-origin-sync/1",
            },
        )
        try:
            with opener.open(update_request, timeout=20) as response:
                body = response.read(MAX_RESPONSE_BYTES + 1)
                status_code = response.status
            break
        except error.HTTPError as exc:
            if exc.code not in RETRYABLE_HTTP_CODES or attempt >= len(RETRY_DELAYS_SECONDS):
                raise SyncError(f"Pages origin update returned HTTP {exc.code}") from exc
        except (error.URLError, TimeoutError, OSError) as exc:
            if attempt >= len(RETRY_DELAYS_SECONDS):
                raise SyncError("Pages origin update request failed") from exc
        time.sleep(RETRY_DELAYS_SECONDS[attempt])
    if status_code != 200 or len(body) > MAX_RESPONSE_BYTES:
        raise SyncError("Pages origin update returned an invalid response")
    try:
        result = json.loads(body)
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise SyncError("Pages origin update returned invalid JSON") from exc
    if result.get("success") is not True or result.get("originRole") != origin_role:
        raise SyncError("Pages origin update did not confirm the requested role")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--tunnel-url", required=True)
    parser.add_argument("--origin-role", required=True, choices=("primary", "standby"))
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if not QUICK_TUNNEL_PATTERN.fullmatch(args.tunnel_url):
            raise SyncError("Quick Tunnel URL is invalid")
        environment = load_environment(args.env_file)
        sync_url = validate_sync_url(environment["PAGES_SYNC_URL"])
        _, proof = build_payload(
            environment["PAGES_ORIGIN_PROOF_KEY"],
            args.tunnel_url,
            args.origin_role,
            int(time.time()),
        )
        if args.dry_run:
            print(
                json.dumps(
                    {
                        "validated": True,
                        "originRole": args.origin_role,
                        "tunnelUrl": args.tunnel_url,
                        "proofLength": len(proof),
                    },
                    separators=(",", ":"),
                )
            )
            return 0
        post_update(
            sync_url,
            environment["PAGES_SYNC_TOKEN"],
            environment["PAGES_ORIGIN_PROOF_KEY"],
            args.tunnel_url,
            args.origin_role,
        )
        print(f"Cloudflare Pages {args.origin_role} origin updated")
        return 0
    except SyncError as exc:
        print(f"Cloudflare origin sync failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
