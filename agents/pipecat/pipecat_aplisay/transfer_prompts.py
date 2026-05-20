"""Canonical TransferAgent prompt + utilities — see
``docs/call-transfers.md`` for the contract.

This module mirrors the LiveKit transfer-handler so the two ingresses
present the same wire surface for consultative transfers:

- ``transferPrompt`` resolution order: per-call args → agent-level
  ``options.transferPrompt`` → :data:`DEFAULT_TRANSFER_PROMPT_TEMPLATE`.
- ``${parentTranscript}`` substitution: the parent CallSession's running
  chat history rendered as alternating ``> caller:`` / ``> agent:``
  lines.

The default template below is byte-for-byte identical to the LiveKit
default at ``agents/livekit/lib/transfer-handler.ts:615``. Keep the two
in sync if either side changes.
"""

from __future__ import annotations

from typing import Iterable, Optional


# Byte-identical to ``defaultTransferPromptTemplate`` in
# agents/livekit/lib/transfer-handler.ts. Triple-quoted Python string
# preserving the source's mid-paragraph trailing-space character on
# line 2 of the second paragraph ("the agent involved [SPACE]\n") —
# that whitespace is significant only for visual diff parity, not for
# LLM behaviour.
DEFAULT_TRANSFER_PROMPT_TEMPLATE = (
    "You are a transfer assistant helping with a call transfer. "
    "Here is the conversation history with the caller: ${parentTranscript}\n"
    "\n"
    "You are now speaking with the person that it has been decided to "
    "transfer the call to based on the previous Conversation, and you "
    "should act as if you were \n"
    "the agent involved in this conversation with full knowledge of "
    "the conversation history.\n"
    "Your role is to:\n"
    "1. Summarize the call history for the transfer target\n"
    "2. Ask if they want to accept the transfer and speak with the caller\n"
    "3. If they accept, call the accept_transfer function\n"
    "4. If they decline, call the reject_transfer function with a detailed "
    "reason parameter that summarizes your conversation with the transfer "
    "target and explains why they declined. This summary will be provided "
    "to the original agent, so make it informative and clear.\n"
    "\n"
    "Be helpful, informal, but respectful and concise as if talking to a "
    "colleague in a company."
)


def resolve_transfer_prompt(
    *,
    args_prompt: Optional[str],
    agent_options_prompt: Optional[str],
) -> str:
    """Return the unresolved transfer-prompt template per the canonical
    precedence chain. Caller is responsible for the ``${parentTranscript}``
    substitution via :func:`substitute_parent_transcript`.

    Mirrors transfer-handler.ts:628-631 (LiveKit). The blank-string
    handling is deliberate: an empty per-call override should NOT fall
    through to the agent-level option (the bot explicitly chose empty);
    but a missing or ``None`` value does fall through. We follow Python's
    ``or`` semantics here which match JavaScript's: empty string is
    falsy in both languages so both fall through. This matches the
    LiveKit behaviour exactly.
    """
    return args_prompt or agent_options_prompt or DEFAULT_TRANSFER_PROMPT_TEMPLATE


def substitute_parent_transcript(template: str, parent_transcript: str) -> str:
    """Replace ``${parentTranscript}`` literally with the supplied
    transcript. Mirrors transfer-handler.ts:634-637.

    The replacement is global (all occurrences) — though we expect only
    one in practice — to match the LiveKit regex
    ``/\\$\\{parentTranscript\\}/g``.
    """
    return template.replace("${parentTranscript}", parent_transcript)


def render_parent_transcript(turns: Iterable[tuple[str, str]]) -> str:
    """Render an iterable of ``(role, text)`` turns into the LiveKit
    transcript format used in the ``${parentTranscript}`` substitution.

    Format (transfer-handler.ts:599-605):

        > caller: <text>\\n
        > agent: <text>\\n

    Only the ``user`` and ``assistant`` roles emit lines (matching the
    LiveKit code's ``if (role === "user") ... else if (role === "assistant")``
    pair). Other roles (system, developer, tool messages) are skipped.

    Returns an empty string if there are no turns — the resulting
    substituted prompt will read "Here is the conversation history
    with the caller: " followed by nothing, which is the LiveKit
    behaviour when no chat history is available.
    """
    lines = []
    for role, text in turns:
        if role == "user":
            lines.append(f"> caller: {text}\n")
        elif role == "assistant":
            lines.append(f"> agent: {text}\n")
    return "".join(lines)
