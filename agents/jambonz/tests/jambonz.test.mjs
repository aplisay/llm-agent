import Jambonz from '../agent-lib/jambonz.js';
import fs from 'fs';
import logger from '../agent-lib/logger.js';

let jambonz;

let testNumber = "442080996999";

let testApplication = {
  name: "Test Application",
  url: "wss://aplisay.net/a/b",
  tts: {
    vendor: "google",
    language: "en-GB",
    voice: "en-GB-Standard-A"
  },
  stt: {
    vendor: 'google',
    language: "en-GB",
  }

};

let carriers, numbers, makeNumbers;

let needNumbers = (fs.existsSync('../credentials/numbers.js') && (await import('../credentials/numbers.js')).default) || [];

let applicationSid, numberSid;


describe('Jambonz', () => {
  try {

    test('Initialises', () => {
      jambonz = new Jambonz(logger, 'user');
      return expect(jambonz).toBeInstanceOf(Jambonz);
    });

    test('List numbers', async () => {
      try {
        numbers = await jambonz.listNumbers();
      }
      catch (e) {
        console.log({ message: e.message, path: e.request.path, response: e.response }, 'list number error');
      }
      expect(numbers).toBeInstanceOf(Array);
      let t;
      if (t = numbers.find(n => n.number === testNumber)) {
        try {
          jambonz.deleteNumber(t.phone_number_sid);
        }
        catch (e) {
          console.log({ message: e.message, request: e.request.path }, 'delete number error');
        }
        
      }
      makeNumbers = needNumbers.filter(n => {
        return !numbers.find(nn => nn.number === n);
      });
      return numbers;
    });

    test('List Carriers', async () => {
      try {
        carriers = await jambonz.listCarriers();
      }
      catch (e) {
        console.log({ message: e.message, request: e.request.path }, 'List carriers');
      }
      expect(carriers).toBeInstanceOf(Array);
      expect(carriers.length).toBeGreaterThan(0);
    });

    test('List Credentials', async () => {
      try {
        carriers = await jambonz.getCredentials();
      }
      catch (e) {
        console.log({ message: e.message, request: e.request.path }, 'List carriers');
      }
      expect(carriers).toBeInstanceOf(Array);
      expect(carriers.length).toBe(3);
    });


    test('Add missing numbers', async () => {
      return await expect(Promise.all(makeNumbers?.map(n => jambonz.addNumber({ number: n, voip_carrier_sid: carriers[0]?.voip_carrier_sid })) || [Promise.resolve()])).resolves;
    });

    test('List applications', async () => {
      let applications;
      try {
        applications = await jambonz.listApplications();
      }
      catch (e) {
        console.log({ message: e.message, request: e.request.path }, 'list application error');
      }
      expect(applications).toBeInstanceOf(Array);
      let stub = applications.find(a => (a.name === testApplication.name && a.call_hook.url === testApplication.url));
      if (stub) {
        try {
          await jambonz.deleteApplication(stub.application_sid);
        }
        catch (e) {
          console.log({ message: e.message, request: e.request.path }, 'delete application error');
        }
      }

      return;
    });


    test('Add application', async () => {

      try {
        let a = await jambonz.addApplication(testApplication);
        expect(a).toHaveProperty('sid');
        applicationSid = a.sid;
      }
      catch (e) {
        console.log({ message: e.message, request: e.request.path }, 'Add application error');
        throw new Error("shouldn't fail");
      }
    });

    test('Get application', async () => {
      expect(applicationSid).toContain('-');

      try {
        expect(await jambonz.getApplication(applicationSid)).toHaveProperty('name', testApplication.name);
      }
      catch (e) {
        console.log({ message: e.message, request: e.request.path }, 'Get application error');
        throw new Error("shouldn't fail");
      }
    });

    test('Add number', () => {
      return expect(jambonz.addNumber({ number: testNumber }).then(n => ((numberSid = n.sid), n))).resolves.toHaveProperty('sid');
    });

    test('Get number', () => {
      expect(numberSid).toContain('-');
      return expect(jambonz.getNumber(numberSid)).resolves.toHaveProperty('number', testNumber);
    });

    test('List numbers', () => {
      return expect(jambonz.listNumbers()).resolves.toBeInstanceOf(Array);
    });

    test('link application to number', async () => {
      return await expect(jambonz.updateNumber(numberSid, { application: applicationSid })).resolves;
    });

    test('DeleteNumber', async () => {
      expect(numberSid).toContain('-');
      if (numberSid) {
        return expect(jambonz.deleteNumber(numberSid))
          .resolves;
      }
    });

    test('List numbers', async () => {
      return await expect(jambonz.listNumbers()).resolves.toBeInstanceOf(Array);
    });

    test('Delete Application', async () => {
      expect(applicationSid).toContain('-');
      return await expect(jambonz.deleteApplication(applicationSid)).resolves;
    });

  }
  catch (e) {
    console.log(`Error ${e.message}`, e);
  }
});

