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
}

PLATFORM = "pipecat"
