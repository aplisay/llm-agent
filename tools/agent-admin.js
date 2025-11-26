#!/usr/bin/env node
import dotenv from 'dotenv';
import dir from 'path';
import axios from 'axios';
import commandLineArgs from 'command-line-args';
import logger from '../lib/logger.js';
import { v4 as uuidv4 } from 'uuid';
const optionDefinitions = [
  { name: 'path', alias: 'p', type: String },
  { name: 'command', defaultOption: true },
  { name: 'start', type: String },
  { name: 'end', type: String },
  { name: 'email', alias: 'e', type: String },
  { name: 'detail', alias: 'd', type: Boolean },
  { name: 'orgName', alias: 'o', type: String },
  { name: 'orgId', alias: 'i', type: String },
  { name: 'userName', alias: 'u', type: String },
  { name: 'userId', alias: 'w', type: String },
  { name: 'key', alias: 'k', type: String },
  { name: 'joinOnly', alias: 'j', type: Boolean }
];
const options = commandLineArgs(optionDefinitions);
const configArgs = options.path && { path: dir.resolve(process.cwd(), options.path) };
logger.debug(configArgs, 'Using configArgs');
dotenv.config(configArgs);

let command = options.command && options.command.toLowerCase();
let started;

if (!command) {
  console.log(`Usage: ${process.argv[1]} --command <command> [options]`);
  console.log(`Commands: add-org, usage, add-user, add-authkey, list-authkeys, delete-authkey, upgrade-db, normalise-orgs`);
  console.log(`Options: --path <path> -p <path> - specify the path to the.env file`);
  console.log(`Options: --email <email> -e <email> - specify the email address`);
  console.log(`Options: --orgName <orgName> -o <orgName> - specify the organisation name`);
  console.log(`Options: --orgId <orgId> -i <orgId> - specify the organisation id`);
  console.log(`Options: --userName <userName> -u <userName> - specify the user name`);
  console.log(`Options: --userId <userId> -w <userId> - specify the user id`);
  console.log(`Options: --key <key> -k <key> - specify the auth key`);
  console.log(`Options: --joinOnly -j - specify the auth key`);

  exit(1);
}
else if (command === 'upgrade-db') {
  process.env.DB_FORCE_SYNC = 'true';
}


async function main() {

  const { Agent, User, Organisation, AuthKey, stopDatabase, databaseStarted, Op, Call, Sequelize } = (await import('../lib/database.js'));
  await databaseStarted;
  started = stopDatabase;
  try {

    let user, organisation;

    switch (command) {
      case 'add-org':
        if (!options.orgName) {
          throw new Error('Please specify an organisation name');
          exit(1);
        }
        organisation = await Organisation.findOrCreate({
          where: { name: options.orgName },
          defaults: {
            name: options.orgName,
            id: uuidv4()
          }
        });
        logger.info({ organisation }, 'created Organisation');
        break;
      case 'add-user':
        if (!options.email) {
          throw new Error('Please specify an email address');
          exit(1);
        }
        user = await User.findOrCreate({
          where: { email: options.email },
          defaults: {
            email: options.email,
            name: options.email,
            role: { admin: true },
          }
        });
        logger.info({ user }, 'created User');
        break;
      case 'add-authkey':
        let token;
        (await import('crypto')).randomBytes(48, function (err, buffer) {
          token = buffer.toString('base64');
        });
        let where = {};
        options.userId && (where.userId = options.userId);
        options.email && (where.email = { [Op.iLike]: options.email });

        if (!(user = await User.findOne({ where }))) {
          throw new Error(`Can't find user: ${options.userId || options.email}`);
        }
        else {
          let authKey = await AuthKey.create({
            key: options.key || token,
            userId: user.id,
            roleRestriction: options.joinOnly && { join: true },
            expiry: Date.now() + 1000 * 60 * 60 * 24 * 365 * 10,
          });
          logger.info({ authKey }, 'created AuthKey');
        }
        break;

      case 'list-users':
        let users = await User.findAll();
        users.forEach(user => logger.info({ user }, `${user.name}`));
        break;

      case 'list-authkeys':
        let spec = {
          include: {
            model: User
          }
        };
        options.userId && (spec.include.where = { ...(spec.include.where || {}), id: options.userId });
        options.email && (spec.include.where = { ...(spec.include.where || {}), email: { [Op.iLike]: options.email } });
        let authKeys = await AuthKey.findAll(spec);
        authKeys.forEach(({ key, User: user }) => console.log(`${user && user.name} ${user.email}, key: "${key}"`));
        break;

      case 'delete-user':
        where = {
          userId: options.userId,
          email: options.email && { [Op.like]: options.email }
        };
        if (Object.keys(where).length !== 1) {
          throw new Error(`${command} Must have either an email or userId`);
          exit(1);
        }
        if (!(user = await User.findOne({ where: { email: { [Op.like]: options.email } } }))) {
          throw new Error(`Can't find user: ${options.userId || options.email}`);
        }
        await user.destroy();
        logger.info({ user }, 'deleted User');
        break;

      case 'delete-org':
        if (!options.orgName) {
          throw new Error('Please specify an organisation name');
          exit(1);
        }
        organisation = await Organisation.findOne({ where: { name: options.orgName } });
        if (!organisation) {
          throw new Error('Organisation not found');
          exit(1);
        }
        await organisation.destroy();
        logger.info({ organisation }, 'deleted Organisation');
        break;

      case 'delete-authkey':
        if (!options.key) {
          throw new Error('Please specify a key');
          exit(1);
        }
        let authKey = await AuthKey.findOne({ where: { key: options.key } });
        if (!authKey) {
          throw new Error('AuthKey not found');
          exit(1);
        }
        await authKey.destroy();
        logger.info({ authKey }, 'deleted AuthKey');
        break;
      case 'upgrade-db':
        break;

      case 'normalise-orgs':
        console.log('Starting organisation normalisation...');
        try {
          // Find all calls with null organisationId and include the associated user
          const callsToUpdate = await Call.findAll({
            where: {
              organisationId: null
            },
            include: {
              model: User
            }
          });

          console.log(`Found ${callsToUpdate.length} calls with null organisationId`);

          let updatedCount = 0;
          let skippedCount = 0;

          for (const call of callsToUpdate) {
            if (call.User && call.User.organisationId) {
              // Update the call with the organisationId from the user
              await call.update({
                organisationId: call.User.organisationId
              });
              updatedCount++;
              console.log(`Updated call ${call.id} with organisationId ${call.User.organisationId} from user ${call.User.email}`);
            } else {
              skippedCount++;
              console.log(`Skipped call ${call.id} - user has no organisationId`);
            }
          }

          console.log(`Normalisation complete: ${updatedCount} calls updated, ${skippedCount} calls skipped`);
        } catch (err) {
          logger.error(err, 'Error during organisation normalisation');
          exit(1);
        }
        break;

      case 'usage':
        // Set default dates to last month if not provided
        if (!options.start || !options.end) {
          const now = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
          let lastMonth, lastMonthEnd;

          if (now.getMonth() === 0) {
            // January - last month is December of previous year
            lastMonth = new Date(Date.UTC(now.getUTCFullYear() - 1, 11, 0, 0, 0, 0));
            lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear() - 1, 11, 31, 23, 59, 59));
          } else {
            // All other months
            lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0));
            lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59));
          }

          options.start = options.start || lastMonth.toISOString();
          options.end = options.end || lastMonthEnd.toISOString();
        }

        // Validate that only one of orgId, userId, or email is provided
        const providedFilters = [options.orgId, options.orgName, options.userId, options.email].filter(Boolean);
        if (providedFilters.length > 1) {
          throw new Error('Only one of --orgId, --orgName, --userId, or --email can be specified');
        }
        if (providedFilters.length === 0) {
          throw new Error('Must specify one of --orgId, --orgName, --userId, or --email');
        }

        let usageSpec = {

          where: {
            startedAt: {
              [Op.gte]: new Date(options.start),
              [Op.lte]: new Date(options.end)
            }
          },
          order: [['startedAt', 'ASC']],
          include: [
            {
              model: User,
              required: true,
            },
            {
              model: Organisation,
              required: true
            },
            {
              model: Agent,
              required: false
            }
          ]
        };

        // Add the appropriate filter based on which option was provided
        if (options.orgId) {
          usageSpec.where = { ...(usageSpec.where || {}), organisationId: options.orgId };
        }
        else if (options.orgName) {
          usageSpec.where = {
            ...(usageSpec.where || {}),
            "$Organisation.name$": { [Op.iLike]: `%${options.orgName}%` }
          };
        }
        else if (options.userId) {
          usageSpec.include.where = { ...(usageSpec.include.where || {}), id: options.userId };
        } else if (options.email) {
          usageSpec.include.where = { ...(usageSpec.include.where || {}), email: { [Op.iLike]: options.email } };
        }
        else {
          throw new Error('Must specify one of --orgId, --userId, or --email');
          exit(1);
        }
        logger.debug({ usageSpec }, 'starting query');
        try {

          let data = await Call.findAll(usageSpec);
          console.log({ length: data.length }, 'query done');
          let corrected = 0;
          let cdrs = data
            .map(c => {
              if (!c.duration) {
                c.duration || c.endedAt - c.startedAt;
              }
              return c;
            })
            .filter(record => !!record.duration)
            .map(c => {
              c.duration_s = Math.round(c.duration / 1000);
              c.billingDuration = Math.max(1, Math.ceil(c.duration / 1000 / 10) / 6);
              c.maxDuration = c.Agent?.options?.maxDuration || '305s';
              c.maxDuration = Math.max(1, Math.ceil(parseInt(c.maxDuration.replace(/s$/, '')) / 10) / 6);

              if (c.maxDuration + 0.5 < c.billingDuration && c.modelName !== 'telephony:bridged-call') {
                console.log('correcting call', c.id, 'where billingDuration', c.billingDuration, '> maxDuration', c.maxDuration);
                c.billingDuration = c.maxDuration;
                corrected++;
              }
              c.type = c.modelName?.replace(/.*\/([a-zA-Z0-9-_]+).*/, '$1').toLowerCase() || 'ultravox-70b';
              c.telephony = c.callerId.match(/^\+*[1-9]\d{1,14}$/) || c.calledId.match(/^\+*[1-9]\d{1,14}$/);
              return c;
            });
          
          const recordEntry = ({ acc, type, month, userEmail, duration }) => {
            acc[type] = acc[type] || {
              duration: 0,
              count: 0,
              month: {}
            };
            acc[type].month[month] = acc[type].month[month] || {
              duration: 0,
              count: 0,
              users: {}
            };
            acc[type].month[month].duration += duration;
            acc[type].month[month].count++;
            acc[type].duration += duration;
            acc[type].count++;
            acc[type].month[month].users[userEmail] = acc[type].month[month].users[userEmail] || {
              duration: 0,
              count: 0
            };
            acc[type].month[month].users[userEmail].duration += duration;
            acc[type].month[month].users[userEmail].count++;
          }
          const summary = cdrs.reduce((acc, c) => {
            let userEmail = c?.User?.email || 'unknown';
            let month = c.startedAt.toLocaleString('default', { month: 'long' });
            recordEntry({ acc, type: c.type, month, userEmail, duration: c.billingDuration });
            c.telephony && recordEntry({ acc, type: 'telephony', month, userEmail, duration: c.billingDuration });
            acc.totalCount++;
            acc.totalDuration += c.billingDuration;

            return acc;
          }, { telephony: { duration: 0, count: 0, month: {} }, totalDuration: 0, totalCount: 0 });

          Object.entries(summary).forEach(([type, typeData]) => {
            if (typeof typeData === 'object') {
              typeData.duration && (typeData.duration = Math.round(typeData.duration));
              Object.entries(typeData.month).forEach(([month, monthData]) => {
                if (typeof monthData === 'object') {
                  monthData.duration && (monthData.duration = Math.round(monthData.duration));
                  Object.entries(monthData.users).forEach(([userEmail, userData]) => {
                    if (typeof userData === 'object') {
                      userData.duration && (userData.duration = Math.round(userData.duration));
                    }
                  });
                };
              });
            }
          })
          summary.totalDuration = Math.round(summary.totalDuration);

          console.log({ summary, keys: Object.entries(summary) }, 'SUMMARY summary');



          const detail = cdrs.map(c => ([
            c.id,
            c.callerId,
            c.calledId,
            c?.User?.email,
            c?.Organisation?.name,
            c.startedAt.toISOString(),
            c.endedAt.toISOString(),
            c.duration_s,
            c.billingDuration,
            c.type
          ]));
          detail.unshift(['id', 'callerId', 'calledId', 'userEmail', 'userOrg', 'startedAt', 'endedAt', 'duration s', 'billing duration m']);
          const summaryOutput =
            Object.entries(summary).map(([type, typeData]) => {
              return typeof typeData === 'object' ? `  ${type}\n${typeData.month && Object.entries(typeData.month).map(([month, monthData]) => {
                return `    ${month}\n${monthData.users && Object.entries(monthData.users).map(([userEmail, userData]) => {
                  return `      ${userEmail}, ${userData.duration} mins, ${userData.count} calls`;
                }).join('\n') || ''}\n    Duration: ${monthData.duration} mins, Count: ${monthData.count} calls`;
              }).join('\n') || ''}\n  Duration(whole date range): ${typeData.duration} mins, Count: ${typeData.count} calls`: ''
            }).join('\n') + `\n  Total Duration: ${summary.totalDuration} mins, Total Count: ${summary.totalCount} calls`;
          console.log(`All calls for ${options.email || options.userId || options.orgId || options.orgName} from ${options.start} to ${options.end}`);
          if (options.detail) {
            console.log('--------------------------------');
            detail.forEach(c => console.log(c.join(', ')));
            console.log('--------------------------------');
          }
          console.log('Summary:');
          console.log(summaryOutput);
          console.log('--------------------------------');
          console.log(`dropped ${data.length - cdrs.length} calls with no duration`);
          console.log(`corrected ${corrected} calls where billingDuration > requested maxDuration`);
          exit(0);
        } catch (err) {
          logger.error(err, 'query error');
          exit(1);
        }
        break;

      default:
        throw new Error(`unrecognised command: ${command}`);
    }

  }
  catch (e) {
    logger.error(e, 'error');
    exit(1);
  }
  finally {
    exit(0);
  }
}



main().catch(e => {
  logger.error(e, 'error');
  exit(1);
});

function exit(code) {
  process.exitCode = code;
  started && started()
    .then(() => {
      logger.debug('database stopped');
    });
}


