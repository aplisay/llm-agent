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


