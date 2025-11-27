# Phone Numbers API

> **⚠️ DEPRECATED**: This API is deprecated and will be removed in a future version. Please use the [Phone Endpoints API](./phone-endpoints-api.md) instead, which provides all the functionality of this API plus additional features like pagination, CRUD operations, and support for SIP registration endpoints.

## Overview

The Phone Numbers API provides access to telephone numbers available to an organisation for use with agents. These numbers can be assigned to agent instances to handle incoming calls.

**Migration Guide**: To migrate from this API to the Phone Endpoints API:

- Replace `GET /api/phone-numbers` with `GET /api/phone-endpoints?type=e164-ddi`
- The response format is similar but wrapped in an `items` array with pagination metadata
- Use the `originate` and `handler` query parameters as before
- For additional functionality like creating/updating endpoints, use the full Phone Endpoints API

## Endpoints

### GET /api/phone-numbers

Returns a list of all phone numbers for the organisation of the requestor.

#### Query Parameters

- `originate` (boolean, optional): When set to `true`, filters the results to only return phone numbers that can be used for outbound calling (where `outbound=true` and `aplisayId` is not null)

#### Authentication

This endpoint requires authentication. The user's `organisationId` is automatically extracted from the authenticated user's session.

#### Response

Returns an array of phone number objects with the following structure:

```json
[
  {
    "number": "+1234567890",
    "handler": "jambonz",
    "outbound": true
  }
]
```

#### Filtering Logic

When the `originate=true` query parameter is provided, the endpoint applies the following filters:

1. **outbound=true**: Only returns phone numbers that support outbound calls
2. **aplisayId is not null**: Only returns phone numbers that have an Aplisay ID assigned

This filter is useful when you need to find phone numbers that can be used for originating outbound calls.

#### Response Fields

- `number` (string): The phone number
- `handler` (string): The handler type for this phone number (either "livekit" or "jambonz")
- `outbound` (boolean): Whether this number supports outbound calls

#### Example Usage

**Get all phone numbers:**

```bash
curl -X GET "https://llm-agent.aplisay.com/api/phone-numbers" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Get only outbound-capable phone numbers:**

```bash
curl -X GET "https://llm-agent.aplisay.com/api/phone-numbers?originate=true" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

#### Error Responses

- `401 Unauthorized`: Invalid or missing authentication
- `500 Internal Server Error`: Database or server error

## Database Schema

Phone numbers are stored in the `phone_numbers` table with the following structure:

- `number` (primary key): The phone number string
- `handler`: The handler type ("livekit" or "jambonz")
- `reservation`: Boolean flag for reservation status
- `outbound`: Boolean flag for outbound capability
- `aplisayId`: Optional Aplisay identifier
- `organisationId`: Foreign key to the organisation (automatically filtered by requestor's organisation)
- `createdAt`: Timestamp of creation
- `updatedAt`: Timestamp of last update

## Security

- Phone numbers are automatically filtered by the authenticated user's organisation
- Users can only see phone numbers belonging to their organisation
- The endpoint requires valid authentication
