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
/** Direction of service: we register out ('client', the default) or the customer's PBX registers to us ('registrar'). */
export type PhoneRegistrationMode = 'client' | 'registrar';
/** Registrar rows only. 'device' is reserved for the cell and not accepted yet. */
export type PhoneRegistrationKind = 'pbx';

/** One binding the owning regserver node holds for a registrar account, as mirrored onto the row. */
export interface RegistrationBinding {
  /** The Contact URI as the PBX sent it (often a private address). */
  contact: string;
  /** The socket's remote address, host:port — where the node actually sends. */
  received: string;
  transport: string;
  userAgent?: string | null;
  registeredAt: string; // ISO 8601
  expiresAt: string; // ISO 8601
  /** The node holding the socket; the same value as b2buaId. */
  node: string;
}

export interface PhoneRegistrationSchema {
  id: string; // UUID
  name: string | null;
  handler: string; // e.g., 'livekit', 'jambonz'
  outbound: boolean;
  registrar: string;
  /** B2BUA node external IP (`EXT_IP_ADDRESS`); set by aplisay-b2bua config-server when serving a registration to FreeSWITCH. */
  b2buaId?: string | null;
  username: string;
  password: string; // encrypted in DB
  options: Record<string, any> | null; // JSONB
  status: PhoneRegistrationStatus;
  state: PhoneRegistrationState;
  error: string | null;
  lastSeenAt: Date | null;
  organisationId: string | null;
  /** Registration trunk: the `trunks.id` this registration owns, null for a single line. */
  trunkId?: string | null;
  /** Where the regclient finds the dialled number on a trunk INVITE: 'request-uri' | 'to' | 'header:<Name>' | 'none'. */
  didSource?: string | null;
  /** ISO 3166-1 alpha-2 for national-format dialled numbers; null = platform default. */
  didCountry?: string | null;
  /** Direction of service; 'client' for every row created before schema 66. */
  mode: PhoneRegistrationMode;
  /** Registrar rows only: 'pbx'. Null for client rows. */
  kind?: PhoneRegistrationKind | null;
  /** Registrar rows only: bindings mirrored by the owning node; null or empty when nothing is registered. */
  bindings?: RegistrationBinding[] | null;
  bindingsUpdatedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const PhoneRegistrationStatusValues: PhoneRegistrationStatus[] = ['active', 'failed', 'disabled'];
export const PhoneRegistrationStateValues: PhoneRegistrationState[] = ['initial', 'registering', 'registered', 'failed'];
export const PhoneRegistrationModeValues: PhoneRegistrationMode[] = ['client', 'registrar'];
export const PhoneRegistrationKindValues: PhoneRegistrationKind[] = ['pbx'];

// Schema version for migration/validation tracking
export const SCHEMA_VERSION = 3;

