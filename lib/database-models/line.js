import { Model, DataTypes, Op } from 'sequelize';

export const LINE_KINDS = ['extension', 'other'];
export const LINE_NUMBER_SEQUENCE = 'line_number_seq';
// Above any extension number, so the two are never confused.
export const LINE_NUMBER_START = 100000;

class Line extends Model {}

/**
 * One key on one phone. Written only by the reconciler (lib/pbx/reconcile.js),
 * never by a route. A line is known by (phone, extension), or by (phone,
 * 'other') for the overflow line. Its row, SIP account and line number stay the
 * same while that pair lasts, whatever its position.
 */
export function initLine(sequelize, types = DataTypes) {
  Line.init({
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
    position: { type: types.INTEGER, allowNull: false },
    kind: { type: types.STRING(16), allowNull: false, validate: { isIn: [LINE_KINDS] } },
    extensionId: {
      type: types.UUID,
      allowNull: true,
      references: { model: 'extensions', key: 'id' },
      onDelete: 'RESTRICT'
    },
    // Kind `other` only: the extensions it takes calls for, in priority order.
    covers: { type: types.ARRAY(types.UUID), allowNull: true },
    // The line's SIP account. Null for a phone that needs none.
    endpointId: {
      type: types.UUID,
      allowNull: true,
      references: { model: 'phone_registrations', key: 'id' },
      onDelete: 'RESTRICT'
    },
    // Unique across the platform and never reused. BIGINT reads back as a string.
    lineNumber: {
      type: types.BIGINT,
      allowNull: false,
      defaultValue: sequelize.literal(`nextval('${LINE_NUMBER_SEQUENCE}')`),
      get() {
        const raw = this.getDataValue('lineNumber');
        return raw == null || typeof raw === 'object' ? raw : Number(raw);
      }
    }
  }, {
    sequelize,
    timestamps: true,
    underscored: true,
    modelName: 'Line',
    tableName: 'lines',
    indexes: [
      { name: 'lines_phone_position', unique: true, fields: ['phone_id', 'position'] },
      {
        name: 'lines_phone_extension',
        unique: true,
        fields: ['phone_id', 'extension_id'],
        where: { extension_id: { [Op.ne]: null } }
      },
      { name: 'lines_phone_other', unique: true, fields: ['phone_id'], where: { kind: 'other' } },
      { name: 'lines_line_number', unique: true, fields: ['line_number'] },
      { name: 'lines_endpoint', unique: true, fields: ['endpoint_id'], where: { endpoint_id: { [Op.ne]: null } } },
      { name: 'lines_extension', fields: ['extension_id'] }
    ]
  });
  return Line;
}

export { Line };
