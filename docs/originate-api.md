# Originate Call API

## Overview

The originate endpoint validates and starts an outbound call from an **agent listener instance** (`Instance`) toward a PSTN (`calledId`) using a **`callerId`** that must be allowed for outbound in your organisation — either an allocated **DDI** (`PhoneNumber`) or a **`phone-registration`** endpoint UUID (`PhoneRegistration`).

## Endpoint

### `POST /api/listener/{listenerId}/originate`

- **`listenerId`**: Listener / instance ID (from `POST …/listen`).
- **Body**
  - **`calledId`**: Destination number. If the agent has no custom `outboundCallFilter`, default validation is UK geographic/mobile (same rules as historically).
  - **`callerId`**: Either **E.164** for an allocated number in `phone_numbers`, or a **UUID** primary key of a row in `phone_registrations`.
  - **`metadata`**: Optional; forwarded to the LiveKit outbound dispatch.

### Validation (caller)

| Caller type | Requirement |
|-------------|----------------|
| **DDI** (`callerId` = stored number string) | Row exists for the organisation, **`outbound`** is true, **`aplisayId`** set (trunk). |
| **Registration** (`callerId` = UUID) | Row exists for the organisation, **`outbound`** is true, **`b2buaId`** set (B2BUA gateway IP/hostname). SIP CLI from **`username`** or **`options.displayNumber`**. Transport from **`options.transport`** (default `tcp`). |

### Registration outbound (LiveKit worker)

For **`callerId`** = registration UUID there is no inbound SIP leg, so the worker uses **`b2buaId`** and **`options.transport`** from the registration record (same B2BUA edge semantics as inbound `sipHXLkRealIp` / `sipHXLkTransport`). See [`agents/livekit/README.md`](../agents/livekit/README.md).

### Success response

`200` — `{ success, message, data: { callId, listenerId, callerId, calledId, organisationId } }`.

### Errors

| Status | Typical cause |
|--------|----------------|
| **400** | Missing fields; invalid `calledId` for configured filter; caller not outbound-enabled; registration without **`b2buaId`** or CLI (`username` / `options.displayNumber`). |
| **404** | Listener or caller endpoint not found / wrong org. |
| **429** | Agent concurrency limits (see agent-concurrency docs). |

## Examples

### DDI as caller

```bash
curl -X POST "$API/listener/$LISTENER_ID/originate" \
  -H "Authorization: Bearer …" \
  -H "Content-Type: application/json" \
  -d '{"calledId":"+447911123456","callerId":"+442080996945"}'
```

### Registration endpoint UUID as caller

Use the **`id`** returned when creating or listing `phone-registration` endpoints (`GET /phone-endpoints?type=phone-registration&originate=true`).

```bash
curl -X POST "$API/listener/$LISTENER_ID/originate" \
  -H "Authorization: Bearer …" \
  -H "Content-Type: application/json" \
  -d '{"calledId":"+447911123456","callerId":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}'
```

## Security

Organisation isolation applies to listener, caller number, and caller registration. Authentication is required.
