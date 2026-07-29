"""RTVI tool-call events sent to browser clients carry name, arguments and result.

The tests check the RTVI messages the observer sends, not just the params.
"""

from __future__ import annotations

import asyncio

from pipecat.frames.frames import (
    FunctionCallInProgressFrame,
    FunctionCallResultFrame,
)
from pipecat.observers.base_observer import FramePushed
from pipecat.processors.frame_processor import FrameDirection
from pipecat.processors.frameworks.rtvi.observer import (
    RTVIFunctionCallReportLevel,
    RTVIObserver,
)

from pipecat_aplisay.voice_session import _rtvi_observer_params


async def _emitted(observer: RTVIObserver, frames: list) -> list:
    """Push ``frames`` through ``observer`` and return the RTVI messages it sent."""
    sent: list = []

    async def capture(message):
        sent.append(message)

    observer.send_rtvi_message = capture

    for frame in frames:
        await observer.on_push_frame(
            FramePushed(
                source=None,
                destination=None,
                frame=frame,
                direction=FrameDirection.DOWNSTREAM,
                timestamp=0,
            )
        )
    return sent


TOOL_FRAMES = [
    FunctionCallInProgressFrame(
        function_name="lookup_order",
        tool_call_id="call_1",
        arguments={"order_id": "A-42"},
    ),
    FunctionCallResultFrame(
        function_name="lookup_order",
        tool_call_id="call_1",
        arguments={"order_id": "A-42"},
        result='{"status":"shipped"}',
    ),
]


def test_report_level_is_full_for_every_function():
    """The ``"*"`` catch-all applies to tools the observer has never seen."""
    observer = RTVIObserver(params=_rtvi_observer_params())
    assert (
        observer._get_function_call_report_level("some_unregistered_tool")
        == RTVIFunctionCallReportLevel.FULL
    )


def test_tool_call_events_carry_name_arguments_and_result():
    """The events a browser client receives are fully populated."""
    observer = RTVIObserver(params=_rtvi_observer_params())
    in_progress, stopped = asyncio.run(_emitted(observer, TOOL_FRAMES))

    assert in_progress.type == "llm-function-call-in-progress"
    assert in_progress.data.tool_call_id == "call_1"
    assert in_progress.data.function_name == "lookup_order"
    assert in_progress.data.arguments == {"order_id": "A-42"}

    assert stopped.type == "llm-function-call-stopped"
    assert stopped.data.tool_call_id == "call_1"
    assert stopped.data.function_name == "lookup_order"
    assert stopped.data.result == '{"status":"shipped"}'


def test_pipecat_default_would_strip_the_detail():
    """If a pipecat upgrade makes FULL the default, this fails and the override can go."""
    in_progress, stopped = asyncio.run(_emitted(RTVIObserver(), TOOL_FRAMES))

    assert in_progress.data.function_name is None
    assert in_progress.data.arguments is None
    assert stopped.data.function_name is None
    assert stopped.data.result is None
