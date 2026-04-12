# Phone Endpoints API

## Overview

The Phone Endpoints API provides access to telephone endpoints (numbers and SIP registrations) available to an organisation for use with agents. Endpoints can be assigned to agent instances (listeners) to handle incoming calls; the API supports listing, filtering, creating, updating, and deleting endpoints so you can build number-management UIs, automate provisioning, or integrate with existing inventory systems.

**Why use this API**

- **Number management UIs**: List numbers with server-side search and filters (by trunk, handler, or partial number), paginate cleanly, and show which agent (if any) is currently using each number via the listener assignment.
- **Bulk operations**: Create many numbers on a trunk in one flow (one request per number or batch via your client), then update outbound or handler in place with PUT.
- **Trunk-centric workflows**: Filter by one or more `trunkId` values so users can work per-trunk (e.g. “numbers on this SIP trunk”) and derive handler/outbound options from the trunk when creating numbers.
- **Agent assignment visibility**: Each E.164 DDI item includes `inUse`, `agentId`, and `agentName` when the number is linked to a listener, so you can show “this number is used by agent X” and link to that agent in your UI.

## Endpoints

### GET /api/phone-endpoints

Returns a paginated list of phone endpoints for the caller's organisation. You can restrict to E.164 DDI or phone-registration types and apply filters so only relevant endpoints are returned.

#### Query parameters

| Parameter   | Type    | Default | Description |
|------------|---------|---------|-------------|
| `type`     | string  | —       | Restrict to one type: `e164-ddi` or `phone-registration`. Omit to get both (merged and ordered). |
| `offset`   | integer | 0       | 0-based offset for pagination. |
| `pageSize` | integer | 50      | Page size (1–200). Use a consistent size (e.g. 20) for stable pagination in a UI. |
| `originate`| boolean | —       | If `true`, return only endpoints that can be used for outbound calling (`outbound=true` and, for DDI, assigned to a trunk). |
| `handler`  | string  | —       | Filter by handler: `livekit`, `jambonz`, or `ultravox`. |
| `search`   | string  | —       | **E.164 DDI only.** Partial match on the number (digits only; leading `+` in the search is stripped). Use for “find number” or type-ahead. |
| `trunkId`  | string  | —       | **E.164 DDI only.** Filter to numbers assigned to the given trunk(s). Send multiple values to allow multiple trunks (e.g. `trunkId=id1&trunkId=id2`). |

**Tips**

- For a “numbering” or “numbers” tab, typically you call with `type=e164-ddi`, `pageSize=20`, and optional `search` and `trunkId` (and optionally `handler`) so the backend does filtering and you only render one page.
- Handler options for filters/dropdowns can be derived from the trunks list (each trunk has a `handler`); that keeps the UI in sync with what’s valid for the organisation.

#### Response body

- `items`: array of endpoint objects (shape depends on type; see below).
- `nextOffset`: integer offset for the next page, or `null` if there are no more results. Request the next page with `offset=nextOffset` and the same other parameters.

**E.164 DDI item shape** (when `type=e164-ddi` or when type is omitted and the item is a number):

| Field        | Type    | Description |
|-------------|---------|-------------|
| `number`    | string  | E.164 number (with or without `+`). |
| `handler`   | string  | Handler for this endpoint: `livekit`, `jambonz`, etc. |
| `outbound`  | boolean | Whether the endpoint supports outbound calls. |
| `provisioned` | boolean | Whether the platform has attempted to provision this number to the underlying telephony platform(s). This does not guarantee that calls will arrive, but is useful as a coarse status indicator. |
| `trunkId`   | string \| null | Trunk the number is assigned to; `null` if unassigned. |
| `createdAt` | string \| null | ISO 8601 timestamp when the number was created. |
| `inUse`     | boolean | Whether the number is linked to an agent instance (listener). |
| `agentId`   | string \| null | If `inUse` is true, the ID of the agent attached via that listener. |
| `agentName` | string \| null | If `inUse` is true, the name of that agent (for display). |

**Phone registration item shape** (when `type=phone-registration` or when type is omitted and the item is a registration):

| Field        | Type    | Description |
|-------------|---------|-------------|
| `id`        | string  | Registration ID (e.g. UUID). |
| `name`      | string \| null | User-defined name. |
| `registrar` | string  | SIP contact URI (without sip:/sips: prefix in response). |
| `username`  | string  | Registration username. |
| `status`    | string  | High-level status: `active`, `failed`, `disabled`. |
| `state`     | string  | Registration state: `initial`, `registering`, `registered`, `failed`. |
| `handler`   | string  | Handler type. |
| `outbound`  | boolean | Whether outbound is supported. |

**Example (E.164 DDI only, one trunk filter):**

```json
{
  "items": [
    {
      "number": "+442080996945",
      "handler": "jambonz",
      "outbound": true,
      "provisioned": false,
      "trunkId": "trunk-001",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "inUse": true,
      "agentId": "agent-abc-123",
      "agentName": "Sales UK"
    },
    {
      "number": "+442080996946",
      "handler": "jambonz",
      "outbound": false,
      "provisioned": true,
      "trunkId": "trunk-001",
      "createdAt": "2024-01-16T09:00:00.000Z",
      "inUse": false,
      "agentId": null,
      "agentName": null
    }
  ],
  "nextOffset": 20
}
```

---

### POST /api/phone-endpoints

Creates a new phone endpoint. Supports E.164 DDI (number on a trunk) and phone-registration (SIP registration) types.

#### E.164 DDI

- **Request body**: `type`, `number` (or legacy `phoneNumber`), `trunkId`, and optionally `name`, `handler`, `outbound`.
- Handler and outbound are constrained by the trunk: the effective handler is from the trunk, and `outbound` can only be `true` if the trunk has outbound enabled.
- **Response (201)**: `{ "success": true, "number": "1234567890" }` (number without `+`).

**Example:**

```json
{
  "type": "e164-ddi",
  "number": "+1234567890",
  "trunkId": "trunk-001",
  "outbound": true
}
```

You can send `number` or `phoneNumber`; both are accepted.

#### Phone registration

- **Request body**: `type`, `registrar`, `username`, `password`, and optionally `name`, `outbound`, `handler`, `options`.
- **Response (201)**: `{ "success": true, "id": "<registration-uuid>" }`.

**Example:**

```json
{
  "type": "phone-registration",
  "name": "SIP Reg A",
  "registrar": "sip:provider.example.com:5060",
  "username": "user123",
  "password": "secret",
  "outbound": true
}
```

---

### PUT /api/phone-endpoints/{identifier}

Updates an existing phone endpoint.

- **Path**: `identifier` is the E.164 number (with or without `+`) for DDI, or the registration ID for phone-registration.
- **Body**: Only send fields you want to change. For E.164 DDI, only `outbound` and `handler` are updatable; for phone-registration, `name`, `outbound`, `handler`, `registrar`, `username`, `password`, and `options` can be updated. Updating credentials resets registration state.
- **Response (200)**: `{ "success": true }`.

---

### DELETE /api/phone-endpoints/{identifier}

Deletes a phone endpoint. `identifier` is the number (E.164) or registration ID.

- **Response (200)**: `{ "success": true, "message": "Phone endpoint deleted successfully" }`.

---

## Using the API for managing telephone numbers

### Listing and filtering

- Use **`type=e164-ddi`** when building a “numbers” or “numbering” view so you only get DDI numbers and the response includes `createdAt`, `inUse`, `agentId`, and `agentName`.
- **Search**: Pass `search` with digits (or a number with `+`); the API does a substring match on the stored number. Good for a single search box.
- **Trunk filter**: Pass one or more `trunkId` query params to restrict to numbers on those trunks. In a UI you can let users pick trunks from a trunks list and then refetch numbers with the selected `trunkId`(s).
- **Pagination**: Use a fixed `pageSize` (e.g. 20) and `offset=0` for the first page. Use the returned `nextOffset` as the next `offset` until `nextOffset` is `null`. Refetch when filters change (reset to `offset=0`).

### Creating numbers

- **Single number**: POST with `type`, `number`, `trunkId`, and `outbound`. Default `outbound` from the trunk when possible so the UI matches trunk capabilities.
- **Multiple numbers**: The API creates one number per request. To add a range or list, your client can loop over normalized E.164 values and POST each (with optional client-side limit, e.g. max 40 per batch) and surface errors per number if needed.
- **Validation**: Numbers are validated as E.164 (7–15 digits, optional leading `+`). Duplicate number returns 409.

### Agent assignment (inUse, agentId, agentName)

- Numbers are linked to agents via **listeners** (agent instances). The API does not assign numbers to agents; that is done through the listener/agent configuration. The GET response only reports the current assignment.
- **inUse**: `true` when the number is attached to a listener.
- **agentId** / **agentName**: When `inUse` is true, these identify the agent. Use them to show “Used by &lt;agentName&gt;” and to link to the agent (e.g. open the Observe tab for that agent).

### Handler and trunk constraints

- **Handler**: For DDI, the effective handler comes from the trunk. Filtering by `handler` on GET still makes sense to show only e.g. “livekit” numbers. When creating, the trunk’s handler applies.
- **Outbound**: For DDI, `outbound` can only be `true` if the trunk has outbound enabled. When building an “add number” form, default `outbound` from the selected trunk to avoid invalid requests.

---

## Validation

### E.164

- 7–15 digits, optional leading `+`, must start with a country code (1–9). Examples: `+1234567890`, `1234567890`.

### SIP URI (phone-registration)

- Registrar must be a valid SIP URI (e.g. `sip:user@domain:port`). Username, domain, and optional port are validated.

---

## Authentication and errors

- All endpoints require authentication. Results are scoped to the caller’s organisation.
- **400**: Validation failed, invalid body, or trunk not found / not in organisation.
- **401**: Unauthorized.
- **403**: Forbidden.
- **404**: Endpoint not found (PUT/DELETE).
- **409**: Phone number already exists (POST).
- **500**: Server error.

---

## Example requests

**List E.164 DDI numbers for one trunk, first page:**

```bash
curl -X GET "https://llm-agent.example.com/api/phone-endpoints?type=e164-ddi&trunkId=trunk-001&pageSize=20&offset=0" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Search numbers by digits:**

```bash
curl -X GET "https://llm-agent.example.com/api/phone-endpoints?type=e164-ddi&search=44208&pageSize=20" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Create a single DDI number:**

```bash
curl -X POST "https://llm-agent.example.com/api/phone-endpoints" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"e164-ddi","number":"+1234567890","trunkId":"trunk-001","outbound":true}'
```

**Update outbound for a number:**

```bash
curl -X PUT "https://llm-agent.example.com/api/phone-endpoints/+1234567890" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"outbound":false}'
```

**Delete a number:**

```bash
curl -X DELETE "https://llm-agent.example.com/api/phone-endpoints/+1234567890" \
  -H "Authorization: Bearer YOUR_TOKEN"
```
