# Phone Registration Simulation

This document describes the phone registration lifecycle simulation implemented for testing purposes.

## Overview

The registration simulation is a temporary solution that simulates the phone registration lifecycle until a proper worker process is implemented. It automatically transitions phone registrations through various states with realistic timing and probability distributions.

## Lifecycle Flow

When a phone registration is activated via `POST /phone-endpoints/{id}/activate`, the simulation begins:

### 1. Initial State
- **Status**: `disabled` → `active`
- **State**: `initial` → `pending`
- **Timing**: Immediate

### 2. Registration Attempt
- **State**: `pending` → `registering`
- **Timing**: Random delay between 3-60 seconds

### 3. Registration Result
- **State**: `registering` → `registered` (75% probability) or `failed` (25% probability)
- **Timing**: Random delay between 3-10 seconds after step 2

### 4. State Flip (Optional)
- **State**: 50% chance to flip between `registered` ↔ `failed`
- **Timing**: Random delay between 120-240 seconds after step 3

### 5. Final Status Check
- **Status**: If state is `failed` after 300 seconds total, status becomes `failed`
- **Timing**: 300 seconds from activation

## Implementation

The simulation is implemented in `lib/registration-simulation.js` and uses:

- **Random delays**: `Math.random()` with configurable min/max ranges
- **Probability distributions**: 75% success rate, 50% flip rate
- **Timeout management**: Multiple `setTimeout` calls with cleanup
- **Database updates**: Direct updates to `PhoneRegistration` model

## Usage

The simulation starts automatically when:
1. A phone registration is created (status: `disabled`)
2. The registration is activated via the activate endpoint
3. The simulation begins immediately after activation

## Testing

Run the simulation tests:
```bash
npm test -- tests/registration-simulation-simple.test.mjs
```

## Future Replacement

This simulation will be replaced with a proper worker process that:
- Handles real SIP registration attempts
- Manages actual registration state
- Provides more reliable state transitions
- Supports configuration and monitoring
