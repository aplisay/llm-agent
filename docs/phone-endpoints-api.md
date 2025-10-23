# Phone Endpoints API

## Overview

The Phone Endpoints API provides access to telephone endpoints (numbers) available to an organisation for use with agents. These endpoints can be assigned to agent instances to handle incoming calls.

## Endpoints

### GET /api/phone-endpoints

Returns a paginated list of phone endpoints for the caller's organisation.

Query Parameters:
- `originate` (boolean, optional): When `true`, return only endpoints that can be used for outbound calling
- `handler` (string, optional): One of `livekit`, `jambonz`, `ultravox`
- `type` (string, optional): One of `e164-ddi`, `phone-registration`
- `offset` (integer, optional, default 0): 0-based offset
- `pageSize` (integer, optional, default 50, max 200): page size

Response body:
```json
{
  "items": [
    { "name": "Sales UK", "number": "+442080996945", "handler": "jambonz", "outbound": true },
    { "name": "SIP Reg A", "id": "reg-123", "status": "active", "state": "registered", "handler": "livekit", "outbound": false }
  ],
  "nextOffset": 50
}
```

### POST /api/phone-endpoints

Creates a new phone endpoint. Supports two types of endpoints:

#### E.164 DDI Endpoints

Creates a phone endpoint using an E.164 phone number with trunk configuration.

Request body uses a base-and-union shape:
- Always present:
  - `type` (string): `e164-ddi` | `phone-registration`
  - `name` (string, optional): free-form, user-defined descriptive name
  - `handler` (string, optional, default `livekit`)
  - `outbound` (boolean, optional, default `false`)
- Plus one of:
  - For `e164-ddi`:
    - `number` (string): E.164 number (with or without '+')
    - `trunkId` (string)
  - For `phone-registration`:
    - `registrar` (string): SIP contact URI
    - `username` (string)
    - `password` (string)
    - `options` (object, optional)

**Request Body (e164-ddi):**
```json
{
  "type": "e164-ddi",
  "name": "Main DDI",
  "number": "+1234567890",
  "trunkId": "trunk-001",
  "outbound": true
}
```

**Parameters:**
- `type` (string, required): Must be "e164-ddi"
- `phoneNumber` (string, required): E.164 phone number (with or without +)
- `trunkId` (string, required): Trunk identifier (must exist and be associated with your organisation)
- `outbound` (boolean, required): Whether this endpoint supports outbound calls

#### Phone Registration Endpoints

Creates a SIP registration-based phone endpoint.

**Request Body (phone-registration):**
```json
{
  "type": "phone-registration",
  "name": "SIP Reg A",
  "registrar": "sip:provider.example.com:5060",
  "username": "user123",
  "password": "secret",
  "options": {
    "implementation": "specific"
  },
  "outbound": true
}
```

**Parameters:**
- `type` (string, required): Must be "phone-registration"
- `registrar` (string, required): SIP contact URI (validated format)
- `username` (string, required): Registration username
- `password` (string, required): Registration password
- `options` (object, optional): Implementation-specific options (TBD)

### PUT /api/phone-endpoints/{identifier}

Updates an existing phone endpoint.

**Path Parameters:**
- `identifier` (string, required): The phone number (E.164) or ID of the endpoint to update

**Request Body:**
```json
{
  "outbound": false,
  "handler": "livekit"
}
```

**Parameters:**
- `outbound` (boolean, optional): Whether this endpoint supports outbound calls
- `handler` (string, optional): The handler type ("livekit" or "jambonz")

Behavior:
- If `outbound` is omitted, its value remains unchanged.
- If `outbound` is provided as `false`, it will be updated to `false`.

### DELETE /api/phone-endpoints/{identifier}

Deletes a phone endpoint.

**Path Parameters:**
- `identifier` (string, required): The phone number (E.164) or ID of the endpoint to delete

## Validation

### E.164 Phone Number Validation

Phone numbers are validated according to E.164 international standard:
- Must be 7-15 digits long
- Can optionally start with '+' 
- Must start with a country code (1-9)
- Examples: `+1234567890`, `1234567890`

### SIP URI Validation

SIP registrar URIs are validated using the format: `sip:user@domain:port`
- Must start with `sip:`
- Username can contain alphanumeric characters, dots, underscores, and hyphens
- Domain must be a valid hostname or IP address
- Port is optional
- Examples: `sip:user@example.com:5060`, `sip:user@192.168.1.1`

## Authentication

All endpoints require authentication. The user's `organisationId` is automatically extracted from the authenticated user's session.

## Response Formats

### GET /api/phone-endpoints

Returns a paginated object with items and nextOffset.

### POST /api/phone-endpoints

Success response always includes `success: true`, plus type-specific fields:

- When `type` is `e164-ddi`:
```json
{ "success": true, "number": "1234567890" }
```

- When `type` is `phone-registration`:
```json
{ "success": true, "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }
```

**Error Response (400):**
```json
{
  "error": "Validation failed",
  "details": [
    "phoneNumber must be a valid E.164 number (with or without +)"
  ]
}
```

### PUT /api/phone-endpoints/{identifier}

**Success Response (200):**
```json
{ "success": true }
```

### DELETE /api/phone-endpoints/{identifier}

**Success Response (200):**
```json
{
  "success": true,
  "message": "Phone endpoint deleted successfully"
}
```

## Query Parameters (GET)

- `originate` (boolean, optional): When set to `true`, filters the results to only return endpoints that can be used for outbound calling (where `outbound=true` and `aplisayId` is not null)
- `handler` (string, optional): Filter to only return endpoints using the specified handler ("livekit", "jambonz", "ultravox")

## Example Usage

**Get all phone endpoints:**

```bash
curl -X GET "https://llm-agent.aplisay.com/api/phone-endpoints" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Get only outbound-capable endpoints:**

```bash
curl -X GET "https://llm-agent.aplisay.com/api/phone-endpoints?originate=true" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Create an E.164 DDI endpoint:**

```bash
curl -X POST "https://llm-agent.aplisay.com/api/phone-endpoints" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "e164-ddi",
    "name": "Main DDI",
    "phoneNumber": "+1234567890",
    "trunkId": "trunk-001",
    "outbound": true
  }'
```

**Create a phone registration endpoint:**

```bash
curl -X POST "https://llm-agent.aplisay.com/api/phone-endpoints" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "phone-registration",
    "name": "SIP Reg A",
    "registrar": "sip:provider.example.com:5060",
    "username": "user123",
    "password": "secret",
    "options": {}
  }'
```

**Update a phone endpoint:**

```bash
curl -X PUT "https://llm-agent.aplisay.com/api/phone-endpoints/+1234567890" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "outbound": false,
    "handler": "livekit"
  }'
```

**Delete a phone endpoint:**

```bash
curl -X DELETE "https://llm-agent.aplisay.com/api/phone-endpoints/+1234567890" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Error Responses

- `400 Bad Request`: Invalid request data, validation failed, or trunk not found/not associated with organisation
- `401 Unauthorized`: Invalid or missing authentication
- `403 Forbidden`: Access denied (for PUT/DELETE operations)
- `404 Not Found`: Phone endpoint not found (for PUT/DELETE operations)
- `409 Conflict`: Phone number already exists (for POST operations)
- `500 Internal Server Error`: Database or server error

## Database Schema

Phone endpoints are stored in the `phone_numbers` table with the following structure:

- `number` (primary key): The phone number string
- `handler`: The handler type ("livekit" or "jambonz")
- `reservation`: Boolean flag for reservation status
- `outbound`: Boolean flag for outbound capability
- `aplisayId`: Optional Aplisay identifier
- `organisationId`: Foreign key to the organisation (automatically filtered by requestor's organisation)
- `createdAt`: Timestamp of creation
- `updatedAt`: Timestamp of last update

## Security

- Phone endpoints are automatically filtered by the authenticated user's organisation
- Users can only see endpoints belonging to their organisation
- The endpoint requires valid authentication
