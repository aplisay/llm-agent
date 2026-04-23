# Number lifecycle: adding a phone number (DDI) on Aplisay

This document describes the end-to-end lifecycle for adding an **E.164 DDI phone number** to Aplisay, from external trunk provisioning through to verifying that calls are reaching the Aplisay platform.

## Overview

Adding a number generally has **two provisioning layers**:

- **External telco / trunk provider provisioning**: controls whether the global PSTN routes the number to your trunk.
- **Aplisay internal provisioning**: controls whether Aplisay has created/configured the number and has completed any additional backend provisioning steps required for the platform to accept and route calls.

To verify success, you should check **both**:

- The number’s **`provisioned`** flag in Aplisay (internal readiness)
- The number’s **`callReceived`** timestamp in Aplisay (proof at least one inbound call reached the Aplisay platform)

## Lifecycle steps

### 1) Provision the number (or range) on the external trunk provider

Provision the number range on your trunk with your external telco/trunk provider.

- This *should* cause the PSTN to begin routing the number(s) to the configured trunk.
- Any mistakes here (wrong trunk target, missing routing, typos, incomplete activation) will prevent inbound calls from ever reaching Aplisay, regardless of Aplisay-side configuration.

### 2) Create the number(s) in Aplisay using the create API

Once the provider-side trunk routing is configured, create the number(s) in Aplisay using the Phone Endpoints create API.

- Endpoint: `POST /api/phone-endpoints`
- Type: `e164-ddi`
- You associate the number(s) with a trunk via `trunkId`.
- Request body fields (per staging OpenAPI):
  - `number` (required): E.164 phone number **with or without** a leading `+`
  - `trunkId` (required): trunk identifier
  - `outbound` (optional): whether this endpoint supports outbound calls (must be supported by the trunk)

Notes:

- Creating the number(s) in Aplisay does **not** itself guarantee they are routable from the PSTN.
- It only establishes the Aplisay-side records and kicks off the internal provisioning lifecycle.
- On success, the API returns HTTP 201 and the created `number` value (returned **without** a leading `+`).
- Creation is only the start: the number rows will exist in the Aplisay database, but **further backend provisioning steps may still be required** before inbound calls route correctly through the Aplisay platform. This is what the `provisioned` flag represents.

### 3) Wait for `provisioned=true` (Aplisay internal provisioning complete)

Once **`provisioned` becomes `true`**, the number should be considered **routable within the Aplisay platform**.

Important clarification:

- `provisioned=true` means **Aplisay’s internal provisioning steps have completed**.
- It does **not** guarantee the number is reachable from the PSTN. PSTN reachability depends on step 1 being correctly completed by the trunk provider.

### 4) Place a test call to the number

Place an inbound test call to the number from the PSTN.

- You may place this test call **with or without** an agent listener assigned to the number.
- The goal here is to confirm the call reaches Aplisay at all.

### 5) Verify `callReceived` on the number via GET

Perform a GET for that phone endpoint.

- Endpoint: `GET /api/phone-endpoints/{identifier}`
  - Where `{identifier}` is the phone number (E.164, with or without `+`)

If the response contains a non-null **`callReceived`** timestamp:

- At least one inbound call reached the Aplisay platform successfully.
- The number can be considered **provisioned and routable** *from the perspective of reaching Aplisay*.

If **`callReceived` is still null** after a test call:

- Aplisay has not observed an inbound call arriving for that number.
- Proceed to troubleshooting (below).

## Troubleshooting when `callReceived` is not set

If step 6 fails (i.e., you placed a test call but `callReceived` is still null):

- Re-check **step 1** with the trunk provider:
  - Confirm the number/range is correctly activated.
  - Confirm PSTN routing targets the correct trunk.
  - Confirm there are no typos in the manual provisioning process (number range, trunk identifier, routing destination, etc.).
  - Confirm there are no pending/partial provisioning states on the provider side.

Do not attempt to delete and recreate the DDI on the Aplisay platform at this point. At best it will do nothing, at worst it will take the whole process back to step 3, hampering your and the provider's ability to diagnose a routing issue in step 1 which will almost certainly be the root cause.

Only delete the number if there is a material error in the data used in the first create call (number typo, wrong trunk), in which case delete the erroneous creation restart the whole Aplisay side process at step 2.

## Important note: a listener is NOT required to set `callReceived`

It is **not necessary** to link an agent listener to a number to confirm receipt of a call.

- The `callReceived` field is set by the **arrival of an inbound call** on the Aplisay agent platform.
- It may be set even if an agent cannot be dispatched (for example, because **no listener** is configured for that number).

