"""Disconnect taxonomy and other constants — section 7.3 of the architecture doc.

The six core reasons are mandatory; handler-specific extensions are permitted but
flagged transitional.
"""

DISCONNECT_REASONS = {
    "ORIGINAL_PARTICIPANT": "Original participant disconnected",
    "BRIDGED_PARTICIPANT": "Bridged participant disconnected",
    "AGENT_INITIATED_HANGUP": "Agent initiated hangup",
    "SESSION_TIMEOUT": "Session timeout",
    "SESSION_CLOSED": "Session closed",
    "UNCAUGHT_ERROR_RUNNING_AGENT": "UNCAUGHT ERROR: running agent worker",
    # Transitional handler-specific reason — section 7.4. Same intent as the
    # LiveKit worker's WATCHDOG_NO_PARTICIPANTS.
    "WATCHDOG_NO_PARTICIPANTS": "Watchdog: no remote participants",
    # ``options.inactivity.hangup`` is set and the inactivity prompt went
    # unanswered ``INACTIVITY_PROMPT_COUNT`` times. Distinct from SESSION_TIMEOUT
    # so a call reclaimed deliberately is not confused with one that simply ran
    # out the model's maxDuration. Mirrors the LiveKit worker's string exactly.
    "INACTIVITY_TIMEOUT": "Inactivity timeout",
}

PLATFORM = "pipecat"
