"""Portable ``options.tts.speed``: a multiplier on the vendor's normal speaking
rate (1.2 = 20% faster, 0.9 = 10% slower). 1, or unset, sends nothing, so the
vendor's own default survives. See docs/tts-speed.md.

Each vendor accepts a narrower range than the API does, so the value is clamped
to the vendor's range here rather than refused at call time. Same table as
agents/livekit/lib/tts-speed.ts.
"""

from __future__ import annotations

import math
import os
import uuid
from typing import Any, Optional

from loguru import logger

from .http_client import get_client

#: [min, max] per vendor, as documented by the vendor.
TTS_SPEED_RANGES: dict[str, tuple[float, float]] = {
    "elevenlabs": (0.7, 1.2),
    "cartesia": (0.6, 1.5),
    "deepgram": (0.7, 1.5),
    "neuphonic": (0.7, 1.5),
    "openai": (0.25, 1.5),
    "xai": (0.7, 1.5),
}

#: Ultravox provider -> (voiceOverrides key, range, body builder). Same table as
#: ``ultravoxSpeedOverrides`` in lib/tts-speed.js and the LiveKit plugin's voice_speed.ts.
_ULTRAVOX_SPEED_FIELDS: dict[str, tuple[str, tuple[float, float], Any]] = {
    "eleven_labs": ("elevenLabs", (0.7, 1.2), lambda s: {"speed": s}),
    "cartesia": ("cartesia", (0.6, 1.5), lambda s: {"generationConfig": {"speed": s}}),
    "lmnt": ("lmnt", (0.25, 2.0), lambda s: {"speed": s}),
    "google": ("google", (0.25, 2.0), lambda s: {"speakingRate": s}),
    "inworld": ("inworld", (0.5, 1.5), lambda s: {"speakingRate": s}),
}

ULTRAVOX_API_BASE = "https://api.ultravox.ai/api"

#: Voice id or name -> provider. A voice's provider does not change, so this lives for the process.
_ultravox_voice_providers: dict[str, Optional[str]] = {}


def requested_tts_speed(agent: dict) -> Optional[float]:
    """The requested multiplier, or None when it is unset, 1, or not a positive number."""
    speed = ((agent.get("options") or {}).get("tts") or {}).get("speed")
    if isinstance(speed, bool) or not isinstance(speed, (int, float)):
        return None
    if not math.isfinite(speed) or speed <= 0 or speed == 1:
        return None
    return float(speed)


def _clamp(speed: float, bounds: tuple[float, float]) -> float:
    return min(bounds[1], max(bounds[0], speed))


def tts_speed_for(agent: dict, vendor: str) -> Optional[float]:
    """The requested speed clamped to ``vendor``'s range, or None when there is none to send."""
    speed = requested_tts_speed(agent)
    if speed is None:
        return None
    bounds = TTS_SPEED_RANGES.get(vendor)
    if bounds is None:
        warn_tts_speed_unsupported(agent, vendor)
        return None
    clamped = _clamp(speed, bounds)
    if clamped != speed:
        logger.bind(vendor=vendor, speed=speed, clamped=clamped).warning(
            "options.tts.speed outside the vendor's range; clamped"
        )
    return clamped


def warn_tts_speed_unsupported(agent: dict, where: str) -> None:
    """Log that a speed was asked for but this path cannot send it."""
    speed = requested_tts_speed(agent)
    if speed is not None:
        logger.bind(where=where, speed=speed).warning(
            "options.tts.speed ignored: not supported here"
        )


def ultravox_speed_overrides(provider: Optional[str], speed: float) -> Optional[dict]:
    """``voiceOverrides`` for ``speed`` on a voice backed by ``provider``, or None
    when that provider has no speed field."""
    field = _ULTRAVOX_SPEED_FIELDS.get((provider or "").lower())
    if field is None:
        return None
    key, bounds, build = field
    return {key: build(_clamp(speed, bounds))}


async def ultravox_voice_provider(voice: str, api_key: str) -> Optional[str]:
    """The TTS provider behind an Ultravox voice given by id or name, or None
    when the voice is not found."""
    if voice in _ultravox_voice_providers:
        return _ultravox_voice_providers[voice]
    headers = {"X-API-Key": api_key}
    found: Optional[dict] = None
    client = await get_client("ultravox")
    try:
        uuid.UUID(voice)
        is_id = True
    except ValueError:
        is_id = False
    if is_id:
        resp = await client.get(f"{ULTRAVOX_API_BASE}/voices/{voice}", headers=headers, timeout=5)
        if resp.status_code == 200:
            found = resp.json()
        elif resp.status_code != 404:
            resp.raise_for_status()
    else:
        resp = await client.get(
            f"{ULTRAVOX_API_BASE}/voices",
            headers=headers,
            params={"search": voice, "pageSize": "100"},
            timeout=5,
        )
        resp.raise_for_status()
        wanted = voice.lower()
        results = resp.json().get("results") or []
        found = next((v for v in results if str(v.get("name", "")).lower() == wanted), None)
    provider = (found or {}).get("provider") or None
    _ultravox_voice_providers[voice] = provider
    return provider


async def ultravox_speed_extra(agent: dict, voice: Optional[str]) -> dict:
    """The ``voiceOverrides`` entry for the Ultravox /calls body, or ``{}``.

    A native ``vendorSpecific.ultravox.voiceOverrides`` wins. A failed lookup
    costs the speed, never the call.
    """
    native = (((agent.get("options") or {}).get("vendorSpecific") or {}).get("ultravox") or {}).get(
        "voiceOverrides"
    )
    if isinstance(native, dict):
        return {"voiceOverrides": native}
    speed = requested_tts_speed(agent)
    if speed is None:
        return {}
    log = logger.bind(voice=voice, speed=speed)
    if not voice:
        log.warning("options.tts.speed ignored: Ultravox needs an explicit voice to place it")
        return {}
    try:
        provider = await ultravox_voice_provider(str(voice), os.environ.get("ULTRAVOX_API_KEY", ""))
    except Exception as e:  # noqa: BLE001
        log.warning(f"options.tts.speed ignored: Ultravox voice lookup failed: {e}")
        return {}
    overrides = ultravox_speed_overrides(provider, speed)
    if overrides is None:
        log.bind(provider=provider).warning(
            "options.tts.speed ignored: this Ultravox voice has no speed control"
        )
        return {}
    return {"voiceOverrides": overrides}
