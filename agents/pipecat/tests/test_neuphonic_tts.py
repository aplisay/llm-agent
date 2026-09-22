"""Neuphonic TTS on the Pipecat worker (docs/neuphonic.md): the service build_tts_service makes, what it
puts on the websocket URL, and the realtime, usage and fallback paths that reuse it."""

from __future__ import annotations

import asyncio
import base64
import json
from urllib.parse import parse_qs, urlsplit

import numpy as np
import pytest
from pipecat.transcriptions.language import Language

from pipecat_aplisay.fallback_message import ResolvedFallbackMessage
from pipecat_aplisay.fixed_message import _build_message_tts
from pipecat_aplisay.neuphonic_tts import (
    SILENCE_MARGIN_MS,
    SILENCE_THRESHOLD,
    AplisayNeuphonicTTSService,
    LeadingSilenceTrimmer,
)
from pipecat_aplisay.realtime_tts import external_tts_enabled, text_output_enabled
from pipecat_aplisay.usage import usage_vendors
from pipecat_aplisay.voice_session import NEUPHONIC_SAMPLE_RATE, build_tts_service

VOICE = "fc854436-2dac-4d21-aa69-ae17b54e98eb"


def _agent(stt=None, tts=None) -> dict:
    options: dict = {}
    if stt is not None:
        options["stt"] = stt
    if tts is not None:
        options["tts"] = tts
    return {"options": options}


@pytest.fixture
def neuphonic_key(monkeypatch):
    monkeypatch.setenv("NEUPHONIC_API_KEY", "test-key")


def _socket_url(tts) -> tuple[str, dict, dict]:
    """The URL, query and headers the service opens its websocket with, without a network."""
    seen: dict = {}

    async def fake_connect(url, **kwargs):
        seen["url"] = url
        seen["headers"] = kwargs.get("additional_headers") or {}
        raise ConnectionError("not connecting in tests")

    tts._websocket_connect = fake_connect

    async def push_error(**_kwargs):
        return None

    tts.push_error = push_error
    asyncio.run(tts._connect_websocket())
    parts = urlsplit(seen["url"])
    return parts.path, {k: v[0] for k, v in parse_qs(parts.query).items()}, seen["headers"]


def test_builds_the_service_with_voice_language_and_a_16k_rate(neuphonic_key):
    tts = build_tts_service(_agent(tts={"vendor": "neuphonic", "voice": VOICE, "language": "de-DE"}))
    assert isinstance(tts, AplisayNeuphonicTTSService)
    assert tts._settings.voice == VOICE
    assert tts._settings.language == "de"
    assert NEUPHONIC_SAMPLE_RATE == 16000
    assert tts._sampling_rate == 16000


def test_the_socket_asks_for_the_rate_the_frames_are_tagged_with(neuphonic_key):
    tts = build_tts_service(_agent(tts={"vendor": "neuphonic", "voice": VOICE, "language": "en-GB"}))
    path, query, headers = _socket_url(tts)
    assert path == "/speak/en"
    assert query["lang_code"] == "en"
    assert query["sampling_rate"] == "16000"
    assert query["encoding"] == "pcm_linear"
    assert query["voice_id"] == VOICE
    assert headers == {"x-api-key": "test-key"}


def test_hindi_goes_out_lowercase(neuphonic_key):
    # Pipecat 1.10 maps Language.HI to "HI"; Neuphonic accepts it but does not speak Hindi.
    tts = build_tts_service(_agent(tts={"vendor": "neuphonic", "voice": VOICE, "language": "hi-IN"}))
    assert tts._settings.language == "hi"
    path, query, _ = _socket_url(tts)
    assert (path, query["lang_code"]) == ("/speak/hi", "hi")
    assert tts.language_to_service_language(Language.HI) == "hi"


@pytest.mark.parametrize(
    ("tag", "code"),
    [("pt-BR", "pt"), ("zh-CN", "zh"), ("es-VE", "es"), ("ar-EG", "ar"), ("en-IE", "en"), ("mt-MT", "mt")],
)
def test_regional_tags_become_base_codes(neuphonic_key, tag, code):
    tts = build_tts_service(_agent(tts={"vendor": "neuphonic", "voice": VOICE, "language": tag}))
    assert tts._settings.language == code


def test_language_falls_back_to_the_stt_language_then_english(neuphonic_key):
    assert build_tts_service(_agent(stt={"language": "fr-FR"}, tts={"vendor": "neuphonic"}))._settings.language == "fr"
    assert build_tts_service(_agent(tts={"vendor": "neuphonic"}))._settings.language == "en"


def test_no_voice_leaves_the_choice_to_neuphonic(neuphonic_key):
    tts = build_tts_service(_agent(tts={"vendor": "neuphonic", "language": "es-ES"}))
    assert tts._settings.voice is None
    _, query, _ = _socket_url(tts)
    assert "voice_id" not in query


def test_vendor_scoping_and_case_are_ignored(neuphonic_key):
    tts = build_tts_service(_agent(tts={"vendor": "Neuphonic/any-model", "voice": VOICE}))
    assert isinstance(tts, AplisayNeuphonicTTSService)


def test_a_missing_key_names_the_variable(monkeypatch):
    monkeypatch.delenv("NEUPHONIC_API_KEY", raising=False)
    with pytest.raises(KeyError, match="NEUPHONIC_API_KEY"):
        build_tts_service(_agent(tts={"vendor": "neuphonic", "voice": VOICE}))


def test_transcript_tts_uses_the_same_service(neuphonic_key):
    tts = build_tts_service(_agent(tts={"vendor": "neuphonic", "voice": VOICE}), transcript_tts=True)
    assert type(tts) is AplisayNeuphonicTTSService


def test_an_external_tts_on_the_text_output_rows():
    agent = _agent(tts={"vendor": "neuphonic", "voice": VOICE})
    for model_id in ("ultravox/ultravox-v0.7", "openai/gpt-realtime"):
        assert text_output_enabled(agent, model_id)
        assert external_tts_enabled(agent, model_id)
    assert not external_tts_enabled(agent, "google/gemini-2.0-flash-exp")
    assert not external_tts_enabled(agent, "xai/grok-voice-think-fast-2.0")


def test_usage_is_billed_to_neuphonic():
    agent = _agent(tts={"vendor": "neuphonic", "voice": VOICE})
    assert usage_vendors(agent, "pipecat:openai/gpt-4o-mini")["tts"]["vendor"] == "neuphonic"
    assert usage_vendors(agent, "pipecat:ultravox/ultravox-v0.7")["tts"]["vendor"] == "neuphonic"


def test_the_fallback_message_can_be_spoken_by_neuphonic(neuphonic_key):
    resolved = ResolvedFallbackMessage(text="Sorry, we cannot take your call.", vendor="neuphonic", voice=VOICE, language="en-GB")
    tts = _build_message_tts(_agent(), resolved)
    assert isinstance(tts, AplisayNeuphonicTTSService)
    assert (tts._settings.voice, tts._settings.language) == (VOICE, "en")


RATE = NEUPHONIC_SAMPLE_RATE
#: Samples kept before the first loud one.
MARGIN = RATE * SILENCE_MARGIN_MS // 1000


def _pcm(values) -> bytes:
    return np.asarray(values, dtype="<i2").tobytes()


def _silence(ms: int) -> bytes:
    return bytes(2 * (RATE * ms // 1000))


def _speech(seed: int, ms: int = 100) -> bytes:
    """Distinct samples that start loud, so a comparison shows what moved."""
    i = np.arange(RATE * ms // 1000)
    return _pcm((i * 7 + seed * 131) % 2000 - 1000)


def _hiss(samples: int) -> list[int]:
    return [SILENCE_THRESHOLD if i % 2 else -SILENCE_THRESHOLD for i in range(samples)]


def _utterance() -> tuple[bytes, int]:
    """400 ms of hiss at the threshold, a soft onset whose first sample over the threshold is
    negative, 300 ms of silence, then more speech; and the index of that first sample."""
    lead = _hiss(6400)
    soft = [40, -80, 120, -160, 200, -(SILENCE_THRESHOLD + 1), 3000, -3000]
    loud = [5000 if i % 2 else -5000 for i in range(1600)]
    return _pcm(lead + soft + [0] * 4800 + loud), len(lead) + 5


def _split(audio: bytes, *sizes: int) -> list[bytes]:
    """``audio`` in chunks of the given sizes, the last size repeating."""
    chunks, at = [], 0
    while at < len(audio):
        n = sizes[min(len(chunks), len(sizes) - 1)]
        chunks.append(audio[at : at + n])
        at += n
    return chunks


def _trimmed(chunks) -> bytes:
    trimmer = LeadingSilenceTrimmer(RATE)
    return b"".join(trimmer.push(c) for c in chunks) + trimmer.end()


def _same_samples(actual: bytes, expected: bytes) -> None:
    # Compared as arrays: when == fails on long byte strings, pytest builds a very large diff.
    got, want = np.frombuffer(actual, dtype="<i2"), np.frombuffer(expected, dtype="<i2")
    assert got.size == want.size
    differ = np.flatnonzero(got != want)
    assert differ.size == 0, f"{differ.size} samples differ, the first at {differ[:1]}"


def test_the_trim_keeps_50_ms_before_the_first_loud_sample_and_all_that_follows():
    audio, onset = _utterance()
    _same_samples(_trimmed(_split(audio, 3200)), audio[2 * (onset - MARGIN) :])


@pytest.mark.parametrize("sizes", [(1,), (3,), (12801, 1, 3200), (10**6,)])
def test_a_chunk_boundary_inside_a_sample_does_not_move_the_cut(sizes):
    audio, onset = _utterance()
    _same_samples(_trimmed(_split(audio, *sizes)), audio[2 * (onset - MARGIN) :])


def test_audio_that_starts_loud_gets_loud_within_the_margin_or_never_gets_loud_passes_whole():
    _same_samples(_trimmed(_split(_speech(1), 1000)), _speech(1))
    early = _silence(30) + _speech(1)
    _same_samples(_trimmed(_split(early, 1000)), early)
    quiet = _pcm(_hiss(RATE))
    _same_samples(_trimmed(_split(quiet, 3200)), quiet)
    assert _trimmed([]) == b""


def test_end_starts_afresh_for_the_next_utterance():
    trimmer = LeadingSilenceTrimmer(RATE)
    first = trimmer.push(_silence(300) + _speech(1)) + trimmer.push(_silence(200)) + trimmer.end()
    second = trimmer.push(_silence(500)) + trimmer.push(_speech(2)) + trimmer.end()
    _same_samples(first, _silence(300)[-2 * MARGIN :] + _speech(1) + _silence(200))
    _same_samples(second, _silence(500)[-2 * MARGIN :] + _speech(2))


class _Socket:
    """Stands in for the websocket: yields ``messages``, then closes."""

    def __init__(self, messages):
        self._messages = messages

    async def __aiter__(self):
        for message in self._messages:
            yield message


def _message(audio: bytes = b"", stop: bool = False) -> str:
    data = {"text": "Some text.", "sampling_rate": str(RATE), "stop": stop, "context_id": None}
    if audio:
        data["audio"] = base64.b64encode(audio).decode()
    return json.dumps({"data": data})


def test_the_service_trims_each_utterance_and_keeps_the_pauses_inside_it(neuphonic_key):
    tts = build_tts_service(_agent(tts={"vendor": "neuphonic", "voice": VOICE}))
    # setup() sets the rate in a pipeline.
    tts._sample_rate = RATE
    frames = []

    async def append(context_id, frame):
        frames.append((context_id, frame))

    tts.append_to_audio_context = append
    tts.get_active_audio_context_id = lambda: "turn-1"
    tts._websocket = _Socket(
        [
            _message(_silence(400)),
            _message(_speech(1)),
            _message(),
            _message(_silence(100)),
            _message(_speech(2) + _silence(200), stop=True),
            _message(_silence(250) + _speech(3)),
            _message(_silence(50), stop=True),
            # An utterance that never gets loud is sent whole at its end.
            _message(_pcm(_hiss(1600)), stop=True),
        ]
    )
    asyncio.run(tts._receive_messages())

    assert {context_id for context_id, _ in frames} == {"turn-1"}
    assert all((f.sample_rate, f.num_channels) == (RATE, 1) for _, f in frames)
    expected = (
        _silence(400)[-2 * MARGIN :] + _speech(1) + _silence(100) + _speech(2) + _silence(200)
        + _silence(250)[-2 * MARGIN :] + _speech(3) + _silence(50)
        + _pcm(_hiss(1600))
    )
    _same_samples(b"".join(f.audio for _, f in frames), expected)
