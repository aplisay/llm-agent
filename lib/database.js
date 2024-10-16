const dotenv = require('dotenv').config();
const { Sequelize, Model, DataTypes } = require('sequelize');
const Listener = require('pg-listen');


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
    }
  });

// These need separate DB connections as Sequelize pools connections, but subscriptions are per connection
//  so any attempt to LISTEN through Sequelize turns out to be super brittle as connections churn.
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



class Agent extends Model { }
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
  sipNumber: {
    type: DataTypes.STRING
  },
  room: {
    type: DataTypes.STRING
  },
  streamLogs: {
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
Instance.belongsTo(Agent, { foreignKey: 'agentId' });

class Call extends Model {
  set streamLogs(value) {
    if (value) {
      streamIds[this.id] = true;
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
        if ((await Instance.findByPk(call.instanceId)).streamLogs) {
          console.log(`Streaming logs for call ${call.id}`);
          call.streamLogs = true;
        }
      }
    }
  }
);

Call.belongsTo(Instance, { foreignKey: 'instanceId' });

class TransactionLog extends Model {
  static async on(id, handler) {
    if (handler) {
      listener.notifications.on(id, (payload) => {
        // Payload as passed to listener.notify() (see below)
        console.log(payload, `Received notification for ${id}`);
        handler(payload);
      });
      await listener.listenTo(id);
    } else {
      await listener.stopListeningTo(id);
    }
  }
  static notify(transactionLog, options) {
    console.log(transactionLog, `Notifying ${transactionLog.callId}`);
    if (streamIds[transactionLog.callId]) {
      listener.notify(transactionLog.callId, transactionLog);
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


TransactionLog.belongsTo(Call, { foreignKey: 'callId' });




sequelize.authenticate()
  .then(() => Agent.sync({ alter: true }))
  .then(() => Instance.sync({ alter: true }))
  .then(() => Call.sync({ alter: true }))
  .then(() => TransactionLog.sync({ alter: true }))
  .then(() =>
    console.log('Connection has been established successfully.'))
  .catch(error =>
    console.error('Unable to connect to the database:', error));


module.exports = { Agent, Instance, Call, TransactionLog };