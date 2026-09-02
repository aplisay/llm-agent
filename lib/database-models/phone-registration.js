import { Model, DataTypes } from 'sequelize';
import { encryptSecret, decryptSecret, PHONE_REGISTRATION_STATE_VALUES, PHONE_REGISTRATION_STATUS_VALUES, PHONE_REGISTRATION_SCHEMA_VERSION } from '../utils/credentials.js';

class PhoneRegistration extends Model {}

export function initPhoneRegistration(sequelize, types = DataTypes) {
  PhoneRegistration.init({
    id: {
      type: types.UUID,
      primaryKey: true,
      defaultValue: types.UUIDV4
    },
    name: {
      type: types.STRING,
      allowNull: true
    },
    handler: {
      type: types.STRING,
      allowNull: false,
      defaultValue: 'livekit'
    },
    outbound: {
      type: types.BOOLEAN,
      defaultValue: false
    },
    registrar: {
      type: types.STRING,
      allowNull: false
    },
    b2buaId: {
      type: types.STRING,
      allowNull: true
    },
    username: {
      type: types.STRING,
      allowNull: false
    },
    password: {
      type: types.TEXT,
      allowNull: false,
      set(value) {
        const toStore = (typeof value === 'string' && value.startsWith('enc:')) ? value : encryptSecret(value);
        this.setDataValue('password', toStore);
      },
      get() {
        const raw = this.getDataValue('password');
        return decryptSecret(raw);
      }
    },
    options: {
      type: types.JSONB,
      allowNull: true
    },
    status: {
      type: types.ENUM,
      values: PHONE_REGISTRATION_STATUS_VALUES,
      defaultValue: 'active'
    },
    state: {
      type: types.ENUM,
      values: PHONE_REGISTRATION_STATE_VALUES,
      defaultValue: 'initial'
    },
    error: {
      type: types.TEXT,
      allowNull: true
    },
    lastSeenAt: {
      type: types.DATE,
      allowNull: true
    },
    callReceived: {
      type: types.DATE,
      allowNull: true
    },
    instanceId: {
      type: types.UUID,
      allowNull: true,
      references: {
        model: 'instances',
        key: 'id'
      }
    },
    // Registration trunk: the trunks row this registration owns, when it
    // carries calls for several numbers. Null for a single line.
    trunkId: {
      type: types.STRING,
      allowNull: true
    },
    // Where the regclient finds the dialled number on an inbound INVITE for a
    // trunk: 'request-uri' (default), 'to', 'header:<Name>', or 'none'.
    didSource: {
      type: types.STRING,
      allowNull: true
    },
    // ISO 3166-1 alpha-2, for normalising a national-format dialled number to
    // E.164. Null = the platform default.
    didCountry: {
      type: types.STRING(2),
      allowNull: true
    }
  }, {
    sequelize,
    timestamps: true,
    underscored: true,
    charset: 'utf8',
    collate: 'utf8_general_ci',
    modelName: 'PhoneRegistration',
    tableName: 'phone_registrations'
  });

  return PhoneRegistration;
}

export { PhoneRegistration };
export const PHONE_REGISTRATION_ENUMS = {
  state: PHONE_REGISTRATION_STATE_VALUES,
  status: PHONE_REGISTRATION_STATUS_VALUES
};
export { PHONE_REGISTRATION_SCHEMA_VERSION };
export { PHONE_REGISTRATION_STATE_VALUES, PHONE_REGISTRATION_STATUS_VALUES };


