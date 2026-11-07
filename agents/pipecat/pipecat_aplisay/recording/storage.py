"""Where recordings go — sibling of ``lib/recording/storage.js``.

``RECORDING_STORAGE_PATH`` picks the back end: ``gs://bucket[/prefix]``
(Google Cloud Storage), ``s3://bucket[/prefix]`` (S3 or an S3-compatible store,
with ``S3_ENDPOINT``, ``S3_REGION``, ``S3_ACCESS_KEY_ID``,
``S3_SECRET_ACCESS_KEY``, ``S3_FORCE_PATH_STYLE``) or ``file:///directory``.
Unset means recording is off, with the same compatibility default as the JS.
"""
from __future__ import annotations

import datetime
import hashlib
import hmac
import os
import urllib.parse
import urllib.request
from typing import Mapping, Optional


def recording_storage_config(env: Optional[Mapping[str, str]] = None) -> dict:
    env = os.environ if env is None else env
    configured = (env.get("RECORDING_STORAGE_PATH") or "").strip()
    if configured:
        backend = next((b for s, b in (("gs://", "gcs"), ("s3://", "s3"), ("file://", "file")) if configured.startswith(s)), None)
        if backend is None:
            return {"enabled": False, "reason": "RECORDING_STORAGE_PATH must start with gs://, s3:// or file://"}
        if backend == "s3":
            missing = [n for n in ("S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY") if not env.get(n)]
            if missing:
                return {"enabled": False, "backend": backend, "reason": "missing " + ", ".join(missing)}
        return {"enabled": True, "backend": backend, "base_url": configured}
    # Deployments made before RECORDING_STORAGE_PATH existed rely on this
    # default bucket, and they all have Google credentials.
    if _has_google_credentials(env):
        node_env = env.get("NODE_ENV") or "development"
        return {"enabled": True, "backend": "gcs", "base_url": f"gs://llm-voice/{node_env}-recordings", "legacy_default": True}
    return {"enabled": False, "reason": "RECORDING_STORAGE_PATH is unset"}


def _has_google_credentials(env: Mapping[str, str]) -> bool:
    if env.get("GOOGLE_APPLICATION_CREDENTIALS") or env.get("GOOGLE_CREDENTIAL") or env.get("K_SERVICE"):
        return True
    try:
        return os.path.getsize("credentials/google.json") > 0
    except OSError:
        return False


def parse_storage_path(base_url: str) -> tuple[str, str]:
    """Split ``gs://`` or ``s3://bucket[/prefix]`` into a bucket and a prefix ending in ``/`` (or empty)."""
    scheme, _, rest = base_url.partition("://")
    if scheme not in ("gs", "s3") or not rest:
        raise ValueError(f"not a bucket URL: {base_url}")
    bucket, _, prefix = rest.partition("/")
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    return bucket, prefix


def storage_location(config: dict) -> tuple[str, str]:
    """``(bucket or directory, prefix)`` for a configured store."""
    if config["backend"] == "file":
        return os.path.abspath(urllib.parse.urlparse(config["base_url"]).path), ""
    return parse_storage_path(config["base_url"])


def put_object(config: dict, object_name: str, payload: bytes, env: Optional[Mapping[str, str]] = None, timeout: float = 45.0) -> None:
    """Write one object to a ``file`` or ``s3`` store. GCS stays in upload.py."""
    env = os.environ if env is None else env
    if config["backend"] == "file":
        root, _ = storage_location(config)
        target = os.path.abspath(os.path.join(root, object_name))
        if not target.startswith(root + os.sep):
            raise ValueError(f"recording path outside the store: {object_name}")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(payload)
        return
    if config["backend"] == "s3":
        bucket, _ = storage_location(config)
        region = env.get("S3_REGION") or "us-east-1"
        endpoint = env.get("S3_ENDPOINT") or f"https://s3.{region}.amazonaws.com"
        path_style = (env.get("S3_FORCE_PATH_STYLE") or "").lower() != "false" if env.get("S3_FORCE_PATH_STYLE") else bool(env.get("S3_ENDPOINT"))
        parts = urllib.parse.urlsplit(endpoint)
        key = urllib.parse.quote(object_name, safe="/")
        if path_style:
            host, path = parts.netloc, f"{parts.path.rstrip('/')}/{bucket}/{key}"
        else:
            host, path = f"{bucket}.{parts.netloc}", f"/{key}"
        headers = sign_s3_request(
            "PUT", host, path, payload, region,
            env["S3_ACCESS_KEY_ID"], env["S3_SECRET_ACCESS_KEY"], env.get("S3_SESSION_TOKEN"),
        )
        request = urllib.request.Request(f"{parts.scheme}://{host}{path}", data=payload, method="PUT", headers=headers)
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status >= 300:
                raise RuntimeError(f"S3 PUT {object_name}: HTTP {response.status}")
        return
    raise ValueError(f"put_object does not handle {config['backend']}")


def sign_s3_request(method: str, host: str, path: str, payload: bytes, region: str, access_key: str,
                    secret_key: str, session_token: Optional[str] = None, headers: Optional[dict] = None,
                    now: Optional[datetime.datetime] = None) -> dict:
    """AWS Signature Version 4 headers for one S3 request with a hashed payload."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    day = amz_date[:8]
    all_headers = {k.lower(): str(v).strip() for k, v in (headers or {}).items()}
    all_headers.update({
        "host": host,
        "x-amz-content-sha256": hashlib.sha256(payload).hexdigest(),
        "x-amz-date": amz_date,
    })
    if session_token:
        all_headers["x-amz-security-token"] = session_token
    names = sorted(all_headers)
    canonical = "\n".join([
        method, path, "",
        *(f"{n}:{all_headers[n]}" for n in names), "",
        ";".join(names), all_headers["x-amz-content-sha256"],
    ])
    scope = f"{day}/{region}/s3/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])

    def _hmac(key: bytes, msg: str) -> bytes:
        return hmac.new(key, msg.encode(), hashlib.sha256).digest()

    signing_key = _hmac(_hmac(_hmac(_hmac(f"AWS4{secret_key}".encode(), day), region), "s3"), "aws4_request")
    signature = hmac.new(signing_key, to_sign.encode(), hashlib.sha256).hexdigest()
    out = {k: v for k, v in all_headers.items() if k != "host"}
    out["authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={';'.join(names)}, Signature={signature}"
    )
    return out
