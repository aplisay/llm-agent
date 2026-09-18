"""The shared tool-result cap (``tool_result.py``).

Both places a tool result reaches a model use this: MCP proxying and the
agent's own REST/builtin functions. The behaviour that matters is that an
ordinary result is untouched, an oversized one is cut AND SAYS SO, and the cut
never produces something a model cannot read.
"""

from __future__ import annotations


from pipecat_aplisay import tool_result as tr


def test_text_within_the_cap_is_returned_unchanged():
    out, dropped = tr.clip_result("short", 8000, tool="t")
    assert (out, dropped) == ("short", 0)


def test_text_over_the_cap_is_cut_to_it():
    out, dropped = tr.clip_result("y" * 40000, 2500, tool="reader")
    body = out.split("\n\n[", 1)[0]
    assert len(body.encode("utf-8")) <= 2500
    assert dropped > 37000


def test_the_marker_names_the_numbers_and_what_to_do():
    # Silent truncation is the dangerous option: a model cannot tell a short
    # answer from a cut one and will answer confidently from half a document.
    out, _ = tr.clip_result("y" * 40000, 2500, tool="read_doc")
    assert "read_doc" in out
    assert "truncated here" in out
    assert "40000 bytes" in out
    assert "smaller or more specific part" in out
    assert "do not repeat this call unchanged" in out


def test_a_cut_prefers_a_nearby_line_boundary():
    text = "\n".join(f"line {n}" for n in range(2000))
    out, _ = tr.clip_result(text, 1000, tool="t")
    body = out.split("\n\n[", 1)[0]
    assert body.endswith(tuple("0123456789")), "ends on a whole line"
    assert len(body.encode("utf-8")) > 750, "without sacrificing a quarter to find one"


def test_a_cut_with_no_nearby_boundary_keeps_the_budget():
    # One enormous line: there is no boundary to find, so the cap wins rather
    # than the result collapsing to nothing.
    out, _ = tr.clip_result("y" * 5000 + "\n" + "z" * 5000, 4000, tool="t")
    body = out.split("\n\n[", 1)[0]
    assert len(body.encode("utf-8")) > 3900


def test_a_cut_inside_a_multibyte_character_stays_valid_utf8():
    # A naive byte slice can split a character and produce invalid UTF-8,
    # which would break the JSON encoding of the result downstream.
    out, _ = tr.clip_result("é" * 4000, 1001, tool="t")
    assert out.encode("utf-8").decode("utf-8") == out
    assert "�" not in out


def test_a_cap_of_zero_or_less_disables_capping():
    assert tr.clip_result("y" * 40000, 0, tool="t") == ("y" * 40000, 0)
    assert tr.clip_any_result({"a": 1}, -1, tool="t") == ({"a": 1}, 0)


def test_structured_results_that_fit_keep_their_type():
    value = {"slots": ["09:30", "11:00"]}
    out, dropped = tr.clip_any_result(value, 8000, tool="t")
    assert out is value, "the common path does not even copy"
    assert dropped == 0


def test_structured_results_that_do_not_fit_become_clipped_json():
    value = {"rows": ["x" * 200] * 200}
    out, dropped = tr.clip_any_result(value, 2000, tool="t")
    assert isinstance(out, str), "half a dict is not a dict"
    assert out.startswith('{"rows"')
    assert "truncated here" in out
    assert dropped > 0


def test_none_is_left_alone():
    assert tr.clip_any_result(None, 10, tool="t") == (None, 0)


def test_a_value_json_cannot_render_still_gets_capped():
    class Opaque:
        def __repr__(self):
            return "OPAQUE" * 5000

    out, dropped = tr.clip_any_result(Opaque(), 500, tool="t")
    assert isinstance(out, str)
    assert dropped > 0
    assert "truncated here" in out


def test_the_delegated_cap_leaves_room_for_a_whole_conversation():
    # The reason there are two caps: a call's worth of tool calls has to fit
    # in the delegation's per-session budget, not just one call.
    budget = 32768
    per_call = tr.MAX_RESULT_BYTES_DELEGATED + len(
        tr._marker("some_tool", 40000, 42500).encode("utf-8")
    )
    assert budget // per_call >= 11, "a dozen tool calls must fit"
    assert tr.MAX_RESULT_BYTES > tr.MAX_RESULT_BYTES_DELEGATED


def test_the_incident_turn_now_fits_the_budget():
    # The eleven tool results from the 2026-09-14 call, in order.
    real = [176, 152, 1815, 2000, 4952, 2540, 168, 14212, 40561, 15247, 22679]
    capped = sum(
        len(tr.clip_result("y" * n, tr.MAX_RESULT_BYTES_DELEGATED, tool="t")[0].encode("utf-8"))
        for n in real
    )
    assert sum(real) > 32768 * 3, "the turn really was three times the budget"
    assert capped < 32768, f"and now fits, at {capped} bytes"


def test_the_cap_a_model_gets_depends_on_whether_it_delegates():
    # GPT-Live returns every tool result to its backend as delegation input,
    # so the whole merged tool set shares the per-session budget. Other models
    # spend context per turn.
    from pipecat_aplisay.call_session import _result_cap_for

    assert _result_cap_for("pipecat:openai/gpt-live-1") == tr.MAX_RESULT_BYTES_DELEGATED
    assert _result_cap_for("pipecat:ultravox/ultravox-v0.7") == tr.MAX_RESULT_BYTES
    assert _result_cap_for("pipecat:openai/gpt-4o-mini") == tr.MAX_RESULT_BYTES
    assert _result_cap_for("") == tr.MAX_RESULT_BYTES
    assert _result_cap_for(None) == tr.MAX_RESULT_BYTES
