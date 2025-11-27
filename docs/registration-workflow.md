# Phone Registration Workflow

This guide shows how to create a phone registration endpoint, activate it, verify state, and use it with an agent listener.

## 1) Create a registration endpoint

POST `/phone-endpoints`

Request body (base):
- `type` (string, required): must be `phone-registration`
- `handler` (string, optional, default `livekit`): handler for this endpoint
- `outbound` (boolean, optional, default `false`)
- `name` (string, optional): user-defined description of the endpoint

Request body (phone-registration union fields):
- `registrar` (string, required): SIP contact URI, e.g. `sip:provider.example.com:5060`
- `username` (string, required): registration username
- `password` (string, required): registration password
- `options` (object, optional): implementation-specific configuration

Example:
```json
{
  "type": "phone-registration",
  "handler": "livekit",
  "name": "Sales Extension (UK) AI Phone",
  "registrar": "sip:provider.example.com:5060",
  "username": "user123",
  "password": "secret",
  "options": {"region": "eu-west"}
}
```

Successful response:
```json
{ "success": true, "id": "<registration-id>" }
```
Grab the `id` for subsequent steps.

## 2) Activate the registration

POST `/phone-endpoints/{id}/activate`

- Activates the registration for the first time.
- Can be re-called to re-activate a registration that entered the `failed` state after repeated failures.

Successful response returns new registration state:
```json
{ "success": true, "id": "<registration-id>", "status": "active", "state": "initial" }
```

Note: The registration process is asynchronous; see the next step for polling state.

## 3) Verify registration state (asynchronous)

GET `/phone-endpoints/{id}`

The single endpoint fetch returns one of two shapes. For registrations (id-based):
- `id` (string): registration id
- `handler` (string)
- `status` (string): one of `active` | `failed` | `disabled`
- `state` (string): one of `initial` | `registering` | `registered` | `failed`
- `error` (string, optional): descriptive error if the registration is failing
- `name` (string, optional)
- `registrar` (string)
- `username` (string)
- `outbound` (boolean)

Important:
- Registration is asynchronous and can take several minutes, polling this interface at not less than 1 minute intervals is recommended.
- Typical progression: `initial` → `registering` → `registered`.
- If failure persists, `state` becomes `failed` and `status` may become `failed`.
- The `error` field should provide a descriptive reason when in a failing/failed state.
- After resolving the cause, call `activate` again to re-activate.

## 4) Link the registration to an agent listener

POST `/agents/{agentId}/listen`

To use the registration, pass the `id`:
```json
{ "id": "<registration-id>" }
```
This instantiates a listener bound to the registered endpoint.

## Disabling registrations

POST `/phone-endpoints/{id}/disable`

- Disables a registration (e.g., stop re-try attempts or de-register).
- Returns new state:
```json
{ "success": true, "id": "<registration-id>", "status": "disabled", "state": "initial" }
```

Note that this doesn't remove the agent listener which will remain bound to the (disabled) registration and thus never receive any calls.

