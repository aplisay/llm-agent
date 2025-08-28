import { Sequelize, Model, DataTypes, Op, Transaction } from 'sequelize';
import Listener from 'pg-listen';
import logger from './logger.js';
import { getHandler } from './handlers/index.js';

const schemaVersion = 13;

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
  DB_FORCE_SYNC } = process.env;

const forceSync = NODE_ENV === 'development' || DB_FORCE_SYNC === 'true';


const sequelize = new Sequelize(
  POSTGRES_DB,
  POSTGRES_USER,
  POSTGRES_PASSWORD,
  {
    dialect: 'postgres',
    host: POSTGRES_HOST,
    port: POSTGRES_PORT,
    dialectOptions: {
      ssl: {
        ca: POSTGRES_CA,
        key: POSTGRES_KEY,
        cert: POSTGRES_CERT,
        servername: POSTGRES_RO_SERVER_NAME
      }
    },
    logging: logger.trace.bind(logger)
  });

// These need separate DB connections as Sequelize pools connections, but subscriptions are per connection
//  so any attempt to LISTEN through Sequelize turns out to be super brittle due to connection churn.
const LISTENER_CONNECTION = {
  connectionString: `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`,
  ssl: {
    ca: POSTGRES_CA,
    key: POSTGRES_KEY,
    cert: POSTGRES_CERT,
    servername: POSTGRES_RO_SERVER_NAME
  }
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
            Agent
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
    type: DataTypes.JSONB
  },
  functions: {
    type: DataTypes.JSONB
  },
  keys: {
    type: DataTypes.JSONB
  }
},
  {
    sequelize,
    timestamps: true,
    underscored: true,
    charset: 'utf8',
    collate: 'utf8_general_ci',
    validate: {
      async handlerLimitations() {
        logger.debug({ getHandler, modelName: this.modelName }, 'Handler');
        let Handler = await getHandler(this.modelName);
        logger.debug({ getHandler, Handler, modelName: this.modelName }, 'Handler');
        if (!Handler) {
          throw new Error(`Unknown model name: ${this.modelName}`);
        }
        if (this.options?.tts?.voice) {
          const allVoices = Object.values(await Handler.voices).flat().map(v => Object.values(v)).flat().flat().map(v => v.name);
          if (!allVoices.includes(this.options.tts.voice)) {
            logger.error({ options: this.options, voices: allVoices }, 'Voice not supported');
            throw new Error(`Voice ${this.options.tts.voice} not supported by ${this.modelName}`);
          }
        }
        const functions = Object.entries(this.functions);
        return functions.every(([name, func]) => {
          if (func.implementation !== 'builtin')
            return true;
          if (!Handler.hasTransfer) {
            throw new Error(`Model ${this.modelName} does not support transfer, but transfer function was found in functions`);
          }
          if (!func.platform || !func.platform?.length) {
            throw new Error(`Builtin function ${name} must specify platform function name to be used`);
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
              if (!func.input_schema.properties
                || Object.keys(func.input_schema.properties).length !== 1
                || !func.input_schema.properties.number) {
                throw new Error('Transfer function must have a single parameter called "number"');
              }
              if (func.input_schema.properties.number.source === 'generated') {
                throw new Error('Transfer function "number" parameter cannot be generated, must be either "static" or "metadata"');
              }
              return true;
            default:
              throw new Error(`Unknown platform function: ${func.platform}`);
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
      where = { ...where, number };
    }
    else {
      // We can only match unreserved numbers owned by us or no organisation
      where = {
        ...where,
        // We can only match numbers which are supported by this handler
        handler,
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
    values: ['jambonz', 'ultravox', 'livekit'],
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
  end() {
    this.endedAt = new Date();
    this.duration = this.startedAt && this.endedAt.valueOf() - this.startedAt.valueOf();
    this.live = false;
    this.save();
  }
  start() {
    this.startedAt = new Date();
    this.live = true;
    this.save();
  }

}

Call.init({
  id: {
    type: DataTypes.UUID,
    primaryKey: true,
    defaultValue: DataTypes.UUIDV4
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
  streamUrl: {
    type: DataTypes.STRING,
  },
  startedAt: {
    type: DataTypes.DATE,
  },
  endedAt: {
    type: DataTypes.DATE
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
          payload = { [log.type]: JSON.parse(log.data) };
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
      let { type, data, isFinal } = transactionLog;
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
      data && listener.notify(`progress${notify.replace(/-/g, '')}`, { [type]: data, isFinal });
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
    values: ['start', 'hangup', 'goodbye', 'answer', 'inject', 'call', 'agent', 'user', 'function_calls', 'rest_callout', 'function_results', 'error'],
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
    enum: ['livekit', 'jambonz'],
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
  aplisayId: {
    type: DataTypes.STRING,
    required: false
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




class User extends Model {
  static cachedUsers = new Map();

  static async import(user) {
    if (User.cachedUsers.has(user.id)) {
      return User.cachedUsers.get(user.id);
    }
    else {
      try {
        logger.info({ user }, 'importing');
        let { id, name, email, emailVerified, phone, phoneVerified, picture, role = { admin: true, join: true } } = user;
        let [updatedUser,] = await User.upsert({ id, name, email, emailVerified, phone, phoneVerified, picture, role });
        return updatedUser;
      } catch (e) {
        logger.error(e, `Can't upsert ${user.name}`);
      }
      User.cachedUsers.set(user.id, updatedUser);
    }
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
  role: {
    type: DataTypes.JSONB,
    required: true
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
  }
},
  {
    sequelize,
    timestamps: true,
    underscored: true,
    charset: 'utf8',
    collate: 'utf8_general_ci',
  });


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
      authKey.roleRestriction && (authKey.User.role = authKey.roleRestriction);
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

Agent.belongsTo(Organisation, { onDelete: 'CASCADE', foreignKey: 'organisationId' });
Organisation.hasMany(Agent, { onDelete: 'CASCADE', foreignKey: 'organisationId' });

Instance.belongsTo(Organisation, { onDelete: 'CASCADE', foreignKey: 'organisationId' });
Organisation.hasMany(Instance, { onDelete: 'CASCADE', foreignKey: 'organisationId' });

Call.belongsTo(Organisation, { onDelete: 'CASCADE', foreignKey: 'organisationId' });
Organisation.hasMany(Call, { onDelete: 'CASCADE', foreignKey: 'organisationId' });

TransactionLog.belongsTo(Organisation, { onDelete: 'CASCADE', foreignKey: 'organisationId' });
Organisation.hasMany(TransactionLog, { onDelete: 'CASCADE', foreignKey: 'organisationId' });


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

let doUpgrade = false;
let dbVersion = 0;

const databaseStarted = sequelize.authenticate()
  .then(() => {
    logger.debug({ POSTGRES_DB, forceSync, dbVersion, schemaVersion }, 'Database connected');
    return Metadata.findOne({ where: { key: 'dbVersion' } })
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
          return Metadata.create({ key: 'dbVersion', value: '0' });
        }
      })
      .catch((err) => {
        logger.error({ err }, 'Database version not found');
        return Metadata.sync({ alter: true }) // create table
          .then(() => true);
      });
  })
  .then(() => (doUpgrade && Metadata.sync({ alter: true })
    .then(() => Agent.sync({ alter: true }))
    .then(() => Instance.sync({ alter: true }))
    .then(() => Call.sync({ alter: true }))
    .then(() => Call.initIndex())
    .then(() => TransactionLog.sync({ alter: true }))
    .then(() => PhoneNumber.sync({ alter: true }))
    .then(() => User.sync({ alter: true }))
    .then(() => Organisation.sync({ alter: true }))
    .then(() => AuthKey.sync({ alter: true }))
    .then(() => {
      logger.info({ dbVersion, schemaVersion }, 'Database upgraded');
      return Metadata.update({ value: schemaVersion }, { where: { key: 'dbVersion' } });
    })) || Promise.resolve())
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
  .catch(error =>
    console.error(error, 'Unable to connect to the database:'));

const stopDatabase = async () => {
  // We could actually still be starting, so wait for that promise chain to complete
  //  before we really start a race condition by shutting down
  await databaseStarted;
  await listener.close();
  await sequelize.close();
};


export {
  Agent, Instance, PhoneNumber, Call, TransactionLog, User, Organisation, AuthKey,
  Op, Sequelize,
  databaseStarted, stopDatabase
};  