import { Model, DataTypes } from 'sequelize';
import { createHash } from 'crypto';
import { encryptSecret, decryptSecret, PHONE_REGISTRATION_STATE_VALUES, PHONE_REGISTRATION_STATUS_VALUES, PHONE_REGISTRATION_MODE_VALUES, PHONE_REGISTRATION_KIND_VALUES, PHONE_REGISTRATION_SCHEMA_VERSION } from '../utils/credentials.js';

const md5 = (value) => createHash('md5').update(value, 'utf8').digest('hex');

/**
 * The digest HA1 pair of a registrar account (RFC 2617): MD5 of
 * `username:realm:password`, and the `ha1b` form for a client that presents
 * `username@realm` as its digest username. The realm is the row's own
 * `registrar` column, which is permanent, so the hashes are stable for the
 * life of the password.
 */
export function registrarHA1(username, realm, password) {
  return {
    ha1: md5(`${username}:${realm}:${password}`),
    ha1b: md5(`${username}@${realm}:${realm}:${password}`)
  };
}

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
    },
    // Direction of service. 'client', the default and every row before schema
    // 66: the b2bua registers out to `registrar` with these credentials.
    // 'registrar': the customer's PBX registers to us at `registrar` (the
    // deployment's balancer name) with credentials the platform minted; such a
    // row is served by regserver and never claimed by regclient. Design:
    // aplisay-strategy implementation/regserver-tactical-spec.md §2.
    mode: {
      type: types.STRING,
      allowNull: false,
      defaultValue: 'client'
    },
    // Registrar rows only: what registers to us. Only 'pbx' exists today;
    // 'device' is reserved for the cell and refused by validation.
    kind: {
      type: types.STRING,
      allowNull: true
    },
    // Registrar rows only: the bindings the owning node currently holds for
    // this account, mirrored for the dashboard and the API. The node's memory
    // is the routing truth; this array is written only by the node named in
    // b2bua_id, and cleared when that node shuts down or restarts.
    bindings: {
      type: types.JSONB,
      allowNull: true
    },
    bindingsUpdatedAt: {
      type: types.DATE,
      allowNull: true
    },
    // Registrar rows only: the digest HA1 pair for the sealed password, so
    // the Kamailio edge can verify credentials without the key that opens
    // `password`. Written by the beforeSave hook below whenever a registrar
    // row's password is set; null on client rows. Never returned by the API.
    ha1: {
      type: types.STRING(32),
      allowNull: true
    },
    ha1b: {
      type: types.STRING(32),
      allowNull: true
    }
  }, {
    sequelize,
    timestamps: true,
    underscored: true,
    charset: 'utf8',
    collate: 'utf8_general_ci',
    modelName: 'PhoneRegistration',
    tableName: 'phone_registrations',
    hooks: {
      // The HA1 pair follows the password: computed on mint and on rotate,
      // and on any save of a registrar row that has none yet (the backfill).
      // The getter yields the plaintext the setter sealed a moment ago; a
      // password that will not decrypt leaves the hashes untouched rather
      // than writing a hash of nothing, and the account is refused at the
      // edge until it is rotated.
      beforeSave(instance) {
        if (instance.mode !== 'registrar') return;
        if (!instance.changed('password') && instance.ha1) return;
        const password = instance.password;
        if (!password || !instance.username || !instance.registrar) return;
        const { ha1, ha1b } = registrarHA1(instance.username, instance.registrar, password);
        instance.ha1 = ha1;
        instance.ha1b = ha1b;
      }
    },
    indexes: [
      // One realm per deployment means an issued username has to be unique
      // across every organisation, not per (registrar, organisation) as the
      // create route checks for lines. Partial, so client-mode rows — whose
      // usernames are whatever their providers issued — are untouched.
      {
        name: 'phone_registrations_registrar_username',
        unique: true,
        fields: ['username'],
        where: { mode: 'registrar' }
      }
    ]
  });

  return PhoneRegistration;
}

export { PhoneRegistration };
export const PHONE_REGISTRATION_ENUMS = {
  state: PHONE_REGISTRATION_STATE_VALUES,
  status: PHONE_REGISTRATION_STATUS_VALUES
};
export { PHONE_REGISTRATION_SCHEMA_VERSION };
export { PHONE_REGISTRATION_STATE_VALUES, PHONE_REGISTRATION_STATUS_VALUES, PHONE_REGISTRATION_MODE_VALUES, PHONE_REGISTRATION_KIND_VALUES };


