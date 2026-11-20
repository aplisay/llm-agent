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
    // SHA-256 of the secret in the phone's settings address. Null: the address answers nothing.
    tokenHash: { type: types.STRING(64), allowNull: true },
    // Until its first use the address stops working at this time.
    tokenExpiresAt: { type: types.DATE, allowNull: true },
    tokenUsedAt: { type: types.DATE, allowNull: true },
    // The certificate that first fetched the settings. A different one for the same MAC is refused.
    certificateFingerprint: { type: types.STRING(64), allowNull: true },
    certificateSerial: { type: types.STRING(64), allowNull: true },
    certificateIssuer: { type: types.STRING(255), allowNull: true },
    // Set by an operator: fewer lines than the model takes.
    lineLimit: { type: types.INTEGER, allowNull: true, validate: { min: 1 } },
    srapsEndpointId: { type: types.STRING(64), allowNull: true },
    // Asking the phone to fetch its settings (lib/pbx/resync.js): the config version it was last asked
    // for, when, how many times for that version, and what call control answered.
    resyncVersion: { type: types.INTEGER, allowNull: true },
    resyncRequestedAt: { type: types.DATE, allowNull: true },
    resyncAttempts: { type: types.INTEGER, allowNull: true },
    resyncState: { type: types.STRING(24), allowNull: true },
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
      { name: 'devices_mac_held', unique: true, fields: ['vendor', 'mac'], where: { released_at: null } },
      // Every settings fetch looks a device up by its address.
      { name: 'devices_token', fields: ['vendor', 'token_hash'] }
    ]
  });
  return Device;
}

export { Device };
