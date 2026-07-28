"""``promptMetadata`` rendering on the pipecat worker
(:mod:`pipecat_aplisay.prompt_metadata`).

The python twin of ``lib/prompt-metadata.js`` must render identically — an
agent definition has to produce the same system prompt whichever worker takes
the call. These lock the shared semantics: live dateTime, omission of absent
values (never "None" in a prompt), and an untouched prompt when nothing
resolves.
"""

from __future__ import annotations

import re

from pipecat_aplisay.prompt_metadata import (
    MAX_VALUE_CHARS,
    PROMPT_METADATA_HEADING,
    prompt_with_metadata,
    resolve_prompt_metadata_lines,
)

METADATA = {
    "aplisay": {"callerId": "+447700900123", "calledId": "+441234567890"},
    "crm": {"tier": "gold", "openTickets": 2, "vip": True, "contact": {"name": "Bob"}},
}

DATETIME_RE = re.compile(r"^\w+day \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+$")


def test_renders_description_then_value_in_order():
    lines = resolve_prompt_metadata_lines(
        [
            {"description": "The number this caller is calling from is", "from": "aplisay.callerId"},
            {"description": "They dialled", "from": "aplisay.calledId"},
        ],
        METADATA,
    )
    assert lines == [
        "The number this caller is calling from is +447700900123",
        "They dialled +441234567890",
    ]


def test_datetime_is_live_but_a_seeded_value_wins():
    (live,) = resolve_prompt_metadata_lines([{"from": "aplisay.dateTime"}], METADATA)
    assert DATETIME_RE.match(live)
    assert resolve_prompt_metadata_lines([{"from": "aplisay.dateTime"}], {"aplisay": {"dateTime": "SEEDED"}}) == ["SEEDED"]


def test_absent_values_are_omitted_never_stated_as_none():
    lines = resolve_prompt_metadata_lines(
        [
            {"description": "Account tier is", "from": "crm.tier"},
            {"description": "Loyalty number is", "from": "crm.loyaltyNumber"},
            {"description": "Nothing at", "from": "no.such.path"},
            {"description": "Blank is", "from": "crm.blank"},
        ],
        {**METADATA, "crm": {**METADATA["crm"], "blank": "   "}},
    )
    assert lines == ["Account tier is gold"]
    assert "None" not in "\n".join(lines)


def test_scalar_and_structured_rendering_matches_the_js_twin():
    lines = resolve_prompt_metadata_lines(
        [
            {"description": "Open tickets:", "from": "crm.openTickets"},
            {"description": "VIP:", "from": "crm.vip"},
            {"description": "Contact name is", "from": "crm.contact.name"},
            {"description": "Contact record:", "from": "crm.contact"},
        ],
        METADATA,
    )
    # booleans lower-case (JS parity), objects as compact JSON
    assert lines == ["Open tickets: 2", "VIP: true", "Contact name is Bob", 'Contact record: {"name":"Bob"}']


def test_large_value_is_capped():
    (line,) = resolve_prompt_metadata_lines([{"from": "big"}], {"big": "x" * 5000})
    assert len(line) <= MAX_VALUE_CHARS + 1


def test_malformed_or_empty_declarations_are_inert():
    assert resolve_prompt_metadata_lines(None, METADATA) == []
    assert resolve_prompt_metadata_lines([], METADATA) == []
    assert resolve_prompt_metadata_lines([{"description": "no from"}, None, "x"], METADATA) == []


def test_prompt_with_metadata_appends_a_block_after_the_prompt():
    out = prompt_with_metadata(
        "You are a booking agent.", [{"description": "Today is", "from": "aplisay.dateTime"}], METADATA
    )
    assert out.startswith("You are a booking agent.")
    assert PROMPT_METADATA_HEADING in out
    assert out.splitlines()[-1].startswith("Today is ")


def test_prompt_untouched_when_nothing_resolves():
    prompt = "You are a helpful assistant."
    assert prompt_with_metadata(prompt, None, METADATA) == prompt
    assert prompt_with_metadata(prompt, [], METADATA) == prompt
    assert prompt_with_metadata(prompt, [{"from": "not.present"}], METADATA) == prompt


def test_block_stands_alone_when_the_agent_has_no_prompt():
    out = prompt_with_metadata("", [{"description": "Caller:", "from": "aplisay.callerId"}], METADATA)
    assert out == f"{PROMPT_METADATA_HEADING}\nCaller: +447700900123"
