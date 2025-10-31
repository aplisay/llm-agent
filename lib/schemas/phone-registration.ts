/**
 * Shared PhoneRegistration schema definition
 * 
 * This is the source of truth for PhoneRegistration structure.
 * Changes here should be reflected in both:
 * - llm-agent/lib/database.js (Sequelize model)
 * - aplisay-b2bua/config-server (TypeScript interface)
 * 
 * To keep in sync:
 * 1. Update this file when schema changes
 * 2. Update the Sequelize model in database.js to match
 * 3. Update the TypeScript interface/config in aplisay-b2bua
 */

export type PhoneRegistrationStatus = 'active' | 'failed' | 'disabled';
export type PhoneRegistrationState = 'initial' | 'registering' | 'registered' | 'failed';

export interface PhoneRegistrationSchema {
  id: string; // UUID
  name: string | null;
  handler: string; // e.g., 'livekit', 'jambonz'
  outbound: boolean;
  registrar: string; // SIP contact URI
  username: string;
  password: string; // encrypted in DB
  options: Record<string, any> | null; // JSONB
  status: PhoneRegistrationStatus;
  state: PhoneRegistrationState;
  error: string | null;
  lastSeenAt: Date | null;
  organisationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const PhoneRegistrationStatusValues: PhoneRegistrationStatus[] = ['active', 'failed', 'disabled'];
export const PhoneRegistrationStateValues: PhoneRegistrationState[] = ['initial', 'registering', 'registered', 'failed'];

// Schema version for migration/validation tracking
export const SCHEMA_VERSION = 1;

