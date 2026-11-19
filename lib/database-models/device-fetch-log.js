import { Model, DataTypes } from 'sequelize';

class DeviceFetchLog extends Model {}

/**
 * One row for each request a phone, or anything else, makes to the
 * provisioning service. Never holds the token of the address that was asked
 * for, only whether it named a device.
 */
export function initDeviceFetchLog(sequelize, types = DataTypes) {
  DeviceFetchLog.init({
    id: { type: types.UUID, primaryKey: true, defaultValue: types.UUIDV4 },
    // No foreign keys: the log outlives the rows it names.
    deviceId: { type: types.UUID, allowNull: true },
    organisationId: { type: types.STRING, allowNull: true },
    vendor: { type: types.STRING(16), allowNull: true },
    file: { type: types.STRING(64), allowNull: true },
    macInRequest: { type: types.STRING(12), allowNull: true },
    sourceIp: { type: types.STRING(64), allowNull: true },
    userAgent: { type: types.STRING(255), allowNull: true },
    // 'served', or the reason nothing was served.
    result: { type: types.STRING(40), allowNull: false },
    certificateMac: { type: types.STRING(12), allowNull: true },
    certificateFingerprint: { type: types.STRING(64), allowNull: true },
    statusCode: { type: types.INTEGER, allowNull: false },
    bytes: { type: types.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    sequelize,
    timestamps: true,
    updatedAt: false,
    underscored: true,
    modelName: 'DeviceFetchLog',
    tableName: 'device_fetch_logs',
    indexes: [
      { name: 'device_fetch_logs_device', fields: ['device_id', 'created_at'] },
      { name: 'device_fetch_logs_org', fields: ['organisation_id', 'created_at'] }
    ]
  });
  return DeviceFetchLog;
}

export { DeviceFetchLog };
