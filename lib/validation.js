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
  
  // Basic SIP URI validation: (optional sip[s]:)[user@]domain[:port]
  // The sip:/sips: prefix is optional and will be stripped before saving
  // Transport parameter is now handled separately in options
  // Domain must contain at least one dot (to prevent invalid formats like "invalid-sip-uri")
  // Domain can be a hostname or IP address, but not localhost, 0.0.0.0, or RFC1918 private IPs
  const sipUriRegex = /^(?:sips?:)?(?:[a-zA-Z0-9._-]+@)?([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::[0-9]+)?$/;
  
  if (!sipUriRegex.test(uri)) {
    return false;
  }
  
  // Extract the host part (domain or IP) after stripping optional prefix and user part
  const stripped = uri.replace(/^sips?:/i, '');
  const hostMatch = stripped.match(/(?:[a-zA-Z0-9._-]+@)?([a-zA-Z0-9.-]+|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::[0-9]+)?$/);
  
  if (!hostMatch) {
    return false;
  }
  
  const host = hostMatch[1];
  
  // Reject localhost (case-insensitive)
  if (host.toLowerCase() === 'localhost') {
    return false;
  }
  
  // Reject 0.0.0.0
  if (host === '0.0.0.0') {
    return false;
  }
  
  // Check if it's an IP address and reject RFC1918 private IPs
  const ipRegex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const ipMatch = host.match(ipRegex);
  
  if (ipMatch) {
    const octet1 = parseInt(ipMatch[1], 10);
    const octet2 = parseInt(ipMatch[2], 10);
    const octet3 = parseInt(ipMatch[3], 10);
    const octet4 = parseInt(ipMatch[4], 10);
    
    // Validate IP address octets are in valid range
    if (octet1 > 255 || octet2 > 255 || octet3 > 255 || octet4 > 255) {
      return false;
    }
    
    // Reject RFC1918 private IP ranges:
    // 10.0.0.0/8 (10.0.0.0 - 10.255.255.255)
    // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
    // 192.168.0.0/16 (192.168.0.0 - 192.168.255.255)
    // 127.0.0.0/8 (127.0.0.0 - 127.255.255.255) - loopback
    
    if (octet1 === 10) {
      return false; // 10.0.0.0/8
    }
    
    if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) {
      return false; // 172.16.0.0/12
    }
    
    if (octet1 === 192 && octet2 === 168) {
      return false; // 192.168.0.0/16
    }
    
    if (octet1 === 127) {
      return false; // 127.0.0.0/8 (loopback)
    }
  }

  return true;
}

/**
 * Loosely validates that a value is a syntactically-plausible SIP host token.
 *
 * Accepts an optional sip[s]: scheme, an optional user@ part, one or more
 * hostname labels (single-label / non-FQDN names like an internal PBX name are
 * allowed) and an optional :port. Unlike {@link validateSipUri} this does NOT
 * require a routable FQDN or public IP; it only guarantees the value is a safe
 * hostname token with no whitespace or characters that could break the
 * generated FreeSWITCH gateway XML.
 *
 * Used for the registrar when a separately-configured, routable proxy
 * (`options.register_proxy`) carries reachability and the registrar is realm-only.
 * @param {string} uri - The host token to validate
 * @returns {boolean} - True if it is a plausible SIP host token
 */
export function isPlausibleSipHost(uri) {
  if (!uri || typeof uri !== 'string') {
    return false;
  }

  return /^(?:sips?:)?(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*(?::[0-9]+)?$/.test(uri.trim());
}

/**
 * Whether a registration's options supply a routable `register_proxy` — a
 * reachable FQDN or public IP. When present it carries reachability for the
 * gateway (it is the next hop the b2bua sends REGISTER/calls to), so the
 * registrar itself may be a non-FQDN host used only as the SIP realm/from-domain.
 * @param {object} options - The registration options object
 * @returns {boolean} - True if options.register_proxy is a routable SIP URI
 */
export function hasRoutableRegisterProxy(options) {
  const registerProxy = options?.register_proxy;
  return typeof registerProxy === 'string' && registerProxy.trim().length > 0 && validateSipUri(registerProxy);
}

/**
 * Validates phone registration data
 * @param {object} data - The registration data to validate
 * @returns {object} - Validation result with isValid and errors
 */
export function validatePhoneRegistration(data) {
  const errors = [];

  // A registration always needs a registrar (the SIP account identity / realm).
  // Historically the registrar also had to be a routable FQDN/public IP because
  // it doubled as the next hop. Some providers, however, use a non-FQDN host in
  // the registrar (e.g. an internal PBX name) while exposing an internet-reachable
  // proxy via `options.register_proxy`. When that routable register_proxy is
  // supplied it carries reachability, so the registrar only needs to be a
  // syntactically-plausible host (it is used as the SIP realm / from-domain).
  const registerProxyRoutable = hasRoutableRegisterProxy(data.options);

  if (!data.registrar || typeof data.registrar !== 'string' || !data.registrar.trim()) {
    errors.push('registrar is required and must be a non-empty string');
  } else if (validateSipUri(data.registrar)) {
    // Routable registrar — original behaviour, no proxy required.
  } else if (registerProxyRoutable) {
    if (!isPlausibleSipHost(data.registrar)) {
      errors.push('registrar must be a valid SIP host');
    }
  } else {
    errors.push('registrar must be a valid SIP contact URI, or options.register_proxy must be set to a routable FQDN or public IP');
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

  if (data.b2buaId !== undefined && data.b2buaId !== null) {
    if (typeof data.b2buaId !== 'string' || !data.b2buaId.trim()) {
      errors.push('b2buaId must be a non-empty string when provided');
    }
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


const DID_SOURCE_RE = /^(request-uri|to|none|header:[A-Za-z][A-Za-z0-9-]{0,63})$/;

/**
 * Registration-trunk fields. `didSource` names where the regclient finds the
 * dialled number on an inbound INVITE; `didCountry` is ISO 3166-1 alpha-2.
 * Both optional; returns the list of problems (empty when fine).
 */
export function validateRegistrationTrunkFields(data = {}) {
  const errors = [];
  if (data.trunk !== undefined && typeof data.trunk !== 'boolean') errors.push('trunk must be a boolean');
  if (data.didSource !== undefined && data.didSource !== null && !(typeof data.didSource === 'string' && DID_SOURCE_RE.test(data.didSource))) {
    errors.push("didSource must be 'request-uri', 'to', 'none' or 'header:<Header-Name>'");
  }
  if (data.didCountry !== undefined && data.didCountry !== null && !(typeof data.didCountry === 'string' && /^[A-Za-z]{2}$/.test(data.didCountry))) {
    errors.push('didCountry must be a two-letter ISO 3166-1 country code');
  }
  return errors;
}
