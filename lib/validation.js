/**
 * Validation utilities for phone numbers and SIP URIs
 */

/**
 * Validates E.164 phone number format
 * @param {string} number - The phone number to validate
 * @returns {boolean} - True if valid E.164 format
 */
export function validateE164(number) {
  if (!number || typeof number !== 'string') {
    return false;
  }
  
  // Remove leading + if present
  const normalized = number.startsWith('+') ? number.slice(1) : number;
  
  // E.164 format: 1-15 digits, starting with country code
  const e164Regex = /^[1-9]\d{0,14}$/;
  
  return e164Regex.test(normalized) && normalized.length >= 7 && normalized.length <= 15;
}

/**
 * Normalizes E.164 phone number (removes + prefix)
 * @param {string} number - The phone number to normalize
 * @returns {string} - Normalized E.164 number without +
 */
export function normalizeE164(number) {
  if (!number || typeof number !== 'string') {
    return null;
  }
  
  return number.startsWith('+') ? number.slice(1) : number;
}

/**
 * Validates SIP contact URI format
 * @param {string} uri - The SIP URI to validate
 * @returns {boolean} - True if valid SIP URI format
 */
export function validateSipUri(uri) {
  if (!uri || typeof uri !== 'string') {
    return false;
  }
  
  // Basic SIP URI validation: sip[s]:[user@]domain[:port][;transport=...]
  const sipUriRegex = /^sips?:(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9.-]+(?::[0-9]+)?(?:;transport=(?:tcp|udp|tls|TCP|UDP|TLS))?$/;
  
  return sipUriRegex.test(uri);
}

/**
 * Validates phone registration data
 * @param {object} data - The registration data to validate
 * @returns {object} - Validation result with isValid and errors
 */
export function validatePhoneRegistration(data) {
  const errors = [];
  
  if (!data.registrar || !validateSipUri(data.registrar)) {
    errors.push('registrar must be a valid SIP contact URI');
  }
  
  if (!data.username || typeof data.username !== 'string' || data.username.trim().length === 0) {
    errors.push('username is required and must be a non-empty string');
  }
  
  if (!data.password || typeof data.password !== 'string' || data.password.trim().length === 0) {
    errors.push('password is required and must be a non-empty string');
  }
  
  if (data.options && typeof data.options !== 'object') {
    errors.push('options must be an object if provided');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Validates e164-ddi data
 * @param {object} data - The e164-ddi data to validate
 * @returns {object} - Validation result with isValid and errors
 */
export function validateE164Ddi(data) {
  const errors = [];
  
  if (!data.phoneNumber || !validateE164(data.phoneNumber)) {
    errors.push('phoneNumber must be a valid E.164 number (with or without +)');
  }
  
  if (!data.trunkId || typeof data.trunkId !== 'string' || data.trunkId.trim().length === 0) {
    errors.push('trunkId is required and must be a non-empty string');
  }
  
  if (data.outbound !== undefined && typeof data.outbound !== 'boolean') {
    errors.push('outbound must be a boolean value');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}
