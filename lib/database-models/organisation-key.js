import { Model, DataTypes } from 'sequelize';
import { encryptSecretStrict, decryptSecret } from '../utils/credentials.js';

class OrganisationKey extends Model {}

export function initOrganisationKey(sequelize, types = DataTypes) {
  OrganisationKey.init({
    id: {
      type: types.UUID,
      primaryKey: true,
      defaultValue: types.UUIDV4
    },
    organisationId: {
      type: types.STRING,
      allowNull: false,
      references: {
        model: 'organisations',
        key: 'id'
      }
    },
    // Canonical provider slug (lib/utils/provider-keys.js); unique per
    // organisation via the composite index below.
    provider: {
      type: types.STRING,
      allowNull: false
    },
    value: {
      type: types.TEXT,
      allowNull: false,
      set(value) {
        // Strict (fail-closed): unlike SIP passwords, a BYOK write throws when
        // CREDENTIALS_KEY is unavailable rather than storing plaintext. No
        // 'enc:' idempotency guard here: values only ever enter as user
        // plaintext, and skipping encryption for an 'enc:'-prefixed submission
        // would store it raw yet unreadable.
        this.setDataValue('value', encryptSecretStrict(value));
      },
      get() {
        const raw = this.getDataValue('value');
        return decryptSecret(raw);
      }
    },
    // Last 4 chars of the plaintext, stored separately at write time so
    // listings never touch (or decrypt) `value`.
    hint: {
      type: types.STRING(8),
      allowNull: true
    }
  }, {
    sequelize,
    timestamps: true,
    underscored: true,
    charset: 'utf8',
    collate: 'utf8_general_ci',
    modelName: 'OrganisationKey',
    tableName: 'organisation_keys',
    indexes: [
      { unique: true, fields: ['organisation_id', 'provider'] }
    ]
  });

  return OrganisationKey;
}

export { OrganisationKey };
