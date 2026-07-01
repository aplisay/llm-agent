import { Sequelize, Model, DataTypes, Op, Transaction } from 'sequelize';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import Listener from 'pg-listen';
import logger from './logger.js';
import { getHandler } from './handlers/index.js';
import Voices from './voices/index.js';
import { getVoiceNamesForAgentValidation, getTtsVendorsForAgentValidation } from './model-voices.js';
import { validateToolsCallsMetadataUsage } from './handlers/toolsCalls-metadata-capability.js';
import { initPhoneRegistration } from './database-models/phone-registration.js';
import { encryptSecret, decryptSecret } from './utils/credentials.js';
import { createAgentConcurrencyLimits } from './concurrency/agent-concurrency-limits.js';

const schemaVersion = 50;  // 50: billing Phase D3 — `trunks.chargeable` (positive per-trunk flag: our public/
                           //     carrier trunks whose outbound minutes WE pay for). recordUsageMinutes bills the
                           //     destination only when the carried leg's outbound trunk is chargeable — supersedes
                           //     the earlier TrunkOrganisation-ownership heuristic (registration B2BUA / BYO / inbound
                           //     trunks are simply left chargeable=false).
                           // 49: billing Phase D3 — `calls.outbound_trunk_id` (the real Trunk.id a carried
                           //     originate/bridged leg egressed on; null for inbound/webrtc/REFER/registration).
                           //     recordUsageMinutes gates destination billing on it (not owned by the org →
                           //     stamps usage metadata.destinationRaw for the resolver).
                           // 48: billing Phase D — destination tariffs: `tariffs` (named/dated, default_country)
                           //     + `tariff_prefixes` (prefix, connect_micros, per_minute_micros) for telco-style
                           //     longest-prefix destination-number call charging (linked from a rate card's
                           //     `destination` dimension line by tariff name).
                           // 47: billing Phase 5 — `users.rate_history` JSONB (per-user rate override; the
                           //     costing resolver prefers it over the org's rate when it covers billedAt).
                           // 46: billing Phase 3 — `balance_credits` idempotency table (unique idempotency_key)
                           //     backing POST /api/organisations/{id}/balance/credit (Stripe top-up seam).
                           // 45: re-apply the v44 billing schema. Some DBs reached dbVersion=44 from an
                           //     intermediate model that only had the organisations.* billing columns, so the
                           //     usage_records billing/cost columns + the rate_cards table never landed (and
                           //     44===44 gated the alter-sync out). Bumping forces UsageRecord.sync({alter}) to
                           //     add billed_at/media/cost_micros/applied_cost_micros/currency/rate_name/
                           //     rate_card_start/cost_status (+ the org_id,billed_at and cost_status indexes) and
                           //     RateCard.sync to create rate_cards. Idempotent on DBs already fully on v44.
                           // 44: billing — RateCard table + organisations.{rate_history,balance,billing_config,billing_blocked} + usage_records billing/cost columns

/** Set after concurrency models + store are initialised (end of model definitions). */
let agentConcurrencyLimits;

// This is the maximum size of a notification payload we will send
//  to the client.  Postgres has a max of 8k for the whole JSON so we
//  sandbag this to be much smaller to ensure that we don't come close, even with 
//  a large key.
const MAX_NOTIFY_DATA = 6000;


const { POSTGRES_DB,
  POSTGRES_USER,
  POSTGRES_HOST,
  POSTGRES_PASSWORD,
  POSTGRES_PORT,
  POSTGRES_KEY,
  POSTGRES_CERT,
  POSTGRES_CA,
  POSTGRES_RO_SERVER_NAME,
  NODE_ENV,
  DB_FORCE_SYNC,
  CREDENTIALS_KEY } = process.env;

const forceSync = NODE_ENV === 'development' || DB_FORCE_SYNC === 'true';


const sequelize = new Sequelize(
  POSTGRES_DB,
  POSTGRES_USER,
  POSTGRES_PASSWORD,
  {
    dialect: 'postgres',
    host: POSTGRES_HOST,
    port: POSTGRES_PORT,
    dialectOptions: POSTGRES_CA ? {
      ssl: {
        ca: POSTGRES_CA,
        key: POSTGRES_KEY,
        cert: POSTGRES_CERT,
        servername: POSTGRES_RO_SERVER_NAME
      }
    } : {},
    logging: logger.trace.bind(logger)
  });

// These need separate DB connections as Sequelize pools connections, but subscriptions are per connection
//  so any attempt to LISTEN through Sequelize turns out to be super brittle due to connection churn.
const LISTENER_CONNECTION = {
  connectionString: `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`,
  ...(POSTGRES_CA && {
    ssl: {
      ca: POSTGRES_CA,
      key: POSTGRES_KEY,
      cert: POSTGRES_CERT,
      servername: POSTGRES_RO_SERVER_NAME
    }
  })
};
let listener = new Listener(LISTENER_CONNECTION);

let streamIds = {};


class Metadata extends Model {

}

Metadata.init({
  key: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false
  },
  value: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  sequelize,
  timestamps: true,
  underscored: true,
  charset: 'utf8',
  collate: 'utf8_general_ci',
});

/**
 * A group of agents created and managed as a single unit via the /agent-sets API.
 * Member agents reference each other by shortform `label` within the set; the
 * API fixes those labels up to real agent UUIDs on create/update.
 *
 * @class AgentSet
 */
class AgentSet extends Model {
}

AgentSet.init({
  id: {
    type: DataTypes.UUID,
    primaryKey: true,
    defaultValue: DataTypes.UUIDV4
  },
  name: {
    type: DataTypes.STRING
  },
  description: {
    type: DataTypes.TEXT
  }
},
  {
    sequelize,
    timestamps: true,
    underscored: true,
    charset: 'utf8',
    collate: 'utf8_general_ci',
  }
);

class Agent extends Model {
  /**
   *
   * Static helper to return an agent, instance, and phoneNumber by textual phone number
   *
   * @static
   * @param {*} target
   * @return {object} {number, instance, agent}
   * @memberof Agent
   */
  static async fromNumber(target) {
    const number = await PhoneNumber.findByPk(target, {
      include: [
        {
          model: Instance,
          include: [
            Agent,
            User,
            Organisation,
          ]
        }
      ]
    });
    const instance = number?.Instance;
    const agent = instance?.Agent;
    logger.debug({ target, number, instance, agent }, 'database got number');
    return { number, instance, agent };
  }
}

Agent.init({
  id: {
    type: DataTypes.UUID,
    primaryKey: true,
    defaultValue: DataTypes.UUIDV4
  },
  name: {
    type: DataTypes.STRING
  },
  description: {
    type: DataTypes.TEXT
  },
  modelName: {
    type: DataTypes.STRING
  },
  prompt: {
    type: DataTypes.TEXT
  },
  options: {
    type: DataTypes.JSONB,
    set(value) {
      // Encrypt any user-supplied recording key at rest using CREDENTIALS_KEY.
      try {
        if (value && typeof value === 'object' && value.recording && typeof value.recording === 'object') {
          const key = value.recording.key;
          if (key != null) {
            const toStore =
              typeof key === 'string' && key.startsWith('enc:')
                ? key
                : encryptSecret(key);
            value = {
              ...value,
              recording: {
                ...value.recording,
                key: toStore,
              },
            };
          }
        }
      } catch (e) {
        logger.error(e, 'failed to encrypt Agent.options.recording.key');
      }
      this.setDataValue('options', value);
    },
    get() {
      const raw = this.getDataValue('options');
      if (!raw || typeof raw !== 'object' || !raw.recording || typeof raw.recording !== 'object') {
        return raw;
      }
      const storedKey = raw.recording.key;
      if (storedKey == null) {
        return raw;
      }
      try {
        const decryptedKey = decryptSecret(storedKey);
        return {
          ...raw,
          recording: {
            ...raw.recording,
            key: decryptedKey,
          },
        };
      } catch (e) {
        logger.error(e, 'failed to decrypt Agent.options.recording.key');
        return raw;
      }
    },
  },
  functions: {
    type: DataTypes.JSONB
  },
  mcpServers: {
    type: DataTypes.JSONB
  },
  keys: {
    type: DataTypes.JSONB
  },
  type: {
    // 'interactive-audio' agents are connected to live audio sessions (the default,
    //  and the only type that existed before agent sets/subagents were added).
    // 'text' agents are headless: they are invoked like a function (by a voice agent
    //  via a `subagent` builtin, or directly via POST /agents/{id}/invoke) and return
    //  their work product by calling a builtin `result` function.
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'interactive-audio',
    validate: {
      isIn: [['interactive-audio', 'text']]
    }
  },
  label: {
    // Shortform label, unique within an agent set, used for intra-set references
    //  (e.g. transfer_agent / subagent targets) in the /agent-sets JSON document.
    type: DataTypes.STRING,
    validate: {
      is: /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
    }
  },
  agentSetId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'agent_sets',
      key: 'id'
    }
  }
},
  {
    sequelize,
    timestamps: true,
    underscored: true,
    charset: 'utf8',
    collate: 'utf8_general_ci',
    indexes: [
      {
        unique: true,
        fields: ['agent_set_id', 'label']
      }
    ],
    validate: {
      async handlerLimitations() {
        logger.debug({ getHandler, modelName: this.modelName }, 'Handler');
        let Handler = await getHandler(this.modelName);
        logger.debug({ getHandler, Handler, modelName: this.modelName }, 'Handler');
        if (!Handler) {
          throw new Error(`Unknown model name: ${this.modelName}`);
        }
        const agentType = this.type || 'interactive-audio';
        const handlerAgentType = Handler.agentType || 'interactive-audio';
        if (agentType !== handlerAgentType) {
          throw new Error(`Agent type ${agentType} is not valid for model ${this.modelName} which implements ${handlerAgentType} agents`);
        }
        validateToolsCallsMetadataUsage({ Handler, functions: this.functions });
        if (this.options?.tts?.voice || this.options?.tts?.vendor) {
          const voicesInstance = new Voices();
          if (this.options?.tts?.voice) {
            const allowedNames = await getVoiceNamesForAgentValidation({
              modelName: this.modelName,
              Handler,
              voicesInstance,
            });
            if (!allowedNames.has(this.options.tts.voice)) {
              logger.error({ options: this.options, voices: [...allowedNames] }, 'Voice not supported');
              throw new Error(`Voice ${this.options.tts.voice} not supported by ${this.modelName}`);
            }
          }
          // Reject an unsupported/placeholder TTS vendor (e.g. "unknown") at create
          // time, so a misconfigured voice agent fails here with a clear message
          // instead of barfing in the worker at call time. (Empty set = couldn't
          // determine the catalogue → don't reject.)
          if (this.options?.tts?.vendor) {
            const allowedVendors = await getTtsVendorsForAgentValidation({
              modelName: this.modelName,
              Handler,
              voicesInstance,
            });
            const vendor = String(this.options.tts.vendor).toLowerCase();
            if (allowedVendors.size && !allowedVendors.has(vendor)) {
              logger.error({ options: this.options, vendors: [...allowedVendors] }, 'TTS vendor not supported');
              throw new Error(
                `TTS vendor "${this.options.tts.vendor}" not supported by ${this.modelName} `
                + `(supported: ${[...allowedVendors].sort().join(', ')})`);
            }
          }
        }
        // Validates the `agent` parameter on transfer_agent/subagent builtins:
        //  must be a static or metadata source; static values must be a real agent
        //  UUID (shortform `label:` references are only legal inside an /agent-sets
        //  document and are fixed up to UUIDs before the agents are saved).
        const validateAgentTarget = (name, func) => {
          const agentParam = func.input_schema?.properties?.agent;
          if (!agentParam) {
            throw new Error(`${name}: ${func.platform} function must include a parameter called "agent"`);
          }
          if (agentParam.source !== 'static' && agentParam.source !== 'metadata') {
            throw new Error(`${name}: ${func.platform} function "agent" parameter cannot be generated, must be either "static" or "metadata"`);
          }
          if (agentParam.source === 'static'
            && !`${agentParam.from}`.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
            throw new Error(`${name}: ${func.platform} function static "agent" parameter must be an agent UUID (labels are only valid within an agent-set document)`);
          }
        };
        if (this.options?.transferTone !== undefined && this.options?.transferTone !== null) {
          const tone = this.options.transferTone;
          if (tone !== true && tone !== false && (typeof tone !== 'object' || Array.isArray(tone))) {
            throw new Error('options.transferTone must be a boolean or an object');
          }
          if (typeof tone === 'object') {
            // Tone shape is coarse on purpose (enum frequency + length) so the
            //  worker can later serve pre-generated tones; only the silence
            //  timings are free-form. Keep these in sync with the workers'
            //  confidence_tone.py / confidence-tone.ts.
            const enums = {
              frequency: ['low', 'medium', 'high'],
              length: ['short', 'medium', 'long'],
              volume: ['low', 'medium', 'high'],
            };
            for (const [field, allowed] of Object.entries(enums)) {
              const value = tone[field];
              if (value === undefined) continue;
              if (!allowed.includes(value)) {
                throw new Error(`options.transferTone.${field} must be one of ${allowed.map(v => `'${v}'`).join(', ')}`);
              }
            }
            const ranges = {
              gapMs: [0, 60000],
              graceMs: [0, 30000],
            };
            for (const [field, [lo, hi]] of Object.entries(ranges)) {
              const value = tone[field];
              if (value === undefined) continue;
              if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi) {
                throw new Error(`options.transferTone.${field} must be a number between ${lo} and ${hi}`);
              }
            }
            if (tone.enabled !== undefined && typeof tone.enabled !== 'boolean') {
              throw new Error('options.transferTone.enabled must be a boolean');
            }
          }
        }
        const functions = Object.entries(this.functions || {});
        return functions.every(([name, func]) => {
          if (func.implementation !== 'builtin')
            return true;
          if (!func.platform || !func.platform?.length) {
            throw new Error(`Builtin function ${name} must specify platform function name to be used`);
          }
          switch (func.platform) {
            case 'hangup':
            case 'metadata':
            case 'transfer':
            case 'transfer_status':
              // These platform functions ride on the telephony/transfer support in the handler
              if (!Handler.hasTransfer) {
                throw new Error(`Model ${this.modelName} does not support transfer, but transfer function was found in functions`);
              }
              break;
            case 'transfer_agent':
              if (!Handler.hasAgentTransfer) {
                throw new Error(`Model ${this.modelName} does not support agent-to-agent transfer, but a transfer_agent function was found in functions`);
              }
              break;
            case 'subagent':
              if (!Handler.hasSubagent) {
                throw new Error(`Model ${this.modelName} does not support subagent invocation, but a subagent function was found in functions`);
              }
              break;
            case 'result':
              if (agentType !== 'text') {
                throw new Error(`The result platform function is only valid on agents of type "text" (function ${name})`);
              }
              break;
            default:
              throw new Error(`Unknown platform function: ${func.platform}`);
          }
          switch (func.platform) {
            case 'hangup':
              if (func.input_schema.properties && Object.keys(func.input_schema.properties).length > 0) {
                throw new Error('Hangup function must have no parameters');
              }
              return true;
            case 'metadata':
              if (!func.input_schema.properties
                || Object.keys(func.input_schema.properties).length !== 1
                || !func.input_schema.properties.keys) {
                throw new Error('Metadata function must have a single parameter called "keys"');
              }
              return true;
            case 'transfer':
              if (!func.input_schema.properties || !func.input_schema.properties.number) {
                throw new Error('Transfer function must include a parameter called "number"');
              }
              // Allow optional callerId and operation parameters; only enforce rules for number
              if (func.input_schema.properties.number.source === 'generated') {
                throw new Error('Transfer function "number" parameter cannot be generated, must be either "static" or "metadata"');
              }
              return true;
            case 'transfer_status':
              if (func.input_schema.properties && Object.keys(func.input_schema.properties).length > 0) {
                throw new Error('Transfer_status function must have no parameters');
              }
              return true;
            case 'transfer_agent': {
              validateAgentTarget(name, func);
              const includeHistory = func.input_schema?.properties?.includeHistory;
              if (includeHistory && includeHistory.source !== 'static') {
                throw new Error(`${name}: transfer_agent "includeHistory" parameter must be a static source`);
              }
              return true;
            }
            case 'subagent':
              validateAgentTarget(name, func);
              return true;
            case 'result':
              // Any (generated) parameter shape is allowed: it defines the work
              //  product the text agent must produce.
              return true;
          }
        });
      },
    }
  }
);



class Instance extends Model {
  /**
   *
   *
   * @param {string} handler name of the handler plugin
   * @param {string} number phone number to link to this instance ot '*' for any available number
   * @return {string} the number allocated
   * @throws {Error} if no number is available for this handler or any other error occurs
   * @memberof Instance
   */
  async linkNumber(handler, number, organisationId) {
    let where = {
      [Op.or]: [
        { organisationId },
        { organisationId: null }
      ]
    };
    // If we have a number, not a wildcard then we can match reservations
    // or unreserved numbers, but only if our organisation owns them
    // otherwise wildcards only match unreserved numbers
    if (number && number !== '*') {
      // Database numbers are fully qualified E.164 without a '+' so remove it if prepended
      number = number.replace(/^\+/, '');
      where = { ...where, number };
    }
    else {
      // We can only match unreserved numbers owned by us or no organisation
      where = {
        ...where,
        // We can only match numbers which are supported by this handler
        handler,
        // and aren't already in use
        instanceId: { [Op.eq]: null },
        reservation: { [Op.not]: true },
      };
    }
    logger.debug({ where, organisationId }, "linkNumber");
    // Transaction to find a matching number which isn't currently linked
    //  to an instance, and link it to this instance. Needs full isolation
    //  level to ensure we can do an atomic select/update on an unallocated number.
    let allocated = await sequelize.transaction({
      isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE,
    },
      async transaction => {
        const row = await PhoneNumber.findOne({
          where,
          order: [["number", "asc"]],
          transaction
        });
        if (!row) {
          throw new Error(`Not found: no phone number matching ${number} exists for this user/organisation`);
        }
        if (row.handler !== handler) {
          throw new Error(`Not supported: ${row.number} routes to ${row.handler} but this agent uses ${handler}`);
        }
        if (row.instanceId) {
          throw new Error(`In use: number ${row.number} is already linked to instance ${row.instanceId}`);
        }

        await row.update({ instanceId: this.id }, { transaction });
        return row.number;
      });
    return allocated;

  }

  /**
   * Links a phone registration to this instance
   *
   * @param {string} handler name of the handler plugin
   * @param {string} registrationId phone registration ID to link to this instance
   * @param {string} organisationId organisation ID
   * @return {string} the registration ID allocated
   * @throws {Error} if registration is not available for this handler or any other error occurs
   * @memberof Instance
   */
  async linkRegistration(handler, registrationId, organisationId) {
    logger.debug({ registrationId, handler, organisationId }, "linkRegistration");
    // Transaction to find the registration and link it to this instance.
    // Needs full isolation level to ensure we can do an atomic select/update.
    let allocated = await sequelize.transaction({
      isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE,
    },
      async transaction => {
        const row = await PhoneRegistration.findByPk(registrationId, { transaction });
        if (!row) {
          throw new Error(`Not found: no phone registration with id ${registrationId} exists`);
        }
        if (row.handler !== handler) {
          throw new Error(`Not supported: registration ${registrationId} routes to ${row.handler} but this agent uses ${handler}`);
        }
        if (row.instanceId) {
          throw new Error(`In use: registration ${registrationId} is already linked to instance ${row.instanceId}`);
        }
        // Verify organisation ownership (optional check, but good practice)
        if (row.organisationId && row.organisationId !== organisationId) {
          throw new Error(`Access denied: registration ${registrationId} belongs to a different organisation`);
        }

        await row.update({ instanceId: this.id }, { transaction });
        return row.id;
      });
    return allocated;
  }
}

Instance.init({
  id: {
    type: DataTypes.UUID,
    primaryKey: true,
    defaultValue: DataTypes.UUIDV4
  },
  agentId: {
    type: DataTypes.UUID,
    references: {
      model: 'agents',
      key: 'id'
    },
    required: true
  },
  type: {
    type: DataTypes.ENUM,
    values: ['jambonz', 'ultravox', 'livekit', 'pipecat'],
    required: true
  },
  key: {
    type: DataTypes.STRING
  },
  streamLog: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  websocket: {
    type: DataTypes.JSONB,
    defaultValue: false
  },
  metadata: {
    type: DataTypes.JSONB,
    defaultValue: {}
  },
  recording: {
    type: DataTypes.JSONB,
    allowNull: true,
    set(value) {
      // Encrypt any user-supplied recording key at rest using CREDENTIALS_KEY.
      try {
        if (value && typeof value === 'object') {
          const key = value.key;
          if (key != null) {
            const toStore =
              typeof key === 'string' && key.startsWith('enc:')
                ? key
                : encryptSecret(key);
            value = {
              ...value,
              key: toStore,
            };
          }
        }
      } catch (e) {
        logger.error(e, 'failed to encrypt Instance.recording.key');
      }
      this.setDataValue('recording', value);
    },
    get() {
      const raw = this.getDataValue('recording');
      if (!raw || typeof raw !== 'object') {
        return raw;
      }
      const storedKey = raw.key;
      if (storedKey == null) {
        return raw;
      }
      try {
        const decryptedKey = decryptSecret(storedKey);
        return {
          ...raw,
          key: decryptedKey,
        };
      } catch (e) {
        logger.error(e, 'failed to decrypt Instance.recording.key');
        return raw;
      }
    },
  },
  agentLimit: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
},
  {
    sequelize,
    timestamps: true,
    underscored: true,
    charset: 'utf8',
    collate: 'utf8_general_ci',
  }
);
Instance.belongsTo(Agent, { foreignKey: 'agentId', onDelete: 'CASCADE' });
Agent.hasMany(Instance, { foreignKey: 'agentId', onDelete: 'CASCADE', as: 'listeners' });


class Call extends Model {
  set streamLog(value) {
    if (value) {
      streamIds[this.id] = value;
    } else {
      delete streamIds[this.id];
    }
  }
  static async initIndex() {
    await sequelize.query(`
      WITH numbered_rows AS (
        SELECT id, organisation_id,
          ROW_NUMBER() OVER (PARTITION BY organisation_id ORDER BY created_at) as new_index
        FROM calls 
        WHERE index IS NULL
        ORDER by created_at
      )
      UPDATE calls 
      SET index = numbered_rows.new_index 
      FROM numbered_rows 
      WHERE calls.id = numbered_rows.id`);
  }
  async end(reason, { endedAt } = {}) {
    const call = this;
    // Phase 1: complete the call record. This is the critical write and must NOT
    // be blocked or rolled back by usage/billing processing — a metering or billing
    // failure (e.g. a usage_records schema mismatch) must never leave an incomplete
    // call record.
    // `endedAt` lets a caller with authoritative platform timing (e.g. the Ultravox
    // webhook reporting the real call-end instant) override the default of "now";
    // duration is computed from the call's own startedAt. `reason` is accepted for
    // caller convenience/logging but the recorded status is always 'ended normally'.
    try {
      call.endedAt = endedAt || new Date();
      call.duration =
        call.startedAt && call.endedAt.valueOf() - call.startedAt.valueOf();
      call.live = false;
      call.status = 'ended normally';
      await call.save();
    } finally {
      await agentConcurrencyLimits.releaseCall(call.id).catch((err) => {
        logger.warn(err, 'agent concurrency release on call end');
      });
    }
    // Phase 2: best-effort usage/billing, AFTER the record is durably saved and
    // concurrency released. Fully isolated so any error here cannot propagate into
    // call teardown or leave the record incomplete.
    try {
      await call.recordUsageMinutes();
    } catch (e) {
      logger.warn(e, 'recordUsageMinutes failed after call end (record already saved)');
    }
  }

  /**
   * Classify a leg's audio media/transport from its own caller/called ids:
   * browser/WebRTC legs carry the literal 'WebRTC' sentinel, telephony legs carry
   * E.164 numbers. Each Call row is one leg, so this reflects that leg's egress —
   * provided derived legs (bridge/transfer children) are created with their OWN
   * ids, not the parent's. A pricing dimension for voice rows; NOT in meterKey.
   * @returns {'webrtc'|'telephony'|null}
   */
  static mediaFromIds(callerId, calledId) {
    if (callerId === 'WebRTC' || calledId === 'WebRTC') return 'webrtc';
    if (callerId || calledId) return 'telephony';
    return null;
  }

  /**
   * Mirror this call's billable duration into the usage ledger as a finalised
   * `voice` / `milliseconds` meter, so minute usage lives alongside token and
   * character usage in one table for billing. Best-effort and idempotent: every
   * handler funnels through `Call.end()`, and a metering failure must never break
   * call teardown.
   *
   * @memberof Call
   */
  async recordUsageMinutes() {
    const call = this;
    try {
      if (!call.duration) return;
      const provider = call.platform || null;
      const detail = call.modelName || null;
      // Audio media/transport for this leg's voice row (a pricing dimension),
      // derived from the leg's own ids. NOT part of meterKey.
      // The blind-bridge tail leg (the `telephony:bridged-call` sentinel, emitted
      // by both the LiveKit and Pipecat bridge paths) is definitionally a telephony
      // bridge, but it is created carrying the WebRTC-origin caller/called ids,
      // which mediaFromIds would otherwise misclassify as 'webrtc'. Pin it to
      // telephony so it matches the bridged-call audio-path rate line.
      const media = call.modelName === 'telephony:bridged-call'
        ? 'telephony'
        : Call.mediaFromIds(call.callerId, call.calledId);
      // Destination (carrier) billing gate (Phase D3): a leg carried out on one of
      // OUR public/carrier trunks (Trunk.chargeable) → freeze the dialled number as
      // the anchor the costing resolver longest-prefix-matches against the org's
      // tariff. Everything else — a non-chargeable trunk (customer PBX via a
      // registration B2BUA, a BYO carrier, an inbound trunk) or no outbound trunk at
      // all (WebRTC / REFER) — is not destination-billable. The resolver normalises
      // this raw number using the resolved tariff's own default country.
      let destinationRaw = null;
      if (call.outboundTrunkId && call.calledId) {
        const trunk = await Trunk.findByPk(call.outboundTrunkId, { attributes: ['chargeable'] });
        if (trunk?.chargeable) destinationRaw = call.calledId;
      }
      const meterKey = UsageRecord.meterKey({
        agentId: call.agentId, technology: 'voice', provider, detail, unit: 'milliseconds',
      });
      const [row, created] = await UsageRecord.findOrCreate({
        where: { sessionId: call.id, meterKey },
        defaults: {
          sessionId: call.id, meterKey, callId: call.id,
          organisationId: call.organisationId, userId: call.userId, agentId: call.agentId,
          technology: 'voice', provider, detail, unit: 'milliseconds', media,
          quantity: call.duration, finalised: true,
          ...(destinationRaw ? { metadata: { destinationRaw } } : {}),
        },
      });
      if (!created) {
        await row.update({
          quantity: call.duration, finalised: true, media,
          ...(destinationRaw ? { metadata: { ...(row.metadata || {}), destinationRaw } } : {}),
        });
      }
      // Cost-at-finalisation for the voice/minutes row. Lazy import avoids a
      // database.js <-> rates.js module cycle; costUsageRow is never-throw.
      const { costUsageRow } = await import('./rates.js');
      await costUsageRow(row);
    } catch (e) {
      logger.warn(e, 'failed to record voice usage minute row on call end');
    }
  }

  async start(context = {}) {
    const call = this;
    // Hot-path billing refusal (Phase 5): an org may be hard-blocked
    // (billingBlocked) by the balanceNegative callback or an admin. Refuse the
    // call before reserving concurrency. Reuse the org from context when the
    // handler already loaded it; otherwise one indexed PK lookup.
    const org = context.organisation
      ?? (call.organisationId
        ? await Organisation.findByPk(call.organisationId, { attributes: ['id', 'billingBlocked'] }).catch(() => null)
        : null);
    if (org?.billingBlocked) {
      call.status = 'failed: billing blocked';
      call.live = false;
      await call.save().catch(() => {});
      const err = new Error('Billing blocked for this organisation');
      err.code = 'BILLING_BLOCKED';
      throw err;
    }
    try {
      await agentConcurrencyLimits.reserveForCall(call, context);
    } catch (e) {
      // Preserve concurrency-limit failures on the call row.
      if (e?.code === 'AGENT_CONCURRENCY_LIMIT_EXCEEDED' && e?.scope) {
        call.status = `failed: ${e.scope} concurrency limit`;
        call.live = false;
        await call.save().catch(() => {});
      }
      throw e;
    }
    try {
      call.startedAt = new Date();
      call.live = true;
      call.status = 'in progress';
      await call.save();
    } catch (e) {
      await agentConcurrencyLimits.releaseCall(call.id).catch((err) => {
        logger.warn(err, 'agent concurrency release after failed call start save');
      });
      throw e;
    }
  }

}

Call.init({
  id: {
    type: DataTypes.UUID,
    primaryKey: true,
    defaultValue: DataTypes.UUIDV4
  },
  parentId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'calls',
      key: 'id'
    }
  },
  instanceId: {
    type: DataTypes.UUID,
    references: {
      model: 'instances',
      key: 'id'
    },
    required: true
  },
  index: {
    type: DataTypes.INTEGER,
    required: false,
    allowNull: true
  },
  metadata: {
    type: DataTypes.JSONB,
    defaultValue: {}
  },
  platform: {
    type: DataTypes.STRING,
    required: false,
  },
  modelName: {
    type: DataTypes.STRING,
    required: false,
  },
  // The real Trunk.id a CARRIED outbound leg egressed on (an originate leg or a
  // telephony:bridged-call child). Null for inbound / WebRTC / REFER transfers /
  // registration-B2BUA egress. Destination (carrier) billing is gated on this:
  // recordUsageMinutes charges only when it is set AND the org does not own it.
  outboundTrunkId: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  options: {
    type: DataTypes.JSONB,
    required: false,
  },
  platformCallId: {
    type: DataTypes.STRING,
    required: false,
  },
  calledId: {
    type: DataTypes.STRING,
    required: true
  },
  callerId: {
    type: DataTypes.STRING,
    required: true
  },
  encryptionKey: {
    type: DataTypes.STRING,
    allowNull: true,
    set(value) {
      const toStore =
        typeof value === 'string' && value.startsWith('enc:')
          ? value
          : encryptSecret(value);
      this.setDataValue('encryptionKey', toStore);
    },
    get() {
      const raw = this.getDataValue('encryptionKey');
      return decryptSecret(raw);
    },
  },
  recordingId: {
    type: DataTypes.STRING,
    allowNull: true
  },
  streamUrl: {
    type: DataTypes.STRING,
  },
  startedAt: {
    type: DataTypes.DATE,
  },
  endedAt: {
    type: DataTypes.DATE
  },
  status: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  live: {
    type: DataTypes.BOOLEAN
  },
  duration: {
    type: DataTypes.INTEGER,
  }
},
  {
    sequelize,
    timestamps: true,
    underscored: true,
    charset: 'utf8',
    collate: 'utf8_general_ci',
    hooks: {
      beforeCreate: async (call, options = {}) => {
        if (!options.transaction) {
          options.transaction = await sequelize.transaction();
          options.syntheticTransaction = options.transaction;
        }
        const [result] = await sequelize.query(`(SELECT COALESCE(MAX(index), 0) + 1 as next_index FROM calls WHERE organisation_id = '${call.organisationId}')`, { type: sequelize.QueryTypes.SELECT, transaction: options.transaction });
        logger.debug({ result }, 'index result');
        call.index = result.next_index;
      },
      afterCreate: async (call, options) => {
        if ((await Instance.findByPk(call.instanceId, options)).streamLog) {
          logger.debug(`Streaming logs for call ${call.id}`);
          call.streamLog = call.instanceId;
        }
        if (options.syntheticTransaction) {
          await options.syntheticTransaction.commit();
        }
      }
    }
  }
);

Call.belongsTo(Instance, { foreignKey: 'instanceId', onDelete: 'SET NULL' });
Call.belongsTo(Agent, { foreignKey: 'agentId', onDelete: 'SET NULL' });
// Self-referential relationship to track bridged call lineage
Call.belongsTo(Call, { as: 'parent', foreignKey: 'parentId' });
Call.hasMany(Call, { as: 'children', foreignKey: 'parentId' });

class TransactionLog extends Model {
  static async on(id, handler) {
    let tag = 'progress' + id.replace(/-/g, '');
    logger.debug(`Setting up listener for ${tag}`);
    if (handler) {
      listener.notifications.on(tag, async (payload) => {
        // Payload as passed to listener.notify() (see below)
        logger.debug(payload, `Received notification for ${tag}`);
        if (payload.fetch$record) {
          logger.debug(payload, `Fetching record ${payload.fetch$record}`);
          let log = await TransactionLog.findByPk(payload.fetch$record);
          payload = {
            [log.type]: JSON.parse(log.data),
            callId: log.callId
          };
          logger.debug(payload, `Got payload`);
        }
        handler(payload);
      });
      logger.debug(`Waiting for notifications for ${tag}`);

      await listener.listenTo(tag);
    } else {
      await listener.stopListeningTo(tag);
    }
  }
  static notify(transactionLog, options) {
    let notify = streamIds[transactionLog.callId];
    logger.debug({ transactionLog, notify, length: transactionLog?.data?.length }, `Notifying ${transactionLog.callId}`);
    if (notify) {
      let { type, data, callId, updatedAt,isFinal } = transactionLog;
      if (data?.length >= MAX_NOTIFY_DATA) {
        type = 'fetch$record';
        data = transactionLog.id;
      }
      else {
        try {
          data = JSON.parse(transactionLog.data);
        }
        catch (e) {
          data = transactionLog.data;
        }
      }
      logger.debug({ [type]: data }, `Notifying logs progress${notify.replace(/-/g, '')}`);
      data && listener.notify(`progress${notify.replace(/-/g, '')}`, { [type]: data, isFinal, callId, timestamp: updatedAt });
    }
    return transactionLog;
  }
}

TransactionLog.init({
  callId: {
    type: DataTypes.UUID,
    references: {
      model: 'calls',
      key: 'id'
    },
    required: true
  },
  type: {
    type: DataTypes.ENUM,
    values: ['start', 'hangup', 'goodbye', 'answer', 'inject', 'call', 'call_failed', 'agent', 'user', 'function_calls', 'rest_callout', 'function_results', 'error'],
    required: true
  },
  data: {
    type: DataTypes.JSONB
  },
  isFinal: {
    type: DataTypes.BOOLEAN,
  }
},
  {
    sequelize,
    timestamps: true,
    underscored: true,
    charset: 'utf8',
    collate: 'utf8_general_ci',
    hooks: {
      afterCreate: TransactionLog.notify,
      afterUpdate: TransactionLog.notify
    }
  }
);

TransactionLog.belongsTo(Call, { foreignKey: 'callId', onDelete: 'CASCADE' });

class InvocationLog extends Model {}

InvocationLog.init({
  callId: {
    type: DataTypes.UUID,
    references: {
      model: 'calls',
      key: 'id'
    },
    allowNull: false
  },
  organisationId: {
    type: DataTypes.STRING,
    references: {
      model: 'organisations',
      key: 'id'
    },
    allowNull: true
  },
  userId: {
    type: DataTypes.STRING,
    references: {
      model: 'users',
      key: 'id'
    },
    allowNull: true
  },
  subsystem: {
    type: DataTypes.ENUM,
    values: ['livekit-agent', 'pipecat-agent'],
    allowNull: false,
    defaultValue: 'livekit-agent',
  },
  log: {
    // Stored as a JSONB wrapper that contains compressed payload metadata and data.
    // Example shape: { encoding: 'gzip_base64', data: '<base64-gzip(JSON)>' }
    type: DataTypes.JSONB,
    allowNull: false
  }
},
{
  sequelize,
  timestamps: true,
  underscored: true,
  charset: 'utf8',
  collate: 'utf8_general_ci',
});

class CallRecordingDownload extends Model {}

CallRecordingDownload.init({
  id: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    autoIncrement: true,
  },
  callId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'calls',
      key: 'id',
    },
  },
  organisationId: {
    type: DataTypes.STRING,
    allowNull: false,
    references: {
      model: 'organisations',
      key: 'id',
    },
  },
  userId: {
    type: DataTypes.STRING,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id',
    },
  },
  downloadedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  sequelize,
  timestamps: false,
  underscored: true,
  charset: 'utf8',
  collate: 'utf8_general_ci',
});

CallRecordingDownload.belongsTo(Call, { foreignKey: 'callId', onDelete: 'CASCADE' });

/**
 * A single metered unit reading for one agent session — the broad usage ledger
 * that underpins billing. Every row is one (technology, provider, detail, unit)
 * tuple with a cumulative `quantity` for a session: LLM tokens (input/output as
 * separate rows), TTS characters, STT/voice milliseconds, function invocations,
 * etc. `technology`/`unit` are deliberately free-form strings (not enums) so new
 * meters need no migration.
 *
 * Provisional totals are updated in place during a session — keyed on
 * (`sessionId`, `meterKey`) — and `finalised` is flipped true once the count is
 * known to be complete. Phase 1 only captures; a future pricing table joins on
 * (technology, provider, detail, unit) to value the `quantity`.
 *
 * @class UsageRecord
 */
class UsageRecord extends Model {
  /** Deterministic per-session meter discriminator (the upsert key alongside sessionId). */
  static meterKey({ agentId, technology, provider, detail, unit }) {
    return [agentId || '', technology || '', provider || '', detail || '', unit || ''].join('|');
  }
}

UsageRecord.init({
  id: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    autoIncrement: true,
  },
  // Universal session grouping key: the call id for voice sessions, or a
  //  generated uuid for headless text-agent invocations (which have no Call).
  sessionId: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // Stable discriminator for the meter within a session; (session_id, meter_key)
  //  is unique so provisional flushes update the same row. Computed in
  //  beforeValidate from the tuple below if not explicitly set.
  meterKey: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  callId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'calls', key: 'id' },
  },
  organisationId: {
    type: DataTypes.STRING,
    allowNull: true,
    references: { model: 'organisations', key: 'id' },
  },
  userId: {
    type: DataTypes.STRING,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
  agentId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'agents', key: 'id' },
  },
  // Broad category, e.g. 'llm' | 'tts' | 'stt' | 'voice' | 'function'.
  technology: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // Vendor, e.g. 'anthropic' | 'openai' | 'google' | 'elevenlabs' | 'deepgram'.
  provider: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  // Detailed model/technology name, e.g. 'claude-opus-4-8' | 'eleven_turbo_v2'.
  detail: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  // Unit of measure, e.g. 'input_tokens' | 'output_tokens' | 'cache_read_tokens'
  //  | 'characters' | 'words' | 'milliseconds' | 'invocations'. Durations are
  //  stored as integer milliseconds so every quantity stays integral.
  unit: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  quantity: {
    type: DataTypes.BIGINT,
    allowNull: false,
    defaultValue: 0,
  },
  finalised: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  metadata: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  // --- Billing (schema v44). Cost is stamped at transaction end (cost-at-write),
  // valued per-row and idempotently. ---
  // Canonical billing instant: the interaction START (Call.startedAt for voice,
  // metadata.startedAt for text). Rates resolve AND /usage period-buckets on this,
  // NOT created_at (which stays immutable audit). Populated at cost time.
  billedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  // Audio media/transport for voice rows: 'webrtc' | 'telephony'. Persisted at
  // write from the leg's OWN egress; a pricing dimension for technology='voice'
  // only. NOT part of meterKey.
  media: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  // Frozen cost of this row in MICRO-PENCE (1e-6 GBP). null until costed / when
  // unmatched or errored (see costStatus). Recomputed+overwritten on finalised
  // reflush; the balance decrement applies (costMicros - appliedCostMicros).
  costMicros: {
    type: DataTypes.BIGINT,
    allowNull: true,
  },
  // The portion of costMicros already settled against Organisation.balance — the
  // delta primitive's second operand, making per-row finalisation + the nightly
  // sweep idempotent. Defaults 0 so a null->numeric balance transition settles
  // the full cost exactly once.
  appliedCostMicros: {
    type: DataTypes.BIGINT,
    allowNull: false,
    defaultValue: 0,
  },
  currency: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  // Which rate card valued this row (name + its startDate) — audit of the frozen cost.
  rateName: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  rateCardStart: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  // Costing outcome (free-form STRING, like technology/unit): 'matched' |
  // 'no_rate' (org has no assigned / covering card) | 'no_line' (no rate line
  // matched) | 'errored' (resolver threw — sweep retries). null = not yet costed.
  costStatus: {
    type: DataTypes.STRING,
    allowNull: true,
  },
}, {
  sequelize,
  timestamps: true,
  underscored: true,
  charset: 'utf8',
  collate: 'utf8_general_ci',
  indexes: [
    { unique: true, fields: ['session_id', 'meter_key'] },
    { fields: ['organisation_id', 'created_at'] },
    { fields: ['user_id', 'created_at'] },
    { fields: ['call_id'] },
    { fields: ['organisation_id', 'billed_at'] },
    { fields: ['cost_status'] },
  ],
  hooks: {
    beforeValidate: (record) => {
      if (!record.meterKey) {
        record.meterKey = UsageRecord.meterKey(record);
      }
    },
  },
});

/**
 * Named, date-ranged rate card — the per-component price definitions that value
 * UsageRecords at transaction end (schema v44). Identified by (name, startDate);
 * the effective interval is [startDate, endDate) where a null endDate is open
 * until a later card for the same name supersedes it. `detail` JSONB holds the
 * additive, per-dimension rate lines (audio-path | model | tts | stt). Cards are
 * IMMUTABLE once referenced — a price change is a NEW card with a later startDate.
 * Per-name non-overlap is enforced at the DB level by an EXCLUDE gist constraint
 * (addRateCardOverlapConstraint), which Sequelize sync() cannot emit.
 * @class RateCard
 */
class RateCard extends Model {}

RateCard.init({
  id: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    autoIncrement: true,
  },
  // Rate-name an organisation's rateHistory points at, e.g. 'customer-rate-1'.
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // Effective-from (timestamptz). Resolution is a point-in-[startDate, endDate) test.
  startDate: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  // Effective-to (exclusive); null = open until a later same-name card supersedes.
  endDate: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  currency: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'gbp',
  },
  // Additive per-dimension rate lines:
  //   { lines: [ { dim, match:{technology,provider?,detail?,unit?,media?}, unit, priceMicros } ] }
  // The resolver picks the most-specific line WITHIN each dim and SUMs across dims;
  // priceMicros = micro-pence (1e-6 GBP) per the line's `unit`.
  detail: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: { lines: [] },
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // User id (string) of the superAdmin who authored this card; audit only.
  createdBy: {
    type: DataTypes.STRING,
    allowNull: true,
  },
}, {
  sequelize,
  timestamps: true,
  underscored: true,
  charset: 'utf8',
  collate: 'utf8_general_ci',
  indexes: [
    { unique: true, fields: ['name', 'start_date'] },
    { fields: ['name'] },
  ],
});

// Frozen-cost correction invariant: a RateCard is IMMUTABLE once any usage row
// references it (by rateName + rateCardStart at cost time). A price change is a
// NEW card with a later startDate (supersede), never an edit — so the cost frozen
// onto historical rows can never silently move. Cosmetic edits (description /
// createdBy) are still allowed. The nightly sweep re-costs uncosted/errored rows
// against the corrected (superseding) card.
RateCard.addHook('beforeUpdate', async (card) => {
  const pricingFields = ['name', 'startDate', 'endDate', 'currency', 'detail'];
  if (!pricingFields.some((f) => card.changed(f))) return;
  const referenced = await UsageRecord.findOne({
    where: { rateName: card.previous('name'), rateCardStart: card.previous('startDate') },
    attributes: ['id'],
  });
  if (referenced) {
    throw new Error(
      `RateCard "${card.previous('name')}" is immutable once referenced by costed usage; `
      + 'supersede it with a new card (later startDate) instead of editing its pricing.',
    );
  }
});

/**
 * Idempotency ledger for balance top-ups (Phase 3 billing, schema v46). polite-ai's
 * Stripe webhook calls POST /api/organisations/{id}/balance/credit with
 * idempotencyKey = PaymentIntent.id; the UNIQUE constraint on `idempotencyKey`
 * makes a Stripe retry safe — a duplicate insert is rejected, so the same payment
 * credits `Organisation.balance` exactly once. Append-only audit of every credit.
 * @class BalanceCredit
 */
class BalanceCredit extends Model {}

BalanceCredit.init({
  id: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    autoIncrement: true,
  },
  organisationId: {
    type: DataTypes.STRING,
    allowNull: false,
    references: { model: 'organisations', key: 'id' },
  },
  // PaymentIntent.id (or any caller-supplied dedupe key). UNIQUE => idempotent retries.
  idempotencyKey: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // Amount credited, in MICRO-PENCE (1e-6 GBP) — the unit of Organisation.balance.
  amountMicros: {
    type: DataTypes.BIGINT,
    allowNull: false,
  },
  currency: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'gbp',
  },
}, {
  sequelize,
  timestamps: true,
  underscored: true,
  charset: 'utf8',
  collate: 'utf8_general_ci',
  indexes: [
    { unique: true, fields: ['idempotency_key'] },
    { fields: ['organisation_id', 'created_at'] },
  ],
});

/**
 * Destination tariff (Phase D billing) — a named, date-ranged prefix deck for
 * telco-style destination-number call charging. A rate card's `destination`
 * dimension line links to a tariff by NAME; the resolver loads the version
 * effective @billedAt and longest-prefix-matches the carried leg's normalised
 * destination. Like RateCard: per-name non-overlap (EXCLUDE gist) and IMMUTABLE
 * once referenced by costed usage (a price change is a NEW dated tariff).
 * @class Tariff
 */
class Tariff extends Model {}

Tariff.init({
  id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
  // Tariff name a rate card's `destination` line references, e.g. 'uk-carrier-2026'.
  name: { type: DataTypes.STRING, allowNull: false },
  startDate: { type: DataTypes.DATE, allowNull: false },
  endDate: { type: DataTypes.DATE, allowNull: true },
  currency: { type: DataTypes.STRING, allowNull: false, defaultValue: 'gbp' },
  // ISO-3166 alpha-2 home country used to normalise LOCAL-format dialled numbers
  // (a leading '0') to international digits before prefix-matching this deck.
  defaultCountry: { type: DataTypes.STRING, allowNull: false, defaultValue: 'GB' },
  description: { type: DataTypes.TEXT, allowNull: true },
  // superAdmin user id who authored this tariff; audit only.
  createdBy: { type: DataTypes.STRING, allowNull: true },
}, {
  sequelize,
  timestamps: true,
  underscored: true,
  charset: 'utf8',
  collate: 'utf8_general_ci',
  indexes: [
    { unique: true, fields: ['name', 'start_date'] },
    { fields: ['name'] },
  ],
});

/**
 * One prefix row of a {@link Tariff} deck: a destination prefix (international
 * digits) priced as a per-call connect fee + a per-minute rate (micro-pence;
 * either may be 0). Longest-prefix match wins; unique per (tariff, prefix).
 * @class TariffPrefix
 */
class TariffPrefix extends Model {}

TariffPrefix.init({
  id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
  tariffId: {
    type: DataTypes.BIGINT,
    allowNull: false,
    references: { model: 'tariffs', key: 'id' },
    onDelete: 'CASCADE',
  },
  // International digits-only prefix, e.g. '447' or '447970'.
  prefix: { type: DataTypes.STRING, allowNull: false },
  // One-time per-call connection fee, micro-pence (1e-6 GBP).
  connectMicros: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
  // Per-minute rate, micro-pence.
  perMinuteMicros: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
  // Optional human label, e.g. 'UK Mobile'.
  label: { type: DataTypes.STRING, allowNull: true },
}, {
  sequelize,
  timestamps: true,
  underscored: true,
  charset: 'utf8',
  collate: 'utf8_general_ci',
  indexes: [
    { unique: true, fields: ['tariff_id', 'prefix'] },
  ],
});

Tariff.hasMany(TariffPrefix, { as: 'prefixes', foreignKey: 'tariffId', onDelete: 'CASCADE' });
TariffPrefix.belongsTo(Tariff, { foreignKey: 'tariffId' });

// Frozen-cost invariant (mirrors RateCard): a Tariff is IMMUTABLE once a costed
// usage row's breakdown references it (by tariff name + startDate). Editing it
// would move historical destination cost — supersede with a new dated tariff
// instead. Guards the HEADER pricing fields; prefix-deck edits are gated at the
// CRUD layer (isTariffReferenced) since they live in the child table.
Tariff.addHook('beforeUpdate', async (tariff) => {
  const pricingFields = ['name', 'startDate', 'endDate', 'currency', 'defaultCountry'];
  if (!pricingFields.some((f) => tariff.changed(f))) return;
  const { Op: SeqOp } = sequelize.Sequelize;
  const prevStart = tariff.previous('startDate');
  const startIso = (prevStart instanceof Date ? prevStart : new Date(prevStart)).toISOString();
  const referenced = await UsageRecord.findOne({
    where: { metadata: { [SeqOp.contains]: { costBreakdown: [{ tariff: tariff.previous('name'), tariffStart: startIso }] } } },
    attributes: ['id'],
  });
  if (referenced) {
    throw new Error(
      `Tariff "${tariff.previous('name')}" is immutable once referenced by costed usage; `
      + 'supersede it with a new tariff (later startDate) instead of editing it.',
    );
  }
});

class PhoneNumber extends Model {

}

PhoneNumber.init({
  number: {
    type: DataTypes.STRING,
    primaryKey: true,
    required: true
  },
  handler: {
    type: DataTypes.STRING,
    enum: ['livekit', 'jambonz', 'pipecat'],
    required: true
  },
  reservation: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  outbound: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  provisioned: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  aplisayId: {
    type: DataTypes.STRING,
    required: false
  },
  callReceived: {
    type: DataTypes.DATE,
    allowNull: true
  }
},
  {
    sequelize,
    timestamps: true,
    underscored: true,
    charset: 'utf8',
    collate: 'utf8_general_ci',
  }
);

PhoneNumber.belongsTo(Instance, { foreignKey: 'instanceId', onDelete: 'SET NULL' });
PhoneNumber.belongsTo(Call, { foreignKey: 'callId', onDelete: 'SET NULL' });
Instance.hasOne(PhoneNumber, { foreignKey: 'instanceId', onDelete: 'SET NULL', as: 'number' });




// Registration-based endpoints (non-DDI)
const PhoneRegistration = initPhoneRegistration(sequelize, DataTypes);


class User extends Model {
  static cachedUsers = new Map();

  static async import(user) {
    if (User.cachedUsers.has(user.id)) {
      return User.cachedUsers.get(user.id);
    }
    else {
      try {
        logger.info({ user }, 'importing');
        let { id, name, email, emailVerified, phone, phoneVerified, picture } = user;
        const exists = await User.findByPk(id);
        const activate = (!exists || exists.status === 'provisional') ? { status: 'active' } : {};
        // Anti-clobber (parallel-auth phase, hardening item D): a Firebase login must
        // never overwrite a BETTER-AUTH-owned row's identity (name/email/emailVerified/
        // picture/role/signupMethod) — only heal its status. For a Firebase-owned /
        // legacy row we still refresh those from the token (which also populates
        // email_verified for the BA social-link bridge) and default role 'owner' on insert.
        const baOwned = exists && exists.signupMethod === 'better-auth';
        const fields = baOwned
          ? { id, ...activate }
          : { id, name, email, emailVerified, phone, phoneVerified, picture, signupMethod: 'firebase', ...(exists ? {} : { role: 'owner' }), ...activate };
        let [updatedUser,] = await User.upsert(fields);
        return updatedUser;
      } catch (e) {
        logger.error(e, `Can't upsert ${user.name}`);
      }
    }
  }

  /**
   * Atomically move this user to a different organisation (or to none with
   * `null`). Single-org affiliation is intentional — a user belongs to one
   * organisation at a time — but the change is wrapped in a transaction so
   * future multi-step checks (seat limits, membership validation) stay atomic.
   *
   * @param {string|null} organisationId
   * @return {Promise<User>} the saved user
   * @memberof User
   */
  async changeOrganisation(organisationId) {
    return sequelize.transaction(async (transaction) => {
      this.organisationId = organisationId;
      await this.save({ transaction });
      User.cachedUsers.delete(this.id);
      return this;
    });
  }

}

User.init({
  id: {
    type: DataTypes.STRING,
    primaryKey: true,
    required: true
  },
  name: {
    type: DataTypes.STRING,
    required: true
  },
  email: {
    type: DataTypes.STRING,
    required: true
  },
  emailVerified: {
    type: DataTypes.BOOLEAN,
    required: true
  },
  phone: {
    type: DataTypes.STRING,
    required: true
  },
  phoneVerified: {
    type: DataTypes.BOOLEAN,
    required: true
  },
  picture: {
    type: DataTypes.TEXT,
    required: true
  },
  // RBAC named role. Was legacy JSONB {admin,join} (enforced nowhere); migrated
  // in place to STRING on the 42->43 upgrade (see migrateUsersRoleToString).
  // Resolved to action statements + model-prefix defaults by lib/auth/permissions.js.
  role: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'owner',
  },
  // Additive per-user permission overrides ({resource:[actions]}), unioned on top
  // of the named role and the organisation baseline (R2).
  permissions: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  // Per-user model-access allow-list (prefix strings, e.g. ['text:']). Unioned
  // with the org baseline + role defaults by lib/auth/model-access.js;
  // null/[] = no extra restriction.
  allowedModels: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  // Per-user billing rate override (Phase 5): same shape as Organisation.rateHistory
  // ([{name, startDate}]). When present and covering the usage row's billedAt, the
  // costing resolver uses THIS instead of the org's rate — so a single user can be
  // priced differently. null = fall back to the organisation's rate.
  rateHistory: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  agentLimit: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  // Which auth provider created this row: 'firebase' | 'better-auth'. Lets us
  // tell the two apart during the parallel-auth phase. Better-Auth inserts get
  // 'better-auth' via a Postgres column default (see setColumnDefault on boot).
  signupMethod: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  status: {
    type: DataTypes.ENUM('provisional', 'active', 'suspended', 'deactivated'),
    allowNull: false,
    defaultValue: 'provisional',
  },
  banned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  banReason: { type: DataTypes.STRING, allowNull: true },
  banExpires: { type: DataTypes.DATE, allowNull: true },
},
  {
    sequelize,
    timestamps: true,
    underscored: true,
    charset: 'utf8',
    collate: 'utf8_general_ci',
  }
);


class Organisation extends Model {

}

Organisation.init({
  id: {
    type: DataTypes.STRING,
    primaryKey: true,
    required: true
  },
  name: {
    type: DataTypes.STRING,
    required: true
  },
  agentLimit: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  status: {
    type: DataTypes.ENUM('provisional', 'active', 'suspended', 'deactivated'),
    allowNull: false,
    defaultValue: 'active',
  },
  // RBAC baseline for every member of this org (R2). A user's effective perms
  // are the UNION of this baseline and their own role/permissions — org is the
  // floor; users can only ADD. Nullable: no baseline named role by default.
  role: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  permissions: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  // Baseline model-access allow-list shared by the whole org (prefix strings).
  allowedModels: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  // --- Billing (schema v44) ---
  // Ordered rate-name history: [{ name, startDate }] (ISO string / epoch ms).
  // Resolution = the entry with the greatest startDate <= the usage row's
  // billedAt. Structural validation + covering-card checks live in the
  // rate-assignment API (Phase 3); no model hook is added here.
  rateHistory: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  // Authoritative spendable-funds balance in MICRO-PENCE (1e-6 GBP). null =
  // balance NOT tracked (postpaid/unlimited). When numeric, decremented per
  // costed usage row via the delta primitive (lib/rates settle()). Hot-path
  // refusal is NOT enforced in v1 (see billingBlocked).
  balance: {
    type: DataTypes.BIGINT,
    allowNull: true,
    defaultValue: null,
  },
  // Frontend-configured billing automation (low/negative-balance callback URLs +
  // thresholds). DESIGN-ONLY in v1 (callbacks not yet fired).
  billingConfig: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  // Hard billing block: when true, Call.start() refuses new transactions — the
  // purpose-named lever the balanceNegative callback drives. DESIGN-ONLY in v1
  // (column present; enforcement deferred to phase 5).
  billingBlocked: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
},
  {
    sequelize,
    timestamps: true,
    underscored: true,
    charset: 'utf8',
    collate: 'utf8_general_ci',
  });

class CallConcurrency extends Model {}

CallConcurrency.init(
  {
    callId: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      references: { model: 'calls', key: 'id' },
      onDelete: 'CASCADE',
    },
    instanceId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'instances', key: 'id' },
      onDelete: 'CASCADE',
    },
    userId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE',
    },
    organisationId: {
      type: DataTypes.STRING,
      allowNull: true,
      references: { model: 'organisations', key: 'id' },
      onDelete: 'CASCADE',
    },
  },
  {
    sequelize,
    modelName: 'CallConcurrency',
    tableName: 'call_concurrency',
    timestamps: true,
    underscored: true,
    charset: 'utf8',
    collate: 'utf8_general_ci',
  },
);


class AuthKey extends Model {
  static cacheTime = 60 * 1000;
  static negativeCacheTime = 10 * 1000;
  static cachedKeys = new Map();
  static async verify(key) {
    if (AuthKey.cachedKeys.has(key)) {
      let { user, expiry } = AuthKey.cachedKeys.get(key);
      if (expiry < Date.now()) {
        AuthKey.cachedKeys.delete(key);
      }
      else {
        return { user, expiry };
      }
    }
    let authKey = await AuthKey.findOne({ where: { key }, include: [User] });
    if (authKey && authKey.User) {
      // Do NOT clobber User.role with the legacy JSONB roleRestriction — role is
      // now an RBAC STRING. Stash it for a future per-key permission intersection
      // (migration plan §4.6); today an AuthKey inherits its owner's permissions.
      authKey.roleRestriction && (authKey.User._roleRestriction = authKey.roleRestriction);
      let expiry = new Date((new Date()).getTime() + AuthKey.cacheTime);
      AuthKey.cachedKeys.set(key, { user: authKey.User, expiry });
      return { user: authKey.User, expiry };
    }
    else {
      AuthKey.cachedKeys.set(key, { negative: true, expiry: new Date((new Date()).getTime() + AuthKey.negativeCacheTime) });
      return false;
    }
  }

}


AuthKey.init({
  key: {
    type: DataTypes.STRING,
    primaryKey: true,
    required: true
  },
  roleRestriction: {
    type: DataTypes.JSONB,
    required: true
  },
  expires: {
    type: DataTypes.DATE,
    required: true
  }
},
  {
    sequelize,
    timestamps: true,
    underscored: true,
    charset: 'utf8',
    collate: 'utf8_general_ci',
  });

User.belongsTo(Organisation, { onDelete: 'CASCADE', foreignKey: 'organisationId' });
Organisation.hasMany(User, { onDelete: 'CASCADE', foreignKey: 'organisationId' });

PhoneNumber.belongsTo(Organisation, { foreignKey: 'organisationId', onDelete: 'SET NULL' });
PhoneRegistration.belongsTo(Organisation, { foreignKey: 'organisationId', onDelete: 'SET NULL' });

PhoneRegistration.belongsTo(Instance, { foreignKey: 'instanceId', onDelete: 'SET NULL' });
Instance.hasOne(PhoneRegistration, { foreignKey: 'instanceId', onDelete: 'SET NULL', as: 'registration' });

Agent.belongsTo(Organisation, { onDelete: 'CASCADE', foreignKey: 'organisationId' });
Organisation.hasMany(Agent, { onDelete: 'CASCADE', foreignKey: 'organisationId' });

Agent.belongsTo(AgentSet, { onDelete: 'CASCADE', foreignKey: 'agentSetId' });
AgentSet.hasMany(Agent, { onDelete: 'CASCADE', foreignKey: 'agentSetId', as: 'agents' });

AgentSet.belongsTo(Organisation, { onDelete: 'CASCADE', foreignKey: 'organisationId' });
Organisation.hasMany(AgentSet, { onDelete: 'CASCADE', foreignKey: 'organisationId' });

AgentSet.belongsTo(User, { onDelete: 'CASCADE', foreignKey: 'userId' });
User.hasMany(AgentSet, { onDelete: 'CASCADE', foreignKey: 'userId' });

Instance.belongsTo(Organisation, { onDelete: 'CASCADE', foreignKey: 'organisationId' });
Organisation.hasMany(Instance, { onDelete: 'CASCADE', foreignKey: 'organisationId' });

Call.belongsTo(Organisation, { onDelete: 'CASCADE', foreignKey: 'organisationId' });
Organisation.hasMany(Call, { onDelete: 'CASCADE', foreignKey: 'organisationId' });

TransactionLog.belongsTo(Organisation, { onDelete: 'CASCADE', foreignKey: 'organisationId' });
Organisation.hasMany(TransactionLog, { onDelete: 'CASCADE', foreignKey: 'organisationId' });

InvocationLog.belongsTo(Call, { foreignKey: 'callId', onDelete: 'CASCADE' });
InvocationLog.belongsTo(Organisation, { foreignKey: 'organisationId', onDelete: 'SET NULL' });
InvocationLog.belongsTo(User, { foreignKey: 'userId', onDelete: 'SET NULL' });
Call.hasMany(InvocationLog, { foreignKey: 'callId', as: 'invocationLogs' });

UsageRecord.belongsTo(Call, { foreignKey: 'callId', onDelete: 'CASCADE' });
Call.hasMany(UsageRecord, { foreignKey: 'callId', as: 'usageRecords' });
UsageRecord.belongsTo(Organisation, { foreignKey: 'organisationId', onDelete: 'SET NULL' });
Organisation.hasMany(UsageRecord, { foreignKey: 'organisationId' });
UsageRecord.belongsTo(User, { foreignKey: 'userId', onDelete: 'SET NULL' });
User.hasMany(UsageRecord, { foreignKey: 'userId' });
UsageRecord.belongsTo(Agent, { foreignKey: 'agentId', onDelete: 'SET NULL' });
Agent.hasMany(UsageRecord, { foreignKey: 'agentId' });


AuthKey.belongsTo(User, { onDelete: 'CASCADE', foreignKey: 'userId' });
User.hasMany(AuthKey, { onDelete: 'CASCADE', foreignKey: 'userId' });

Agent.belongsTo(User, { onDelete: 'CASCADE', foreignKey: 'userId' });
User.hasMany(Agent, { onDelete: 'CASCADE', foreignKey: 'userId' });

Instance.belongsTo(Agent, { onDelete: 'CASCADE', foreignKey: 'agentId' });
Agent.hasMany(Instance, { onDelete: 'CASCADE', foreignKey: 'agentId' });

Instance.belongsTo(User, { onDelete: 'CASCADE', foreignKey: 'userId' });
User.hasMany(Instance, { onDelete: 'CASCADE', foreignKey: 'userId' });

Call.belongsTo(User, { onDelete: 'CASCADE', foreignKey: 'userId' });
User.hasMany(Call, { onDelete: 'CASCADE', foreignKey: 'userId' });

TransactionLog.belongsTo(User, { onDelete: 'CASCADE', foreignKey: 'userId' });
User.hasMany(TransactionLog, { onDelete: 'CASCADE', foreignKey: 'userId' });

// Trunks available for endpoints
class Trunk extends Model {}

Trunk.init({
  id: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false
  },
  name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  handler: {
    type: DataTypes.STRING,
    allowNull: true
  },
  outbound: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  // Destination billing (Phase D3): true = one of our public/carrier trunks whose
  // outbound minutes WE pay for, so calls carried out on it are destination-charged
  // to the org. False (default) = not our cost — a customer's own PBX via a
  // registration B2BUA, a BYO carrier, or an inbound trunk. Positively configured by
  // an admin; only the one/two real public trunks are ever set true.
  chargeable: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  flags: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: null
  }
}, {
  sequelize,
  timestamps: true,
  underscored: true,
  charset: 'utf8',
  collate: 'utf8_general_ci',
});

class TrunkOrganisation extends Model {}

TrunkOrganisation.init({
  trunkId: {
    type: DataTypes.STRING,
    primaryKey: true,
    references: {
      model: 'trunks',
      key: 'id'
    },
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  },
  organisationId: {
    type: DataTypes.STRING,
    primaryKey: true,
    references: {
      model: 'organisations',
      key: 'id'
    },

    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  }
}, {
  sequelize,
  timestamps: true,
  underscored: true,
  charset: 'utf8',
  collate: 'utf8_general_ci',
});

Organisation.belongsToMany(Trunk, { through: TrunkOrganisation});
Trunk.belongsToMany(Organisation, { through: TrunkOrganisation});

// PhoneNumber to Trunk association (via aplisayId)
PhoneNumber.belongsTo(Trunk, { foreignKey: 'aplisayId', targetKey: 'id', as: 'Trunk', onDelete: 'SET NULL' });
Trunk.hasMany(PhoneNumber, { foreignKey: 'aplisayId', sourceKey: 'id', as: 'PhoneNumbers' });

agentConcurrencyLimits = createAgentConcurrencyLimits({
  sequelize,
  Transaction,
  Instance,
  User,
  Organisation,
  CallConcurrency,
  logger,
});

let doUpgrade = false;
let dbVersion = 0;

// Idempotent Postgres ENUM value additions.
//
// Sequelize's `sync({ alter: true })` does *not* reconcile changes to the
// `values:` list of an existing Postgres ENUM type — once the type is created,
// new values must be added explicitly via ALTER TYPE. We run these
// unconditionally on every boot so handlers added since the last full schema
// upgrade still work even in environments where `DB_FORCE_SYNC` is unset.
//
// `ADD VALUE IF NOT EXISTS` is a no-op when the value already exists, so this
// is safe to retry. The statements must run outside a transaction in some PG
// versions; sequelize.query() uses autocommit by default which is fine.
async function addEnumValueIfMissing(typeName, value) {
  try {
    await sequelize.query(`ALTER TYPE "${typeName}" ADD VALUE IF NOT EXISTS '${value}'`);
  } catch (err) {
    // Don't take the process down for an ALTER TYPE failure on first-run
    // (when the type doesn't yet exist — the upcoming sync() will create it
    // with the right values).
    logger.warn({ err: err?.message, typeName, value }, 'addEnumValueIfMissing: ignoring');
  }
}

// Set a Postgres-level column DEFAULT. Used so Better-Auth's direct inserts
// (which go through its own Kysely adapter, bypassing Sequelize defaults and
// User.import) still produce a `users` row shaped like a Firebase signup —
// e.g. the legacy `role` grant. Idempotent and best-effort; a failure (column
// not yet created on a non-upgraded DB) is logged, not fatal.
async function setColumnDefault(table, column, defaultSql) {
  try {
    await sequelize.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" SET DEFAULT ${defaultSql}`);
  } catch (err) {
    logger.warn({ err: err?.message, table, column }, 'setColumnDefault: ignoring');
  }
}

// Migrate users.role from the legacy JSONB ({admin,join}) to a STRING named role
// (RBAC). Postgres can't implicitly cast jsonb->varchar, so Sequelize
// sync({alter:true}) would error on the type change; run this idempotent cast
// BEFORE User.sync. Every existing row is backfilled to 'owner' (== today's
// full-perms-within-own-org behaviour), so enabling RBAC is a no-op for current
// users. Guarded on the live column type, so it is safe to run on every boot.
async function migrateUsersRoleToString() {
  try {
    const [rows] = await sequelize.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'role'`,
    );
    if (rows?.[0]?.data_type === 'jsonb') {
      logger.info('Migrating users.role jsonb -> varchar (backfill role=owner)');
      await sequelize.query(`ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT`);
      await sequelize.query(`ALTER TABLE "users" ALTER COLUMN "role" TYPE varchar(255) USING 'owner'`);
      await sequelize.query(`ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'owner'`);
    }
  } catch (err) {
    logger.warn({ err: err?.message }, 'migrateUsersRoleToString: ignoring');
  }
}

// Per-name non-overlap for rate cards, enforced at the DB level. Sequelize's
// sync() can't emit an EXCLUDE constraint, so add it idempotently here (run after
// RateCard.sync in the upgrade chain). The `name WITH =` equality member needs the
// btree_gist extension. Best-effort: if the extension can't be created (privileges)
// the app-level validation in the rate API remains the primary guard, so we log
// and continue. tstzrange(start_date, end_date) is '[)' (end exclusive), so
// adjacent cards [t0,t1) and [t1,t2) do not collide; a null end_date is unbounded.
async function addRateCardOverlapConstraint() {
  try {
    await sequelize.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    await sequelize.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'rate_cards_name_period_excl'
        ) THEN
          ALTER TABLE "rate_cards" ADD CONSTRAINT rate_cards_name_period_excl
            EXCLUDE USING gist (name WITH =, tstzrange(start_date, end_date) WITH &&);
        END IF;
      END $$;
    `);
  } catch (err) {
    logger.warn({ err: err?.message }, 'addRateCardOverlapConstraint: ignoring');
  }
}

// Per-name non-overlap for tariffs (mirrors addRateCardOverlapConstraint): a
// destination tariff version covers [start_date, end_date) and a null end_date is
// open; adjacent versions [t0,t1) and [t1,t2) do not collide. Best-effort (needs
// btree_gist); the tariff CRUD app-level checks remain the primary guard.
async function addTariffOverlapConstraint() {
  try {
    await sequelize.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    await sequelize.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'tariffs_name_period_excl'
        ) THEN
          ALTER TABLE "tariffs" ADD CONSTRAINT tariffs_name_period_excl
            EXCLUDE USING gist (name WITH =, tstzrange(start_date, end_date) WITH &&);
        END IF;
      END $$;
    `);
  } catch (err) {
    logger.warn({ err: err?.message }, 'addTariffOverlapConstraint: ignoring');
  }
}

const databaseStarted = sequelize.authenticate()
  .then(async () => {
    logger.debug({ POSTGRES_DB, forceSync, dbVersion, schemaVersion }, 'Database connected');
    await addEnumValueIfMissing('enum_instances_type', 'pipecat');
    await addEnumValueIfMissing('enum_invocation_logs_subsystem', 'pipecat-agent');
    return Metadata.sync({ alter: true })
    .then(() => Metadata.findOne({ where: { key: 'dbVersion' } }))
      .then((res) => {
        logger.debug({ res }, 'result');
        const dbVersion = new Number(res?.value);
        if (res && dbVersion) {
          if (schemaVersion > dbVersion) {
            doUpgrade = forceSync;
            logger.info({ dbVersion, schemaVersion }, doUpgrade ? 'Upgrading database' : 'version mismatch, wont upgrade');
          }
          if (schemaVersion < dbVersion) {
            logger.error({ dbVersion, schemaVersion }, 'Database version mismatch');
          }
        } else {
          logger.debug('Database version not found');
          doUpgrade = true;
          return true;
        }
      })
      .catch((err) => {
        logger.error({ err }, 'Database version not found (catch)');
        doUpgrade = forceSync; // Set doUpgrade when no metadata exists
        logger.debug({ doUpgrade, forceSync }, 'Setting doUpgrade in catch block');
        return true;
      });
  })
  // RBAC: cast users.role jsonb->varchar BEFORE any sync, and ALWAYS (idempotent +
  // type-guarded). Outside the doUpgrade gate so it also runs on a v42 DB booted
  // without DB_FORCE_SYNC — keeping the column type matched to the STRING model and
  // the setColumnDefault('users','role',`'owner'`) below valid (a SET DEFAULT 'owner'
  // on a still-jsonb column would error).
  .then(() => migrateUsersRoleToString())
  .then(() => (doUpgrade && Metadata.sync({ alter: true })
    .then(() => Organisation.sync({ alter: true }))
    .then(() => User.sync({ alter: true }))
    .then(() => AgentSet.sync({ alter: true }))
    .then(() => Agent.sync({ alter: true }))
    .then(() => Instance.sync({ alter: true }))
    .then(() => Call.sync({ alter: true }))
    .then(() => CallConcurrency.sync({ alter: true }))
    .then(() => CallRecordingDownload.sync({ alter: true }))
    .then(() => Call.initIndex())
    .then(() => TransactionLog.sync({ alter: true }))
    .then(() => InvocationLog.sync({ alter: true }))
    .then(() => UsageRecord.sync({ alter: true }))
    .then(() => RateCard.sync({ alter: true }))
    .then(() => addRateCardOverlapConstraint())
    .then(() => BalanceCredit.sync({ alter: true }))
    .then(() => Tariff.sync({ alter: true }))
    .then(() => addTariffOverlapConstraint())
    .then(() => TariffPrefix.sync({ alter: true }))
    .then(() => Trunk.sync({ alter: true }))
    .then(() => PhoneNumber.sync({ alter: true }))
    .then(() => PhoneRegistration.sync({ alter: true }))
    .then(() => TrunkOrganisation.sync({ alter: true }))
    .then(() => AuthKey.sync({ alter: true }))
    .then(() => {
      logger.info({ dbVersion, schemaVersion }, 'Database upgraded');
      return Metadata.upsert({ key: 'dbVersion', value: schemaVersion }, { returning: true });
    })) || Promise.resolve())
  .then(async () => {
    // Domain-column defaults for Better-Auth's direct inserts (parallel-auth phase).
    await setColumnDefault('users', 'role', `'owner'`);
    await setColumnDefault('users', 'signup_method', `'better-auth'`);
    await setColumnDefault('users', 'status', `'provisional'`);
    const healResult = await sequelize.query(
      `UPDATE "users" SET "status" = 'active'
         WHERE "status" = 'provisional'
           AND ("signup_method" = 'firebase' OR "signup_method" IS NULL)`,
    );
    const healed = healResult?.[1]?.rowCount ?? healResult?.[1] ?? 0;
    if (healed) logger.info({ healed }, 'Activated legacy users.status (provisional -> active)');
  })
  .then(() =>
    logger.debug({ POSTGRES_DB }, 'Connection has been established successfully.'))
  .then(() => listener.connect())
  .then((instance) => {
    logger.debug('Connected to listener');
    listener.events.on('error', (err) => {
      // If we've lost the listener connection, then we need to close the database connection
      //  and start everything again. Because of the risk of leaking resources it is safer to just
      //  exit the process and let the container restart cleanly.
      logger.error(err, 'Listener error');
      try {
        listener.close();
        sequelize.close();
      } catch (e) {
        logger.error(e, 'Unable to close listener or database');
      }
      process.exit(1);
    });
  })
  .catch(error => {
    logger.error(error, 'Unable to connect to the database:');
    process.exit(1);
  });

const stopDatabase = async () => {
  // We could actually still be starting, so wait for that promise chain to complete
  //  before we really start a race condition by shutting down
  await databaseStarted;
  await listener.close();
  await sequelize.close();
};


export {
  Agent,
  AgentSet,
  Instance,
  PhoneNumber,
  PhoneRegistration,
  Call,
  TransactionLog,
  InvocationLog,
  CallRecordingDownload,
  UsageRecord,
  RateCard,
  BalanceCredit,
  Tariff,
  TariffPrefix,
  User,
  Organisation,
  AuthKey,
  Trunk,
  CallConcurrency,
  Op,
  Sequelize,
  databaseStarted,
  stopDatabase,
};
export { AgentConcurrencyLimitExceededError } from './concurrency/agent-concurrency-limits.js';