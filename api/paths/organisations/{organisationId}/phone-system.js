import { Organisation, PhoneNumber, Extension } from '../../../../lib/database.js';
import { requirePermission } from '../../../../lib/auth/permissions.js';
import { targetInScope } from '../../../../lib/auth/admin-scope.js';
import { requirePhoneSystem } from '../../../../lib/capabilities.js';
import { toE164 } from '../../../../lib/directory/fields.js';

const ADDRESS_FIELDS = ['name', 'premises', 'thoroughfare', 'locality', 'postcode', 'businessSuffix'];

/** The address with only its known fields, or null when it is not an address. */
function cleanAddress(address) {
  if (!address || typeof address !== 'object' || Array.isArray(address)) return null;
  const out = {};
  for (const field of ADDRESS_FIELDS) {
    if (address[field] == null) continue;
    if (typeof address[field] !== 'string') return null;
    const value = address[field].trim().slice(0, 120);
    if (value) out[field] = value;
  }
  return out.name && out.thoroughfare && out.postcode ? out : null;
}

/**
 * /api/organisations/{id}/phone-system: the organisation's phone system
 * settings. An organisation admin acts on their own organisation. A platform
 * operator acts on any.
 */
export default function (logger) {
  const load = async (req, res, action) => {
    if (!requirePermission(res, 'organisation', action)) return null;
    const organisation = await Organisation.findByPk(req.params.organisationId);
    // 404 for another organisation too, so its existence is not confirmed.
    if (!organisation || !targetInScope(res.locals.user, 'organisation', organisation)) {
      res.status(404).send({ error: 'Organisation not found', code: 'not_found' });
      return null;
    }
    return organisation;
  };

  const shape = async (organisation) => {
    const numbers = await PhoneNumber.findAll({
      where: { organisationId: organisation.id },
      attributes: ['number', 'emergencyAddressMode'],
    });
    const withoutOwnNumber = await Extension.count({
      where: { organisationId: organisation.id, deletedAt: null, outboundNumber: null },
    });
    return {
      capabilities: organisation.capabilities || [],
      address: organisation.address ?? null,
      mainNumber: organisation.mainNumber ?? null,
      busyStatusVisible: organisation.busyStatusVisible !== false,
      numbersUsingAddress: numbers.filter((row) => !row.emergencyAddressMode || row.emergencyAddressMode === 'organisation').length,
      // An upper count: an extension with exactly one number shows that number, not the main one.
      extensionsUsingMainNumber: withoutOwnNumber,
    };
  };

  const get = async (req, res) => {
    const organisation = await load(req, res, 'read');
    if (!organisation) return;
    return res.send(await shape(organisation));
  };
  get.apiDoc = {
    summary: "Read an organisation's phone system settings.",
    operationId: 'getOrganisationPhoneSystem',
    tags: ['Organisations'],
    parameters: [{ in: 'path', name: 'organisationId', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'The settings', content: { 'application/json': { schema: { $ref: '#/components/schemas/OrganisationPhoneSystem' } } } },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const put = async (req, res) => {
    const organisation = await load(req, res, 'update');
    if (!organisation) return;
    if (!requirePhoneSystem(res, organisation)) return;
    const { address, mainNumber, busyStatusVisible } = req.body || {};
    const fields = {};
    if (address !== undefined) {
      fields.address = address === null ? null : cleanAddress(address);
      if (address !== null && !fields.address) {
        return res.status(400).send({ error: 'An address needs a name, a street and a postcode.', code: 'invalid_address', field: 'address' });
      }
    }
    if (mainNumber !== undefined) {
      const number = mainNumber === null ? null : toE164(String(mainNumber));
      const held = number && await PhoneNumber.findOne({
        where: { organisationId: organisation.id, number: number.replace(/^\+/, '') },
        attributes: ['id'],
      });
      if (mainNumber !== null && !held) {
        return res.status(400).send({ error: 'The main number must be one of the organisation\'s own numbers.', code: 'main_number_not_held', field: 'mainNumber' });
      }
      fields.mainNumber = number;
    }
    if (busyStatusVisible !== undefined) {
      if (typeof busyStatusVisible !== 'boolean') {
        return res.status(400).send({ error: 'busyStatusVisible must be true or false.', code: 'invalid_request', field: 'busyStatusVisible' });
      }
      fields.busyStatusVisible = busyStatusVisible;
    }
    await organisation.update(fields);
    logger.info({ audit: 'organisation-phone-system-set', organisationId: organisation.id, userId: res.locals.user?.id, fields: Object.keys(fields) },
      'organisation phone system settings changed');
    return res.send(await shape(organisation));
  };
  put.apiDoc = {
    summary: "Change an organisation's phone system settings.",
    description: 'Send only the fields to change. `mainNumber` is shown on calls from an extension that has no number of its own.',
    operationId: 'setOrganisationPhoneSystem',
    tags: ['Organisations'],
    parameters: [{ in: 'path', name: 'organisationId', required: true, schema: { type: 'string' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              address: { type: 'object', nullable: true, description: 'The default emergency address for the organisation\'s numbers.' },
              mainNumber: { type: 'string', nullable: true, description: 'One of the organisation\'s numbers, in E.164 form.' },
              busyStatusVisible: { type: 'boolean' },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'The settings after the change', content: { 'application/json': { schema: { $ref: '#/components/schemas/OrganisationPhoneSystem' } } } },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get, PUT: put };
}
