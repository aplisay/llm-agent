import { Device, Line, Phone, PhoneRegistration } from '../../../../../../lib/database.js';
import { REGISTRAR_PORT, REGISTRAR_TRANSPORT } from '../../../../../../lib/registrar-accounts.js';
import { linePasswordResetEnabled, resetLinePassword } from '../../../../../../lib/pbx/line-password.js';
import { directoryContext, attempt, sendNotFound } from '../../../../../../lib/pbx/route-helpers.js';
import { PHONES_TAG, organisationIdQuery, pathId, errorResponses } from '../../../../../../lib/pbx/api-docs.js';

export default function (logger) {
  const reset = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'phone', 'provision', { gate: true });
    if (!ctx) return;
    if (!linePasswordResetEnabled()) {
      return res.status(403).send({
        error: 'Resetting a line password is switched off on this deployment (PBX_LINE_PASSWORD_RESET)',
        code: 'line_password_reset_disabled',
      });
    }
    const organisationId = ctx.organisation.id;
    const result = await Phone.sequelize.transaction(async (transaction) => {
      const phone = await Phone.findOne({
        where: { id: req.params.phoneId, organisationId, removedAt: null }, attributes: ['id', 'deviceId'], transaction,
      });
      const line = phone && await Line.findOne({ where: { id: req.params.lineId, phoneId: phone.id, organisationId }, transaction });
      const account = line?.endpointId
        ? await PhoneRegistration.findByPk(line.endpointId, { transaction, lock: transaction.LOCK.UPDATE })
        : null;
      if (!account || account.organisationId !== organisationId || account.kind !== 'device') return null;
      const password = await resetLinePassword(account, { transaction });
      // The phone's settings file carries the hash, so a provisioned phone must fetch again.
      if (phone.deviceId) await Device.increment('configVersion', { where: { id: phone.deviceId }, transaction });
      return { phone, line, account, password };
    });
    if (!result) return sendNotFound(res, 'Line not found');
    const { phone, line, account, password } = result;
    // An audit line for every reset. Never the values.
    (req.log || logger).info({
      audit: 'phone-line-password-reset',
      lineId: line.id,
      phoneId: phone.id,
      organisationId,
      userId: res.locals.user?.id,
    }, 'phone line password reset');
    res.set('Cache-Control', 'no-store').send({
      lineId: line.id,
      lineNumber: line.lineNumber,
      registrar: account.registrar,
      port: REGISTRAR_PORT,
      transport: REGISTRAR_TRANSPORT,
      username: account.username,
      password,
    });
  });
  reset.apiDoc = {
    summary: 'Give one line a new SIP password and show it once, to set a phone up by hand.',
    description: 'Needs `phone:provision`, and the deployment setting `PBX_LINE_PASSWORD_RESET`, which is off unless set '
      + '(403 `line_password_reset_disabled`). The platform keeps only a hash of a line\'s password, so this answer is the '
      + 'only time the password can be read. The old password stops working for SIP at once. Each reset is written to the '
      + 'audit log.',
    operationId: 'resetPhoneLinePassword',
    tags: [PHONES_TAG],
    parameters: [pathId('phoneId', 'The id of the phone.'), pathId('lineId', 'The id of the line.'), organisationIdQuery],
    responses: {
      200: {
        description: 'The account, with its new password',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                lineId: { type: 'string' },
                lineNumber: { type: 'integer' },
                registrar: { type: 'string' },
                port: { type: 'integer' },
                transport: { type: 'string' },
                username: { type: 'string' },
                password: { type: 'string' },
              },
            },
          },
        },
      },
      ...errorResponses,
    },
  };
  return { POST: reset };
}
