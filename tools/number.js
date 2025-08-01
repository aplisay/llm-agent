#!/usr/bin/env node
const dir = require('path');
const axios = require('axios');
const commandLineArgs = require('command-line-args');
const optionDefinitions = [
  { name: 'path', alias: 'p', type: String },
  { name: 'add', alias: 'a', type: Boolean, defaultValue: false },
  { name: 'delete', alias: 'd', type: Boolean, defaultValue: false },
  { name: 'number', type: String, defaultOption: true },
  { name: 'handler', alias: 'h', type: String, defaultValue: 'jambonz' },
  { name: 'reservation', alias: 'r', type: Boolean },
  { name: 'organisation', alias: 'o', type: String },
  { name: 'noMap', alias: 'n', type: Boolean },
];
const options = commandLineArgs(optionDefinitions);
if (options.add && options.delete) {
  console.error('Cannot use add and delete together');
  process.exit(1);
}
if (!options.add && !options.delete) {
  options.add = true;
}
const configArgs = options.path && { path: dir.resolve(process.cwd(), options.path) };
const parsed = require('dotenv').config(configArgs);
const logger = require('../lib/logger');
const { PhoneNumber, databaseStarted, stopDatabase } = require('../lib/database');

const { MAGRATHEA_USERNAME, MAGRATHEA_PASSWORD, JAMBONZ_SIP_ENDPOINT, LIVEKIT_SIP_ENDPOINT } = process.env;

if (!MAGRATHEA_USERNAME || !MAGRATHEA_PASSWORD || !JAMBONZ_SIP_ENDPOINT || !LIVEKIT_SIP_ENDPOINT) {
  console.error('Please set MAGRATHEA_USERNAME, MAGRATHEA_PASSWORD, JAMBONZ_SIP_ENDPOINT, LIVEKIT_SIP_ENDPOINT');
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
  if (options.handler === 'livekit') {
    destinationIdentifier = `+44${options.number.replace(/^0/, '')}@${LIVEKIT_SIP_ENDPOINT}`;
  }
  else if (options.handler === 'jambonz') {
    let destinationIdentifier = `+44${options.number.replace(/^0/, '')}@${JAMBONZ_SIP_ENDPOINT}`;
  }
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
  (options.add ? PhoneNumber.upsert({
    number: options.number.replace(/^0/, '44'),
    handler: options.handler,
    reservation: options.reservation,
    orgnisationId: options.organisation
  }) : PhoneNumber.destroy({
    where: {
      number: options.number.replace(/^0/, '44'),
      handler: options.handler,
    }
  })
  )
    .then(phone => {
      logger.info(phone, `number-maint: ${(options.add) ? 'Created' : 'Removed'} ${options.number}`);
    })
    .then(() => stopDatabase())
    .catch(err => {
      logger.error({ err }, `Error creating ${options.number}`);
    })
);


