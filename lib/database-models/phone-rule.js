import { Model, DataTypes } from 'sequelize';

export const PHONE_RULE_APPLIES_TO = ['all', 'owned', 'shared', 'extensions'];

class PhoneRule extends Model {}

/** A do-not-ring rule on one phone. The only per-phone, per-line setting. */
export function initPhoneRule(sequelize, types = DataTypes) {
  PhoneRule.init({
    id: { type: types.UUID, primaryKey: true, defaultValue: types.UUIDV4 },
    organisationId: {
      type: types.STRING,
      allowNull: false,
      references: { model: 'organisations', key: 'id' },
      onDelete: 'CASCADE'
    },
    phoneId: {
      type: types.UUID,
      allowNull: false,
      references: { model: 'phones', key: 'id' },
      onDelete: 'CASCADE'
    },
    appliesTo: { type: types.STRING(16), allowNull: false, validate: { isIn: [PHONE_RULE_APPLIES_TO] } },
    extensionIds: { type: types.ARRAY(types.UUID), allowNull: true },
    // `{ always: true }`, or `{ timezone, windows: [{ days, from, to }] }`.
    // A window whose `to` is before its `from` runs past midnight.
    schedule: { type: types.JSONB, allowNull: false, defaultValue: { always: true } },
    action: {
      type: types.STRING(16),
      allowNull: false,
      defaultValue: 'do_not_ring',
      validate: { isIn: [['do_not_ring']] }
    },
    enabled: { type: types.BOOLEAN, allowNull: false, defaultValue: true }
  }, {
    sequelize,
    timestamps: true,
    underscored: true,
    modelName: 'PhoneRule',
    tableName: 'phone_rules',
    indexes: [{ name: 'phone_rules_phone', fields: ['phone_id'] }]
  });
  return PhoneRule;
}

export { PhoneRule };
