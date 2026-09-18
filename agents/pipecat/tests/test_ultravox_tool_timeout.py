"""Stamp an explicit tool timeout so healthy calls slower than Ultravox's default are not discarded and retried. See
PR #176."""

from __future__ import annotations

import pytest

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema

pytest.importorskip("pipecat.services.ultravox.llm")

from pipecat_aplisay.ultravox_compat import (  # noqa: E402
    ULTRAVOX_TOOL_TIMEOUT,
    AplisayUltravoxRealtimeLLMService,
)


def _schema(names: list[str]) -> ToolsSchema:
    return ToolsSchema(
        standard_tools=[
            FunctionSchema(name=n, description="d", properties={"a": {"type": "string"}}, required=["a"])
            for n in names
        ]
    )


def _service() -> AplisayUltravoxRealtimeLLMService:
    # _to_selected_tools is stateless (reads only its argument), so a no-init
    # instance exercises the real inherited + overridden code path.
    return object.__new__(AplisayUltravoxRealtimeLLMService)


def test_every_temporary_tool_gets_the_explicit_timeout():
    selected = _service()._to_selected_tools(_schema(["booking_book", "booking_get_slots"]))
    assert len(selected) == 2
    for entry in selected:
        assert entry["temporaryTool"]["timeout"] == ULTRAVOX_TOOL_TIMEOUT


def test_upstream_fields_survive_untouched():
    (entry,) = _service()._to_selected_tools(_schema(["booking_book"]))
    tool = entry["temporaryTool"]
    assert tool["modelToolName"] == "booking_book"
    assert tool["client"] == {}
    (param,) = tool["dynamicParameters"]
    assert param["name"] == "a" and param["required"] is True


def test_timeout_is_within_ultravox_bounds():
    # Duration-string form, above the 2.5s default, at or below the 40s max.
    assert ULTRAVOX_TOOL_TIMEOUT.endswith("s")
    seconds = float(ULTRAVOX_TOOL_TIMEOUT[:-1])
    assert 2.5 < seconds <= 40
