/**
 * Brands. A brand is a label on an organisation that says which client front
 * end its customers use. Each brand has a row in `brands` that holds its
 * defaults for a new organisation.
 *
 * A service key may carry a brand (`auth_keys.brand`). A principal with a
 * brand reaches only organisations of that brand (lib/auth/admin-scope.js),
 * and an organisation it creates takes its brand.
 *
 * This module reads no database, so anything may import it.
 */
import { validateCapabilities } from './capabilities.js';

const BRAND_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** An error message for a brand id that cannot be stored, or null. */
export function validateBrandId(id) {
  if (typeof id !== 'string' || !BRAND_ID.test(id)) {
    return 'A brand id is 1 to 32 lower case letters, digits and hyphens, and starts with a letter or digit';
  }
  return null;
}

/** An error message for a brand's settings, or null. */
export function validateBrandFields({ name, defaultCapabilities } = {}) {
  if (name !== undefined && name !== null && (typeof name !== 'string' || name.trim().length > 120)) {
    return 'name must be a string of at most 120 characters';
  }
  if (defaultCapabilities !== undefined) return validateCapabilities(defaultCapabilities);
  return null;
}

/** The brand the principal acts for, or null. Set from its key by AuthKey.verify. */
export function principalBrand(user) {
  return user?._brand ?? null;
}

/** The capabilities a new organisation of this brand starts with. */
export function capabilitiesForNewOrganisation(brandRow) {
  const list = brandRow?.defaultCapabilities;
  return Array.isArray(list) ? [...new Set(list)] : [];
}

/*
 * Brands need the schema 74 upgrade (`tools/agent-admin.js upgrade-db`). On a
 * database without it, lib/database.js leaves `brand` out of the Organisation
 * and AuthKey models at boot and calls brandsMissing(). Brands then stay off
 * until the upgrade and a restart.
 */
let brandSchemaReady = true;

/** What schema 74 adds that these `information_schema.columns` rows lack. */
export function missingBrandSchema(rows) {
  const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const missing = ['organisations.brand', 'auth_keys.brand'].filter((column) => !have.has(column));
  if (!rows.some((r) => r.table_name === 'brands')) missing.push('brands');
  return missing;
}

export function brandsMissing() {
  brandSchemaReady = false;
}

export function brandsReady() {
  return brandSchemaReady;
}

/** An explicit list of organisation columns, without `brand` while brands are off. */
export function organisationAttributes(names) {
  return brandSchemaReady ? names : names.filter((name) => name !== 'brand');
}

export const BRANDS_NOT_READY = {
  error: 'Brands need a database upgrade. Run tools/agent-admin.js upgrade-db, then restart the API server.',
  code: 'brands_not_ready',
};
