# Agent Concurrency Limits

This document explains how *agent concurrency limits* work and how to configure them via the public API.

## Where to set limits

Concurrency is enforced based on `agentLimit` configured at three levels:

1. **Instance (user accessible)**: `instances.agentLimit`
2. **User (system populated)**: `users.agentLimit`
3. **Organisation (system populated)**: `organisations.agentLimit`

In practice, organisation/user values are typically set by the platform (“system”), and you configure the **instance** value via:

`POST /agents/{agentId}/listen` (the “listener create/activate” API), under `options.agentLimit`.

When you set `options.agentLimit`, it is copied onto the created listener instance.

## Semantics of `agentLimit`

For each scope (instance / user / organisation):

- `agentLimit: null` means **unlimited** (no cap)
- `agentLimit: 0` means **disallow** new concurrent calls in that scope
- `agentLimit: N` where `N > 0` means **cap** concurrent calls in that scope to `N`

## How enforcement works

When a call starts, the system checks the configured concurrency limits at the instance/user/organisation scopes.

If any applicable limit would be exceeded, the call is rejected.

Organisation scope is only applied when the call is associated with an organisation; if a call’s `organisationId` is `null`, organisation-scoped limits are ignored.

## What clients see when a limit is exceeded

- **WebRTC join**: the join request is rejected with **HTTP 429** when a configured limit would be exceeded.
- **Inbound telephony**: the inbound call is rejected with a **busy cause code** when a configured limit would be exceeded.
- **Outbound telephony originate** (`POST /listener/{listenerId}/originate`): the originate request is rejected with **HTTP 429** and the standard `{ error, code, scope, details }` body when a configured limit would be exceeded.

## Example: set an instance concurrency cap

```json
{
  "websocket": false,
  "number": "*",
  "options": {
    "agentLimit": 1,
    "streamLog": false,
    "metadata": { "myapp": { "mykey": "mydata" } }
  }
}
```
