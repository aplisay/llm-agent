# Originate Call API

## Overview

The Originate Call API allows you to validate and originate outbound calls from an agent using a caller number to a called number. This endpoint performs comprehensive validation including organization access control and UK phone number validation.

## Endpoints

### POST /api/agents/{agentId}/originate

Validates and originates a call from an agent using a caller number to a called number.

#### Authentication

This endpoint requires authentication. The user's `organisationId` is automatically extracted from the authenticated user's session.

#### Request Parameters

**Path Parameters:**
- `agentId` (string, required): The ID of the agent to originate the call from

**Request Body:**
```json
{
  "calledId": "+447911123456",
  "callerId": "+442080996945"
}
```

- `calledId` (string, required): The phone number to call (must be a valid UK geographic or mobile number)
- `callerId` (string, required): The phone number to call from (must exist in phoneNumbers table and belong to the organization)

#### Validation Rules

1. **Agent Validation**: The agent must exist and belong to the authenticated user's organization
2. **Caller Number Validation**: The `callerId` must exist in the phoneNumbers table and belong to the authenticated user's organization
3. **Called Number Validation**: The `calledId` must be a valid UK geographic or mobile number

#### UK Phone Number Validation

The endpoint validates UK phone numbers according to the following rules:

**Valid UK Mobile Numbers:**
- Start with +44 or 44
- National number starts with 7
- Must be exactly 10 digits after removing +44/44 prefix
- Examples: +447911123456, 447911123456

**Valid UK Geographic Numbers:**
- Start with +44 or 44
- National number starts with 1, 2, 3, 5, 8, or 9 (excluding 7 which is mobile)
- Must be 10-11 digits after removing +44/44 prefix
- Examples: +442080996945, +441234567890

#### Response

**Success Response (200):**
```json
{
  "success": true,
  "message": "Call origination request validated successfully",
  "data": {
    "agentId": "agent-123",
    "callerId": "+442080996945",
    "calledId": "+447911123456",
    "organisationId": "org-456"
  }
}
```

**Error Responses:**

- `400 Bad Request`: Missing parameters or invalid UK phone number
  ```json
  {
    "error": "Missing required parameters: calledId and callerId are required"
  }
  ```

- `403 Forbidden`: Access denied
  ```json
  {
    "error": "Access denied: Agent does not belong to your organization"
  }
  ```

- `404 Not Found`: Agent or caller phone number not found
  ```json
  {
    "error": "Agent agent-123 not found"
  }
  ```

- `500 Internal Server Error`: Server error
  ```json
  {
    "error": "Internal server error"
  }
  ```

#### Example Usage

```bash
curl -X POST "https://llm-agent.aplisay.com/api/agents/agent-123/originate" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "calledId": "+447911123456",
    "callerId": "+442080996945"
  }'
```

#### Security

- **Organization Isolation**: Users can only originate calls from agents and phone numbers belonging to their organization
- **Authentication Required**: Valid authentication is required to access this endpoint
- **Input Validation**: Comprehensive validation of all input parameters
- **UK Number Validation**: Strict validation of UK phone number formats

#### Database Requirements

The endpoint requires the following database relationships:

- **Agent** model with `organisationId` field
- **PhoneNumber** model with `organisationId` field
- **User** model with `organisationId` field (for authentication)

#### Error Handling

The endpoint provides detailed error messages for different failure scenarios:

1. **Missing Parameters**: Clear indication of which required parameters are missing
2. **Invalid UK Numbers**: Specific validation errors for UK phone number format
3. **Access Control**: Clear access denied messages for organization mismatches
4. **Not Found**: Specific error messages for missing agents or phone numbers

#### Integration Notes

- This endpoint is designed for validation and can be extended to actually initiate calls
- The validation logic can be reused for other call-related endpoints
- UK phone number validation follows standard UK numbering plan rules
- Organization-based access control ensures data isolation between organizations
