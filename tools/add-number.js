#!/usr/bin/env node
const dir = require('path');
const axios = require('axios');
const commandLineArgs = require('command-line-args');
const optionDefinitions = [
  { name: 'path', alias: 'p', type: String },
  { name: 'number', type: String, defaultOption: true },
  { name: 'handler', alias: 'h', type: String, defaultValue: 'jambonz' },
  { name: 'reservation', alias: 'r', type: String },
  { name: 'noMap', alias: 'n', type: Boolean },
];
const options = commandLineArgs(optionDefinitions);
const configArgs = options.path && { path: dir.resolve(process.cwd(), options.path) };
const parsed = require('dotenv').config(configArgs);
const logger = require('../lib/logger');
const { PhoneNumber, databaseStarted, stopDatabase } = require('../lib/database');

logger.debug({ env: process.env, options, db: process.env.POSTGRES_DB, parsed }, 'Environment');

const { MAGRATHEA_USERNAME, MAGRATHEA_PASSWORD, JAMBONZ_SIP_ENDPOINT } = process.env;

if (!MAGRATHEA_USERNAME || !MAGRATHEA_PASSWORD || !JAMBONZ_SIP_ENDPOINT) {
  console.error('Please set MAGRATHEA_USERNAME, MAGRATHEA_PASSWORD, JAMBONZ_SIP_ENDPOINT');
  process.exit(1);
}

let api = axios.create({
  baseURL: 'https://restapi.magrathea.net:8443/v1/number/set',
  auth: {
    username: MAGRATHEA_USERNAME,
    password: MAGRATHEA_PASSWORD,
  },
});

if (!options.noMap) {
  let destinationIdentifier = `+44${options.number.replace(/^0/, '')}@${JAMBONZ_SIP_ENDPOINT}`;
  api.post(options.number, {
    destinationType: 'SIP_RFC2833',
    index: 1,
    destinationIdentifier
  })
    .then(resp => {
      logger.info(`Mapped ${options.number} to ${destinationIdentifier}`);
    })
    .catch(err => {
      logger.error({ err }, `Error mapping ${options.number} to ${destinationIdentifier}`);
    });
}

databaseStarted.then(() =>
  PhoneNumber.upsert({
    number: options.number.replace(/^0/, '44'),
    handler: options.handler,
    reservation: options.reservation,
  }))
  .then(phone => {
    logger.info(phone, `Created ${options.number}`);
  })
  .then(() => stopDatabase())
  .catch(err => {
    logger.error({ err }, `Error creating ${options.number}`);
  });


