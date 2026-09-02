import { PhoneNumber, PhoneRegistration, Trunk, Organisation, Agent, Instance, Op } from '../../lib/database.js';
import { getTelephonyHandler, HANDLER_NAMES, TELEPHONY_HANDLER_NAMES } from '../../lib/handlers/index.js';
import { validateE164, normalizeE164, validateSipUri, validatePhoneRegistration, validateE164Ddi, validateRegistrationTrunkFields } from '../../lib/validation.js';
import { scopeWhereForOrganisation } from '../../lib/scope.js';
import { requirePermission, can } from '../../lib/auth/permissions.js';

let appParameters, log;

export default function (logger, voices, wsServer) {
  (appParameters = {
    logger,
    voices,
    wsServer
  });
  log = logger;
  return {
    GET: phoneEndpointList,
    POST: createPhoneEndpoint
  };
}

/** Hide linked Instance (and thus Agent) when the caller may not see that listener. */
function stripPhoneNumberInstancesForUser(rows, user) {
  const userId = user?.id;
  const organisationId = user?.organisationId;
  for (const r of rows) {
    if (
      r.Instance &&
      r.Instance.userId !== userId &&
      (!organisationId || r.Instance.organisationId !== organisationId)
    ) {
      r.Instance = null;
    }
  }
}

const phoneEndpointList = (async (req, res) => {
  if (!requirePermission(res, 'phoneEndpoint', 'read')) return;
  let { originate, handler, type, offset, pageSize, search, trunkId: rawTrunkId } = req.query;
  const trunkIds = [].concat(rawTrunkId ?? []).map((id) => String(id).trim()).filter(Boolean);

  try {
    const startOffset = Math.max(0, parseInt(offset || '0', 10) || 0);
    const size = Math.min(200, Math.max(1, parseInt(pageSize || '50', 10) || 50));

    const telephonyHandler = handler ? await getTelephonyHandler(handler) : null;

    // PhoneNumber (DDI) is shown to org members AND exposes the admin pool of
    // unallocated numbers (organisationId IS NULL) so callers can claim from
    // it. No-org users see only the pool — and must never see another org's
    // numbers, hence the explicit null branch rather than relying on
    // `{ organisationId: maybeNull }` and JS coercion.
    const orgScope = scopeWhereForOrganisation(res.locals.user);
    const numberWhere = orgScope
      ? { [Op.or]: [orgScope, { organisationId: { [Op.eq]: null } }] }
      : { organisationId: { [Op.eq]: null } };
    if (originate) {
      numberWhere.outbound = true;
      numberWhere.aplisayId = { [Op.ne]: null };
    }
    if (telephonyHandler) {
      numberWhere.handler = telephonyHandler;
    }
    if (search && String(search).trim()) {
      const digits = String(search).trim().replace(/^\+/, '');
      numberWhere.number = { [Op.iLike]: `%${digits}%` };
    }
    if (trunkIds.length > 0) {
      numberWhere.aplisayId = trunkIds.length === 1 ? trunkIds[0] : { [Op.in]: trunkIds };
    }

    // PhoneRegistration is strictly org-owned (there is no admin pool). A
    // no-org user must see nothing here; previously the bare
    // `{ organisationId: null }` filter leaked every other no-org tenant's
    // registrations into the response.
    if (!orgScope) {
      // Short-circuit before any DB call. Caller-visible behaviour: empty
      // registration list, no DDI rows beyond the unallocated pool.
      if (type === 'phone-registration') {
        return res.send({ items: [], nextOffset: null });
      }
    }
    const regWhere = orgScope ? { ...orgScope } : null;
    if (regWhere && originate) {
      regWhere.outbound = true;
    }
    if (regWhere && telephonyHandler) {
      regWhere.handler = telephonyHandler;
    }

    // If only one type requested, short-circuit and return that type paginated
    if (type === 'e164-ddi') {
      const rows = await PhoneNumber.findAll({
        where: numberWhere,
        attributes: ['number', 'handler', 'outbound', 'aplisayId', 'provisioned', 'callReceived', 'createdAt', 'instanceId'],
        include: [
          {
            model: Instance,
            required: false,
            // userId and organisationId are required for the visibility check below; without them
            // every row appears cross-org and Instance (hence agent) is stripped for org users.
            attributes: ['id', 'userId', 'organisationId'],
            // userId and organisationId are required for the visibility check below; without them
            // every row appears cross-org and Instance (hence agent) is stripped for org users.
            attributes: ['id', 'userId', 'organisationId'],
            include: [
              { model: Agent, required: false, attributes: ['id', 'name'] }
            ]
          }
        ],
        order: [['number', 'ASC']],
        limit: size,
        offset: startOffset
      });

      stripPhoneNumberInstancesForUser(rows, res.locals.user);
      stripPhoneNumberInstancesForUser(rows, res.locals.user);

      const items = rows.map(r => ({
        number: r.number,
        handler: r.handler,
        outbound: !!r.outbound,
        trunkId: r.aplisayId || null,
        callReceived: r.callReceived ? r.callReceived.toISOString() : null,
        createdAt: r.createdAt ? r.createdAt.toISOString() : null,
        inUse: !!r.instanceId,
        agentId: r.Instance?.Agent?.id ?? null,
        agentName: r.Instance?.Agent?.name ?? null,
        provisioned: !!r.provisioned
      }));
      const nextOffset = rows.length === size ? startOffset + size : null;
      return res.send({ items, nextOffset });
    }
    if (type === 'phone-registration') {
      // The no-org early return above already handled the !regWhere case.
      const rows = await PhoneRegistration.findAll({
        where: regWhere,
        limit: size,
        offset: startOffset
      });
      const items = rows.map(r => ({
        id: r.id,
        name: r.name,
        registrar: r.registrar,
        username: r.username,
        b2buaId: r.b2buaId || null,
        status: r.status,
        state: r.state,
        handler: r.handler,
        outbound: !!r.outbound,
        trunkId: r.trunkId || null,
        trunk: !!r.trunkId
      }));
      const nextOffset = rows.length === size ? startOffset + size : null;
      return res.send({ items, nextOffset });
    }

    // Both types: fetch a window from each, merge, and page. No-org users
    // skip the registration query entirely (no rows are theirs to see).
    const [numRows, regRows] = await Promise.all([
      PhoneNumber.findAll({
        where: numberWhere,
        attributes: ['number', 'handler', 'outbound', 'aplisayId', 'provisioned', 'createdAt', 'instanceId'],
        include: [
          {
            model: Instance,
            required: false,
            attributes: ['id', 'userId', 'organisationId'],
            include: [{ model: Agent, required: false, attributes: ['id', 'name'] }]
          }
        ],
        attributes: ['number', 'handler', 'outbound', 'aplisayId', 'provisioned', 'callReceived', 'createdAt', 'instanceId'],
        include: [
          {
            model: Instance,
            required: false,
            attributes: ['id', 'userId', 'organisationId'],
            include: [{ model: Agent, required: false, attributes: ['id', 'name'] }]
          }
        ],
        order: [['number', 'ASC']],
        limit: size,
        offset: startOffset
      }),
      regWhere
        ? PhoneRegistration.findAll({
            where: regWhere,
            attributes: ['id', 'name', 'registrar', 'username', 'b2buaId', 'status', 'state', 'handler', 'outbound', 'callReceived', 'createdAt', 'trunkId'],
            limit: size,
            offset: startOffset
          })
        : Promise.resolve([])
    ]);

    stripPhoneNumberInstancesForUser(numRows, res.locals.user);

    stripPhoneNumberInstancesForUser(numRows, res.locals.user);

    const mappedNumbers = numRows.map(n => ({
      number: n.number,
      handler: n.handler,
      outbound: !!n.outbound,
      trunkId: n.aplisayId || null,
      provisioned: !!n.provisioned,
      callReceived: n.callReceived ? n.callReceived.toISOString() : null,
      inUse: !!n.instanceId,
      agentId: n.Instance?.Agent?.id ?? null,
      agentName: n.Instance?.Agent?.name ?? null,
      _createdAt: n.createdAt
    }));
    const mappedRegs = regRows.map(r => ({
      id: r.id,
      name: r.name,
      registrar: r.registrar,
      username: r.username,
      b2buaId: r.b2buaId || null,
      trunkId: r.trunkId || null,
      trunk: !!r.trunkId,
      status: r.status,
      state: r.state,
      handler: r.handler,
      outbound: !!r.outbound,
      callReceived: r.callReceived ? r.callReceived.toISOString() : null,
      _createdAt: r.createdAt
    }));

    const merged = [...mappedNumbers, ...mappedRegs]
      .sort((a, b) => new Date(b._createdAt) - new Date(a._createdAt))
      .slice(0, size)
      .map(({ _createdAt, ...rest }) => rest);

    const nextOffset = (numRows.length === size || regRows.length === size) ? startOffset + size : null;
    return res.send({ items: merged, nextOffset });
  }
  catch (err) {
    req.log.error(err, 'listing phone endpoints');
    res.status(500).send(err);
  }
});

const createPhoneEndpoint = async (req, res) => {
  if (!requirePermission(res, 'phoneEndpoint', 'claim')) return;
  const { organisationId } = res.locals.user;
  const { type, ...data } = req.body;

  try {
    if (!type || !['e164-ddi', 'phone-registration'].includes(type)) {
      return res.status(400).send({
        error: 'Invalid type. Must be either "e164-ddi" or "phone-registration"'
      });
    }

    if (type === 'e164-ddi') {
      // Support public field name `number`; keep backward-compat with `phoneNumber`
      data.phoneNumber = data.phoneNumber || data.number;
      const validation = validateE164Ddi(data);
      if (!validation.isValid) {
        return res.status(400).send({
          error: 'Validation failed',
          details: validation.errors
        });
      }

      const normalizedNumber = normalizeE164(data.phoneNumber);
      
      // A number is unique per organisation and per trunk (schema 61), not
      // platform-wide: another organisation holding the same number on its
      // own trunk is not a conflict. The unique indexes are the backstop for
      // the race this pre-check cannot close.
      const existingNumber = await PhoneNumber.findOne({
        where: {
          number: normalizedNumber,
          [Op.or]: [
            { organisationId: organisationId ?? null },
            { aplisayId: data.trunkId },
          ],
        },
      });
      if (existingNumber) {
        return res.status(409).send({
          error: existingNumber.aplisayId === data.trunkId && existingNumber.organisationId !== (organisationId ?? null)
            ? 'Phone number already exists on this trunk'
            : 'Phone number already exists'
        });
      }

      // Resolve the trunk. Chargeable trunks are shared platform carrier trunks
      // (our public inbound/outbound trunks) that organisations consume but do
      // not own — any org may allocate a number onto one (capped downstream by
      // chargeableNumberLimit). Non-chargeable trunks are customer BYO/PBX/
      // registration trunks and MUST be associated with the caller's org.
      const trunk = await Trunk.findByPk(data.trunkId);
      if (!trunk) {
        return res.status(400).send({
          error: 'Trunk not found'
        });
      }
      if (!trunk.chargeable) {
        const ownedByOrg = organisationId
          ? await trunk.hasOrganisation(organisationId)
          : false;
        if (!ownedByOrg) {
          return res.status(400).send({
            error: 'Trunk not found or not associated with your organisation'
          });
        }
      }

      // Determine outbound behaviour: cannot exceed trunk's outbound capability
      const requestedOutbound = data.outbound ?? false;
      if (requestedOutbound && !trunk.outbound) {
        return res.status(400).send({
          error: 'Outbound calling is not enabled on the selected trunk'
        });
      }

      // Numbers on chargeable trunks (carrier trunks shared into the org, i.e.
      // not owned by it) are capped by Organisation.chargeableNumberLimit
      // (null = unlimited). Count + create share a transaction behind a FOR
      // UPDATE lock on the organisation row so concurrent claims cannot race
      // past the limit. Numbers on the org's own trunks are never counted.
      let phoneNumber;
      try {
        phoneNumber = await PhoneNumber.sequelize.transaction(async (transaction) => {
          if (trunk.chargeable && organisationId) {
            const org = await Organisation.findByPk(organisationId, {
              transaction,
              lock: transaction.LOCK.UPDATE,
            });
            const limit = org?.chargeableNumberLimit ?? null;
            if (limit != null) {
              const chargeableTrunks = await Trunk.findAll({
                where: { chargeable: true },
                attributes: ['id'],
                transaction,
              });
              const used = await PhoneNumber.count({
                where: {
                  organisationId,
                  aplisayId: { [Op.in]: chargeableTrunks.map((t) => t.id) },
                },
                transaction,
              });
              if (used >= limit) {
                const err = new Error(`Chargeable number limit reached (${used} of ${limit} in use)`);
                err.code = 'chargeable_number_limit';
                err.limit = limit;
                err.used = used;
                throw err;
              }
            }
          }
          return PhoneNumber.create({
            number: normalizedNumber,
            // Handler is always derived from the trunk (or defaulted) and cannot be chosen by the caller for DDI endpoints
            handler: trunk.handler || 'livekit',
            outbound: requestedOutbound,
            organisationId: organisationId,
            // Internally store the trunk association using the aplisayId foreign key
            aplisayId: data.trunkId
          }, { transaction });
        });
      } catch (err) {
        if (err.code === 'chargeable_number_limit') {
          return res.status(403).send({
            error: err.message,
            code: err.code,
            limit: err.limit,
            used: err.used
          });
        }
        // The pre-check above races exact simultaneous claims; the unique
        // indexes are the backstop — report it as the same conflict.
        if (err.name === 'SequelizeUniqueConstraintError') {
          return res.status(409).send({
            error: 'Phone number already exists'
          });
        }
        throw err;
      }

      return res.status(201).send({
        success: true,
        number: phoneNumber.number,
        trunkId: data.trunkId
      });
    }

    if (type === 'phone-registration') {
      if (!organisationId) {
        return res.status(403).send({
          error: 'Phone registrations require an organisation membership'
        });
      }

      const validation = validatePhoneRegistration(data);
      const trunkErrors = validateRegistrationTrunkFields(data);
      if (!validation.isValid || trunkErrors.length) {
        return res.status(400).send({
          error: 'Validation failed',
          details: [...validation.errors, ...trunkErrors]
        });
      }
      // A registration trunk owns a trunks row. Its id defaults to reg-<uuid>;
      // naming it is a super's privilege (an SBC trunk being migrated keeps its
      // id, and with it its numbers).
      const wantsTrunk = data.trunk === true;
      const requestedTrunkId = typeof data.trunkId === 'string' ? data.trunkId.trim() : '';
      if (requestedTrunkId && !wantsTrunk) {
        return res.status(400).send({ error: 'trunkId is only meaningful with trunk: true' });
      }
      if (requestedTrunkId && !can(res.locals.user, 'trunk', 'create')) {
        return res.status(403).send({ error: 'Naming the trunk requires trunk:create' });
      }
      if (requestedTrunkId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestedTrunkId)) {
        return res.status(400).send({ error: 'trunkId must be 1–128 chars, letters/digits/._- and start alphanumeric' });
      }
      if (requestedTrunkId && (await Trunk.findByPk(requestedTrunkId))) {
        return res.status(409).send({ error: `Trunk ${requestedTrunkId} already exists` });
      }

      // Strip sip:/sips: prefix from registrar if present before saving
      const normalizedRegistrar = data.registrar?.replace(/^sips?:/i, '') || data.registrar;

      // Check for duplicate registration (same registrar and username)
      const existingRegistration = await PhoneRegistration.findOne({
        where: {
          registrar: normalizedRegistrar,
          username: data.username,
          organisationId: organisationId
        }
      });

      if (existingRegistration) {
        return res.status(409).send({
          error: 'Phone registration with the same registrar and username already exists'
        });
      }

      const record = await PhoneRegistration.sequelize.transaction(async (transaction) => {
        const reg = await PhoneRegistration.create({
          name: data.name,
          handler: data.handler ?? 'livekit',
          outbound: data.outbound ?? false,
          registrar: normalizedRegistrar,
          username: data.username,
          password: data.password,
          b2buaId: data.b2buaId != null && String(data.b2buaId).trim() ? String(data.b2buaId).trim() : null,
          options: data.options || null,
          organisationId,
          status: 'disabled',
          state: 'initial',
          didSource: data.didSource ?? null,
          didCountry: data.didCountry ? String(data.didCountry).toUpperCase() : null,
        }, { transaction });
        if (wantsTrunk) {
          const trunk = await createRegistrationTrunk(reg, requestedTrunkId || null, organisationId, transaction);
          await reg.update({ trunkId: trunk.id }, { transaction });
        }
        return reg;
      });

      return res.status(201).send({ success: true, id: record.id, trunkId: record.trunkId || null });
    }
  } catch (err) {
    req.log.error(err, 'Error creating phone endpoint');
    return res.status(500).send({
      error: 'Internal server error'
    });
  }
};

/**
 * The trunks row a registration trunk owns: id reg-<uuid> unless named, the
 * registration's handler and outbound, never chargeable, flagged so the
 * reverse lookup (number → trunk → registration) works, and assigned to the
 * organisation so the e164-ddi create path accepts numbers on it.
 */
export async function createRegistrationTrunk(registration, trunkId, organisationId, transaction) {
  const trunk = await Trunk.create({
    id: trunkId || `reg-${registration.id}`,
    name: registration.name || registration.registrar,
    handler: registration.handler,
    outbound: !!registration.outbound,
    chargeable: false,
    flags: { provider: 'registration', registrationId: registration.id },
  }, { transaction });
  await trunk.addOrganisation(organisationId, { transaction });
  return trunk;
}

phoneEndpointList.apiDoc = {
  summary: 'Returns a list of all phone endpoints for the organisation of the requestor. Optionally filter to only certain endpoint types.',
  description: `Returns a paginated list of phone endpoints for the caller\'s organisation. 
                Phone endpoints are used to assign numbers that then route via handlers and listeners to agents.
                Both E.164 DDI number and phone SIPregistration endpoints are supported.
                DDI numbers are assigned to trunks which are then used to route calls to agents.
                SIP registration endpoints are used to register with a SIP provider and identified by a unique
                non phone number like ID (UUID).`,
  operationId: 'listPhoneEndpoints',
  tags: ["Phone Endpoints"],
  parameters: [
    {
      description: "Filter to only return endpoints that can be used for outbound calling (outbound=true and assigned to a trunk)",
      in: 'query',
      name: 'originate',
      required: false,
      schema: {
        type: 'boolean'
      }
    },
    {
      description: "Filter to only return endpoints using the specified handler. Handler names are mapped to their telephony handlers (e.g., 'ultravox' maps to 'jambonz')",
      in: 'query',
      name: 'handler',
      required: false,
      schema: {
        type: 'string',
        enum: HANDLER_NAMES
      }
    },
    {
      description: "Filter by endpoint type",
      in: 'query',
      name: 'type',
      required: false,
      schema: {
        type: 'string',
        enum: ['e164-ddi', 'phone-registration']
      }
    },
    {
      description: "Filter E.164 DDI numbers by partial number match (digits only from search string)",
      in: 'query',
      name: 'search',
      required: false,
      schema: { type: 'string' }
    },
    {
      description: "Filter E.164 DDI numbers to those assigned to these trunk ID(s). May be repeated for multiple trunks.",
      in: 'query',
      name: 'trunkId',
      required: false,
      schema: { type: 'array', items: { type: 'string' } }
    },
    {
      description: "Offset (0-based)",
      in: 'query',
      name: 'offset',
      required: false,
      schema: {
        type: 'integer',
        minimum: 0,
        default: 0
      }
    },
    {
      description: "Page size (max 200)",
      in: 'query',
      name: 'pageSize',
      required: false,
      schema: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        default: 50
      }
    }
  ],
  responses: {
    200: {
      description: 'List of phone endpoints.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  oneOf: [
                    {
                      type: 'object',
                      description: 'E.164 DDI endpoint',
                      required: ['number', 'handler', 'outbound'],
                      properties: {
                        name: { type: 'string', description: 'User-defined descriptive name', nullable: true },
                        number: { type: 'string', description: 'The phone number' },
                        handler: { type: 'string', enum: TELEPHONY_HANDLER_NAMES, description: 'The handler type for this phone endpoint' },
                        outbound: { type: 'boolean', description: 'Whether this endpoint supports outbound calls', default: false },
                        trunkId: { type: 'string', nullable: true, description: 'Trunk this number is assigned to' },
                        createdAt: { type: 'string', format: 'date-time', nullable: true, description: 'When the number was created' },
                        inUse: { type: 'boolean', description: 'Whether the number is linked to an agent instance' }
                      }
                    },
                    {
                      type: 'object',
                      description: 'Phone registration endpoint',
                      required: ['id', 'handler', 'outbound'],
                      properties: {
                        name: { type: 'string', description: 'User-defined descriptive name', nullable: true },
                        id: { type: 'string', description: 'The registration ID' },
                        registrar: { type: 'string', description: 'SIP contact URI (without sip:/sips: prefix)' },
                        username: { type: 'string', description: 'Registration username' },
                        status: { type: 'string', description: 'High-level status of the endpoint', enum: ['active', 'failed', 'disabled'] },
                        state: { type: 'string', description: 'Registration state', enum: ['initial', 'registering', 'registered', 'failed'] },
                        handler: { type: 'string', enum: TELEPHONY_HANDLER_NAMES, description: 'The handler type for this phone endpoint' },
                        outbound: { type: 'boolean', description: 'Whether this endpoint supports outbound calls', default: false }
                      }
                    }
                  ]
                }
              },
              nextOffset: { type: 'integer', nullable: true, description: 'Next offset to request, or null if no more results' }
            },
            required: ['items', 'nextOffset']
          }
        }
      }
    },
    default: {
      description: 'An error occurred',
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/Error'
          }
        }
      }
    }
  }
};

createPhoneEndpoint.apiDoc = {
  summary: 'Create a new phone endpoint',
  description: `Creates a new phone endpoint. Supports two types of endpoints:
                DDI endpoints are created using an E.164 phone number with trunk configuration.
                Phone registration endpoints are created using a SIP contact URI, username, and password.
                Both kinds of endpoints can be created with a user-defined descriptive name and optionally set to support outbound calling
                (if supported by the handler and trunk/registration account).`,
  operationId: 'createPhoneEndpoint',
  tags: ["Phone Endpoints"],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          $ref: '#/components/schemas/PhoneEndpointCreateInput'
        }
      }
    }
  },
  responses: {
    201: {
      description: 'Phone endpoint created successfully',
      content: {
        'application/json': {
          schema: {
            allOf: [
              {
                type: 'object',
                description: 'Base response - success is always present',
                required: ['success'],
                properties: {
                  success: { type: 'boolean', example: true, description: 'Always true on success' }
                }
              },
              {
                oneOf: [
                  {
                    type: 'object',
                    description: 'Response when type is e164-ddi',
                    required: ['number'],
                    properties: {
                      number: { type: 'string', description: 'E.164 number created (no +)' }
                    }
                  },
                  {
                    type: 'object',
                    description: 'Response when type is phone-registration',
                    required: ['id'],
                    properties: {
                      id: { type: 'string', description: 'Registration id for the created phone registration' }
                    }
                  }
                ]
              }
            ]
          }
        }
      }
    },
    400: {
      description: 'Bad request - validation failed or trunk not found',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: {
                type: 'string',
                example: 'Validation failed'
              },
              details: {
                type: 'array',
                items: {
                  type: 'string'
                }
              }
            }
          }
        }
      }
    },
    403: {
      description: 'Chargeable number limit reached — the organisation already holds its maximum number of DDIs on chargeable (non-owned) trunks',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              code: { type: 'string', example: 'chargeable_number_limit' },
              limit: { type: 'integer', description: 'The organisation\'s chargeable number limit' },
              used: { type: 'integer', description: 'Numbers currently held on chargeable trunks' }
            }
          }
        }
      }
    },
    409: {
      description: 'Conflict - phone number already exists',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: {
                type: 'string'
              }
            }
          }
        }
      }
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: {
                type: 'string'
              }
            }
          }
        }
      }
    }
  }
};


