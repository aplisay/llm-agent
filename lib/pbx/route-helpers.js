/**
 * What every directory and phone route does first: check the permission, find
 * the organisation the request is about, and apply the capability gate.
 */
import { Organisation } from '../database.js';
import { requirePermission, can } from '../auth/permissions.js';
import { requirePhoneSystem } from '../capabilities.js';
import { sendPbxError } from './errors.js';

const NOT_FOUND = { error: 'Not found', code: 'not_found' };

/**
 * @returns {Promise<object|null>} `{ organisation, actor, dryRun }`, or null when a response has been sent
 */
export async function directoryContext(req, res, resource, action, { gate = false } = {}) {
  if (!requirePermission(res, resource, action)) return null;
  const user = res.locals.user;
  const asked = typeof req.query?.organisationId === 'string' && req.query.organisationId ? req.query.organisationId : null;
  let organisationId = user?.organisationId ?? null;
  if (asked && asked !== organisationId) {
    // 404, not 403: another organisation's existence is not confirmed.
    if (!can(user, 'directory', 'readAll')) {
      res.status(404).send(NOT_FOUND);
      return null;
    }
    organisationId = asked;
  }
  if (!organisationId) {
    res.status(403).send({ error: 'Organisation membership required', code: 'organisation_required' });
    return null;
  }
  // Read on each request, not from the cached login, so the switch takes effect at once.
  const organisation = await Organisation.findByPk(organisationId, { attributes: ['id', 'capabilities'] });
  if (!organisation) {
    res.status(404).send(NOT_FOUND);
    return null;
  }
  if (gate && !requirePhoneSystem(res, organisation)) return null;
  return {
    organisation,
    actor: { kind: 'user', userId: user?.isSystem ? null : user?.id ?? null },
    dryRun: String(req.query?.dryRun) === 'true',
  };
}

/** Run a handler body. A refusal thrown by the directory code becomes its own response. */
export async function attempt(res, log, fn) {
  try {
    await fn();
  } catch (err) {
    sendPbxError(res, err, log);
  }
}

/** Send the result of a write. A dry run always answers 200. */
export function sendWrite(res, result, status = 200) {
  res.status(result?.dryRun ? 200 : status).send(result);
}

export function sendNotFound(res, what = 'Not found') {
  res.status(404).send({ error: what, code: 'not_found' });
}
