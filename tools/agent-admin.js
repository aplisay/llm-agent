#!/usr/bin/env node
const dir = require('path');
const axios = require('axios');
const commandLineArgs = require('command-line-args');
const logger = require('../lib/logger');
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
require('dotenv').config(configArgs);

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



const { User, Organisation, AuthKey, stopDatabase, databaseStarted, Op, Call } = require('../lib/database');
started = databaseStarted;

databaseStarted.then(async () => {
  try {

    let organisation, user, authKey, where;

    switch (command) {
      case 'add-org':
        if (!options.orgName) {
          throw new Error('Please specify an organisation name');
          exit(1);
        }
        organisation = await Organisation.findOrCreate({
          where: { name: options.orgName },
          defaults: {
            name: EncodingOptionsPreset.orgName
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
        require('crypto').randomBytes(48, function (err, buffer) {
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
        let organisation = await Organisation.findOne({ where: { name: options.orgName } });
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
          const now = new Date();
          let lastMonth, lastMonthEnd;

          if (now.getMonth() === 0) {
            // January - last month is December of previous year
            lastMonth = new Date(now.getFullYear() - 1, 11, 1);
            lastMonthEnd = new Date(now.getFullYear() - 1, 11, 31);
          } else {
            // All other months
            lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
          }

          options.start = options.start || lastMonth.toISOString().split('T')[0];
          options.end = options.end || lastMonthEnd.toISOString().split('T')[0];
        }

        // Validate that only one of orgId, userId, or email is provided
        const providedFilters = [options.orgId, options.userId, options.email].filter(Boolean);
        if (providedFilters.length > 1) {
          throw new Error('Only one of --orgId, --userId, or --email can be specified');
        }
        if (providedFilters.length === 0) {
          throw new Error('Must specify one of --orgId, --userId, or --email');
        }

        let usageSpec = {
          where: {
            startedAt: {
              [Op.gte]: new Date(options.start),
              [Op.lte]: new Date(options.end)
            }
          },
          order: [['startedAt', 'ASC']],
          include: {
            model: User,
            include: {
              model: Organisation
            }
          }
        };

        // Add the appropriate filter based on which option was provided
        if (options.orgId) {
          usageSpec.include.where = { ...(usageSpec.include.where || {}), organisationId: options.orgId };
        } else if (options.userId) {
          usageSpec.include.where = { ...(usageSpec.include.where || {}), id: options.userId };
        } else if (options.email) {
          usageSpec.include.where = { ...(usageSpec.include.where || {}), email: { [Op.iLike]: options.email } };
        }
        else {
          throw new Error('Must specify one of --orgId, --userId, or --email');
          exit(1);
        }
        console.log({ usageSpec }, 'starting query');
        try {

          let data = await Call.findAll(usageSpec);
          console.log({ length: data.length }, 'query done');
          cdrs = data
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
            return c;
          });
          
          const summary = cdrs.reduce((acc, c) => {
            let userEmail = c?.User?.email || 'unknown';
            let month = c.startedAt.toLocaleString('default', { month: 'long' });
            acc.month[month] = acc.month[month] || {
              duration: 0,
              count: 0,
              users: {}
            };
            acc.month[month].duration += c.billingDuration;
            acc.month[month].count++;
            acc.totalDuration += c.billingDuration;
            acc.totalCount++;

            acc.month[month].users[userEmail] = acc.month[month].users[userEmail] || {
              duration: 0,
              count: 0
            };
            acc.month[month].users[userEmail].duration += c.billingDuration;
            acc.month[month].users[userEmail].count++;
            return acc;
          }, { totalDuration: 0, totalCount: 0, month: {} });
          summary.totalDuration = Math.round(summary.totalDuration);

          Object.entries(summary.month).forEach(([key, data]) => {
            if (typeof data === 'object') {
              data.duration = Math.round(data.duration);
              Object.values(data.users).forEach((userData) => {
                userData.duration && (userData.duration = Math.round(userData.duration));
              });
            }
          });

          const detail = cdrs.map(c => ([
            c.callerId,
            c.calledId,
            c?.User?.email,
            c?.User?.Organisation?.name,
            c.startedAt.toISOString(),
            c.endedAt.toISOString(),
            c.duration_s,
            c.billingDuration
          ]));
          detail.unshift(['callerId', 'calledId', 'userEmail', 'userOrg', 'startedAt', 'endedAt', 'duration s', 'billing duration m']);
          const summaryOutput = Object.entries(summary.month).map(([month, data]) => {
            return `  ${month}\n${data.users && Object.entries(data.users).map(([userEmail, userData]) => {
              return `    ${userEmail}, ${userData.duration} mins, ${userData.count} calls`;
            }).join('\n') || ''}\n  Duration: ${data.duration} mins, Count: ${data.count} calls`;
          }).join('\n') + `\nTotal Duration: ${summary.totalDuration} mins, Total Count: ${summary.totalCount} calls`;
          console.log(`All calls for ${options.email || options.userId || options.orgId} from ${options.start} to ${options.end}`);
          if (options.detail) {
          console.log('--------------------------------');
          detail.forEach(c => console.log(c.join(', ')));
            console.log('--------------------------------');
          }
          console.log('Summary:');
          console.log(summaryOutput);
          console.log('--------------------------------');
          console.log(`dropped ${data.length - cdrs.length} calls with no duration`);
          exit(0);
        } catch (err) {
          logger.error(err, 'query error');
          exit(1);
        }
        break;

      default:
        throw new Error(`unrecognised command: ${command}`);
    }

  } catch (err) {
    logger.error(err);
    exit(1);
  }
  exit(0);



});

function exit(code) {
  process.exitCode = code;
  started && stopDatabase()
    .then(() => {
      logger.debug('database stopped');
    });
}


