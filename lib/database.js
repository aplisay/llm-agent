const { Sequelize, Model, DataTypes } = require('sequelize');


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


class Instance extends Model { }
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
},
  {
    sequelize,
    timestamps: true,
    underscored: true,
    charset: 'utf8',
    collate: 'utf8_general_ci',
  }
);

Instance.belongsTo(Agent, {foreignKey: 'agentId'});

sequelize.authenticate()
  .then(() => Agent.sync({ alter: true }))
  .then(() => Instance.sync({ alter: true }))
  .then(() =>
    console.log('Connection has been established successfully.'))
  .catch(error =>
    console.error('Unable to connect to the database:', error));


module.exports = { Agent, Instance };