const dotenv = require('dotenv').config();
const { Sequelize, Model, DataTypes, Op, Transaction } = require('sequelize');
const Listener = require('pg-listen');
const logger = require('./logger');

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

// This is the maximum size of a notification payload we will send
//  to the client.  Postgres has a max of 8k for the whole JSON so we
//  sandbag this to be much smaller to ensure that we don't come close, even with 

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
const listener = new Listener({
  connectionString: `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`,
  ssl: {
    ca: POSTGRES_CA,
    key: POSTGRES_KEY,
    cert: POSTGRES_CERT,
    servername: POSTGRES_RO_SERVER_NAME
  }
});

let streamIds = {};

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
  async linkNumber(handler, number) {
    let where = {
      instanceId: { [Op.eq]: null },
      handler
    };
    number && number !== '*' && (where.number = number);
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
          throw new Error(`No phone number found for ${number}`);
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
  room: {
    type: DataTypes.STRING
  },
  streamLog: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
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

class Call extends Model {
  set streamLog(value) {
    if (value) {
      streamIds[this.id] = value;
    } else {
      delete streamIds[this.id];
    }
  }
  end() {
    this.endedAt = new Date();
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
  }
},
  {
    sequelize,
    timestamps: true,
    underscored: true,
    charset: 'utf8',
    collate: 'utf8_general_ci',
    hooks: {
      afterCreate: async (call) => {
        if ((await Instance.findByPk(call.instanceId)).streamLog) {
          logger.debug(`Streaming logs for call ${call.id}`);
          call.streamLog = call.instanceId;
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

PhoneNumber.belongsTo(Instance, { foreignKey: 'instanceId', onDelete: 'SET NULL' });
PhoneNumber.belongsTo(Call, { foreignKey: 'callId', onDelete: 'SET NULL' });

class User extends Model {
  static cachedUsers = new Map();

  static async import(user) {
    if (User.cachedUsers.has(user.id)) {
      return;
    }
    else {
      try {
        logger.info({ user }, 'importing');
        let { id, name, email, emailVerified, phone, phoneVerified, picture, role = { admin: true } } = user;
        await User.upsert({ id, name, email, emailVerified, phone, phoneVerified, picture, role });
      } catch (e) {
        logger.error(e, `Can't upsert ${user.name}`);
      }
      User.cachedUsers.set(user.id, user);
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


User.belongsTo(Organisation, { onDelete: 'CASCADE' });


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

AuthKey.belongsTo(User, { onDelete: 'CASCADE' });
Agent.belongsTo(User, { onDelete: 'CASCADE' });
Instance.belongsTo(User, { onDelete: 'CASCADE' });
Call.belongsTo(User, { onDelete: 'CASCADE' });
TransactionLog.belongsTo(User, { onDelete: 'CASCADE' });


const databaseStarted = sequelize.authenticate()
  .then(() => forceSync && Agent.sync({ alter: true })
    .then(() => Instance.sync({ alter: true }))
    .then(() => Call.sync({ alter: true }))
    .then(() => TransactionLog.sync({ alter: true }))
    .then(() => PhoneNumber.sync({ alter: true }))
    .then(() => User.sync({ alter: true }))
    .then(() => Organisation.sync({ alter: true }))
    .then(() => AuthKey.sync({ alter: true }))
  )
  .then(() =>
    logger.debug({ POSTGRES_DB }, 'Connection has been established successfully.'))
  .then(() => listener.connect())
  .then((instance) => {
    logger.debug('Connected to listener');
    listener.events.on('error', (err) => {
      logger.error(err, 'Listener error');
      setTimeout(async () => {
        try {
          await listener.connect();
          logger.debug('Reconnected to listener');
        } catch (e) {
          logger.error(e, 'Unable to reconnect to listener');
        }
      }, 3000);
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


module.exports = {
  Agent, Instance, PhoneNumber, Call, TransactionLog, User, Organisation, AuthKey,
  Op,
  databaseStarted, stopDatabase
};  