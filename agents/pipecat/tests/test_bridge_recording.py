"""Tests for bridged-segment recording (docs/transfer-back-plan.md WP1.5).

sipbridge only: the monitor loop's stereo tap (L=caller, R=target) is written
to a RecordingSession keyed to the bridged call record whenever the original
call's effective recording is enabled and a monitored bridge exists.
"""

from __future__ import annotations

import asyncio

from pipecat_aplisay import api_client
from pipecat_aplisay.bridged_transfer import (
    BtaContext,
    bta_context_from_session,
    finalise_bridge_recorder,
    maybe_start_bridge_recorder,
)
from pipecat_aplisay.recording import RecordingSession


class _StubBridgedCall:
    id = "bridge-call-1"


def _ctx(**kw) -> BtaContext:
    defaults = dict(
        targets={},
        agent={"id": "a", "options": {}},
        instance={"id": "i"},
        parent_call_id="call-1",
        organisation_id="org-1",
        user_id="user-1",
        instance_id="i",
        caller_id="+441234567890",
        called_id="+441234567891",
        transcript="",
    )
    defaults.update(kw)
    return BtaContext(**defaults)


class _RecordingOpts:
    def __init__(self, enabled, key=None):
        self.enabled = enabled
        self.key = key


class _StubSession:
    """Minimal parent-session stand-in for bta_context_from_session."""

    def __init__(self):
        self.agent = {"id": "a", "options": {}}
        self.instance = {"id": "i", "streamLog": False}
        self.call = type(
            "C",
            (),
            {
                "id": "call-1",
                "organisationId": "org-1",
                "userId": "user-1",
                "instanceId": "i",
                "metadata": {"aplisay": {"callerId": "+44123", "calledId": "+44456"}},
            },
        )()

    def get_parent_transcript(self) -> str:
        return ""


class TestContextRecordingCapture:
    def test_recording_options_mapped(self):
        ctx = bta_context_from_session(
            _StubSession(), None, recording=_RecordingOpts(True, "client-key")
        )
        assert ctx.recording_enabled is True
        assert ctx.recording_key == "client-key"

    def test_no_recording_default(self):
        ctx = bta_context_from_session(_StubSession(), None)
        assert ctx.recording_enabled is False
        assert ctx.recording_key is None


class TestMaybeStartBridgeRecorder:
    def test_disabled_returns_none(self):
        ctx = _ctx(recording_enabled=False)
        ctx.bridged_call = _StubBridgedCall()
        assert asyncio.run(maybe_start_bridge_recorder(ctx)) is None

    def test_no_bridged_record_returns_none(self):
        ctx = _ctx(recording_enabled=True)
        assert asyncio.run(maybe_start_bridge_recorder(ctx)) is None

    def test_starts_and_accepts_audio(self):
        async def run():
            ctx = _ctx(recording_enabled=True)
            ctx.bridged_call = _StubBridgedCall()
            recorder = await maybe_start_bridge_recorder(ctx)
            assert isinstance(recorder, RecordingSession)
            await recorder.append_pcm(b"\x00\x01" * 320, 16000, 2)
            assert recorder._sink is not None
            assert recorder._sink.bytes_written == 640
            assert recorder._sink.sample_rate == 16000
            assert recorder._sink.num_channels == 2
            # Clean up the tempfile without invoking ffmpeg
            recorder._stopped = True
            recorder._sink.file.close()
            import os

            os.unlink(recorder._sink.path)

        asyncio.run(run())


class TestFinaliseBridgeRecorder:
    def test_uploads_and_stamps_recording_id(self, monkeypatch):
        async def run():
            stamped = {}

            async def fake_set(call_id, recording_id, encryption_key=None):
                stamped.update(
                    call_id=call_id,
                    recording_id=recording_id,
                    encryption_key=encryption_key,
                )

            monkeypatch.setattr(api_client, "set_call_recording_data", fake_set)

            class _Result:
                gcs_object = "recordings/bridge-call-1.ogg.enc"
                server_generated_key = "server-key"

            class _Recorder:
                async def stop_and_upload(self):
                    return _Result()

            ctx = _ctx()
            ctx.bridged_call = _StubBridgedCall()
            await finalise_bridge_recorder(_Recorder(), ctx)
            assert stamped == {
                "call_id": "bridge-call-1",
                "recording_id": "recordings/bridge-call-1.ogg.enc",
                "encryption_key": "server-key",
            }

        asyncio.run(run())

    def test_empty_recording_skips_stamp(self, monkeypatch):
        async def run():
            def boom(*_a, **_k):
                raise AssertionError("must not stamp an empty recording")

            monkeypatch.setattr(api_client, "set_call_recording_data", boom)

            class _Recorder:
                async def stop_and_upload(self):
                    return None

            ctx = _ctx()
            ctx.bridged_call = _StubBridgedCall()
            await finalise_bridge_recorder(_Recorder(), ctx)

        asyncio.run(run())

    def test_upload_failure_swallowed(self):
        async def run():
            class _Recorder:
                async def stop_and_upload(self):
                    raise RuntimeError("gcs down")

            ctx = _ctx()
            ctx.bridged_call = _StubBridgedCall()
            await finalise_bridge_recorder(_Recorder(), ctx)

        asyncio.run(run())

    def test_none_recorder_noop(self):
        asyncio.run(finalise_bridge_recorder(None, _ctx()))
