const dotenv = require('dotenv').config();
const { Sequelize, Model, DataTypes, Op } = require('sequelize');
const Listener = require('pg-listen');
const logger = require('./logger');


const { POSTGRES_DB, POSTGRES_USER, POSTGRES_HOST, POSTGRES_PASSWORD, POSTGRES_PORT, POSTGRES_KEY, POSTGRES_CERT, POSTGRES_CA, POSTGRES_RO_SERVER_NAME } = process.env;

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
    const [count, row] = await PhoneNumber.update(
      { instanceId: this.id },
      {
        where,
        returning: true
      });
    if (count !== 1) {
      throw new Error(`No phone number found for ${number}`);
    }
    console.log({ count, row }, 'update suceeded');
    return row[0].number;
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
    values: ['jambonz', 'ultravox', 'lk_realtime', 'lk_pipeline'],
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
  callerId: {
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
    hooks: {
      afterCreate: async (call) => {
        if ((await Instance.findByPk(call.instanceId)).streamLog) {
          console.log(`Streaming logs for call ${call.id}`);
          call.streamLog = call.instanceId;
        }
      }
    }
  }
);

Call.belongsTo(Instance, { foreignKey: 'instanceId', onDelete: 'CASCADE' });

class TransactionLog extends Model {
  static async on(id, handler) {
    let tag = 'progress' + id.replace(/-/g, '');
    console.log(`Setting up listener for ${tag}`);
    if (handler) {
      listener.notifications.on(tag, (payload) => {
        // Payload as passed to listener.notify() (see below)
        console.log(payload, `Received notification for ${tag}`);
        handler(payload);
      });
      console.log(`Waiting for notifications for ${tag}`);

      await listener.listenTo(tag);
    } else {
      await listener.stopListeningTo(tag);
    }
  }
  static notify(transactionLog, options) {
    let notify = streamIds[transactionLog.callId];
    console.log({ transactionLog, notify }, `Notifying ${transactionLog.callId}`);
    if (notify) {
      let data;
      try {
        data = JSON.parse(transactionLog.data);
      }
      catch (e) {
        data = transactionLog.data;
      }
      console.log({ [transactionLog.type]: data }, `Notifying logs progress${notify.replace(/-/g, '')}`);
      listener.notify(`progress${notify.replace(/-/g, '')}`, { [transactionLog.type]: data });
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
    values: ['start', 'hangup', 'answer', 'agent', 'user', 'function_call', 'rest_callout', 'function_results'],
    required: true
  },
  data: {
    type: DataTypes.JSONB
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

const databaseStarted = sequelize.authenticate()
  .then(() => Agent.sync({ alter: true }))
  .then(() => Instance.sync({ alter: true }))
  .then(() => Call.sync({ alter: true }))
  .then(() => TransactionLog.sync({ alter: true }))
  .then(() => PhoneNumber.sync({ alter: true }))
  .then(() =>
    console.log('Connection has been established successfully.'))
  .then(() => listener.connect())
  .then(() => console.log('Connected to listener'))
  .catch(error =>
    console.error('Unable to connect to the database:', error));


module.exports = { Agent, Instance, PhoneNumber, Call, TransactionLog, databaseStarted };  