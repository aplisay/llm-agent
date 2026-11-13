import { Model, DataTypes } from 'sequelize';

export const DEVICE_PROVISIONING_STATES = ['waiting', 'fetched', 'updating', 'wiping', 'wiped'];
export const DEVICE_FAILURES = ['other_provider', 'wrong_device', 'line_not_registered', 'model_not_supported'];

class Device extends Model {}

/**
 * The thing that is provisioned, known by vendor and MAC. One to one with a
 * desk phone today. Kept apart from `phones` so one base can later serve many
 * handsets.
 */
export function initDevice(sequelize, types = DataTypes) {
  Device.init({
    id: { type: types.UUID, primaryKey: true, defaultValue: types.UUIDV4 },
    organisationId: {
      type: types.STRING,
      allowNull: false,
      references: { model: 'organisations', key: 'id' },
      onDelete: 'CASCADE'
    },
    vendor: { type: types.STRING(16), allowNull: false, defaultValue: 'snom' },
    // Lower-case hex, no separators.
    mac: { type: types.STRING(12), allowNull: false, validate: { is: /^[0-9a-f]{12}$/ } },
    model: { type: types.STRING(32), allowNull: false },
    // What the phone says it is. It wins over `model` when they differ.
    reportedModel: { type: types.STRING(32), allowNull: true },
    provisioningState: {
      type: types.STRING(24),
      allowNull: false,
      defaultValue: 'waiting',
      validate: { isIn: [DEVICE_PROVISIONING_STATES] }
    },
    failure: { type: types.STRING(32), allowNull: true, validate: { isIn: [DEVICE_FAILURES] } },
    tokenHash: { type: types.STRING(64), allowNull: true },
    srapsEndpointId: { type: types.STRING(64), allowNull: true },
    configVersion: { type: types.INTEGER, allowNull: false, defaultValue: 1 },
    fetchedVersion: { type: types.INTEGER, allowNull: true },
    lastFetchAt: { type: types.DATE, allowNull: true },
    certificateCheckedAt: { type: types.DATE, allowNull: true },
    firmware: { type: types.STRING(32), allowNull: true },
    removedAt: { type: types.DATE, allowNull: true },
    // Set by an operator. Frees the MAC for other organisations.
    releasedAt: { type: types.DATE, allowNull: true }
  }, {
    sequelize,
    timestamps: true,
    underscored: true,
    modelName: 'Device',
    tableName: 'devices',
    indexes: [
      // One index, two rules: the same organisation revives a removed row, and
      // another organisation cannot take the MAC until it is released.
      { name: 'devices_mac_held', unique: true, fields: ['vendor', 'mac'], where: { released_at: null } }
    ]
  });
  return Device;
}

export { Device };
