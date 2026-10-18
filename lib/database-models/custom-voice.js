import { Model, DataTypes } from 'sequelize';

/**
 * A voice an organisation created at a TTS or voice-model vendor (docs/custom-voices.md).
 *
 * The row belongs to one organisation: only that organisation lists it, puts it on
 * an agent, or has the worker speak with it. The vendor's own identifier is
 * `vendorVoiceId`, and that is the value an agent puts in `options.tts.voice`.
 *
 * Rows are never destroyed. A delete removes the voice at the vendor when the
 * vendor can, then sets `status` to 'deleted' and `deletedAt`. A vendor with no
 * delete call still holds the voice, so the quota keeps counting its deleted rows.
 */
class CustomVoice extends Model {}

/** Statuses: 'creating' while the vendor call runs (in the background), then 'ready' or 'failed'; 'deleted' after a delete. */
export const CUSTOM_VOICE_STATUSES = ['creating', 'ready', 'failed', 'deleted'];

/** How the voice was made. Only 'prompt' is implemented; 'recording' is the clip-clone path. */
export const CUSTOM_VOICE_METHODS = ['prompt', 'recording'];

/**
 * Why a create failed: 'rejected' (the vendor refused the input; change it),
 * 'vendor_unavailable' and 'vendor_error' (try again), 'interrupted' (the server
 * stopped before the vendor answered and the vendor has no such voice).
 */
export const CUSTOM_VOICE_ERROR_CODES = ['rejected', 'vendor_unavailable', 'vendor_error', 'interrupted'];

export function initCustomVoice(sequelize, types = DataTypes) {
  CustomVoice.init({
    id: {
      type: types.UUID,
      defaultValue: types.UUIDV4,
      primaryKey: true,
    },
    // No foreign key: organisations are never destroyed, and the row must
    // outlive anything that would cascade, because the vendor still holds the voice.
    organisationId: {
      type: types.STRING,
      allowNull: false,
    },
    createdBy: {
      type: types.STRING,
      allowNull: true,
    },
    vendor: {
      type: types.STRING,
      allowNull: false,
    },
    method: {
      type: types.STRING,
      allowNull: false,
      validate: { isIn: [CUSTOM_VOICE_METHODS] },
    },
    // Null until the vendor call returns.
    vendorVoiceId: {
      type: types.STRING,
      allowNull: true,
    },
    name: {
      type: types.STRING,
      allowNull: false,
    },
    // The text prompt for a prompt voice. GPT-Live needs it again in the
    // session instructions at call time.
    prompt: {
      type: types.TEXT,
      allowNull: true,
    },
    locale: {
      type: types.STRING,
      allowNull: false,
    },
    gender: {
      type: types.STRING,
      allowNull: true,
    },
    status: {
      type: types.STRING,
      allowNull: false,
      defaultValue: 'creating',
      validate: { isIn: [CUSTOM_VOICE_STATUSES] },
    },
    error: {
      type: types.TEXT,
      allowNull: true,
    },
    errorCode: {
      type: types.STRING,
      allowNull: true,
      validate: { isIn: [CUSTOM_VOICE_ERROR_CODES] },
    },
    // What the vendor returned, verbatim, for audit.
    vendorData: {
      type: types.JSONB,
      allowNull: true,
    },
    deletedAt: {
      type: types.DATE,
      allowNull: true,
    },
  }, {
    sequelize,
    timestamps: true,
    underscored: true,
    modelName: 'CustomVoice',
    tableName: 'custom_voices',
    indexes: [
      { name: 'custom_voices_organisation_status', fields: ['organisation_id', 'status'] },
      { name: 'custom_voices_vendor_method', fields: ['vendor', 'method'] },
      // Postgres lets many NULLs into a unique index, so 'creating' rows do not clash.
      { name: 'custom_voices_vendor_voice_id', unique: true, fields: ['vendor', 'vendor_voice_id'] },
    ],
  });
  return CustomVoice;
}

export default CustomVoice;
