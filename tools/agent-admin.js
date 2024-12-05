#!/usr/bin/env node
const dir = require('path');
const axios = require('axios');
const commandLineArgs = require('command-line-args');
const logger = require('../lib/logger');
const optionDefinitions = [
  { name: 'path', alias: 'p', type: String },
  { name: 'command', defaultOption: true },
  { name: 'email', alias: 'e', type: String },
  { name: 'orgName', alias: 'o', type: String },
  { name: 'orgId', alias: 'i', type: String },
  { name: 'userName', alias: 'u', type: String },
  { name: 'userId', alias: 'w', type: String },
  { name: 'key', alias: 'k', type: String },
  { name: 'joinOnly', alias: 'j', type: Boolean },
];
const options = commandLineArgs(optionDefinitions);
const configArgs = options.path && { path: dir.resolve(process.cwd(), options.path) };
logger.debug(configArgs, 'Using configArgs');
require('dotenv').config(configArgs);

let command = options.command && options.command.toLowerCase();
let started;

if (!command) {
  console.log(`Usage: ${process.argv[1]} --command <command> [options]`);
  console.log(`Commands: add-org, add-user, add-authkey, list-authkeys, delete-authkey upgrade-db`);
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



const { User, Organisation, AuthKey, stopDatabase, databaseStarted, Op } = require('../lib/database');
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
        let authKeys = await AuthKey.findAll({ include: [User] });
        authKeys.forEach(({ key, User: user }) => logger.info({ key, user }, `${user && user.name}`));
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

      default:
        throw new Error(`unrecognised command: ${command}`);


    }

    exit(0);
  }
  catch (err) {
    logger.error(err);
    exit(1);
  }


});

function exit(code) {
  process.exitCode = code;
  started && stopDatabase()
    .then(() => {
      logger.debug('database stopped');
    });
}


