const Jambonz = require('../lib/jambonz');

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

let applicationSid, numberSid;
process.env.LOGLEVEL = 'fatal';


describe('Jambonz', () => {
  try {



    test('Initialises', () => {
      jambonz = new Jambonz(require('../lib/logger'), 'user');
      return expect(jambonz).toBeInstanceOf(Jambonz);
    });

    test('List numbers', async () => {
      return await expect(jambonz.listNumbers()).resolves.toBeInstanceOf(Array);
    });

    test('List applications', async () => {
      let applications = await jambonz.listApplications();
      expect(applications).toBeInstanceOf(Array);
      let stub = applications.find(a => (a.name === testApplication.name && a.call_hook.url === testApplication.url));
      if (stub) {
        await jambonz.deleteApplication(stub.application_sid);
      }
    });


    test('Add application', async () => {
      return await expect(jambonz.addApplication(testApplication).then(a => ((applicationSid = a.sid), a))).resolves.toHaveProperty('sid');
    });

    test('Get application', async () => {
      return await expect(jambonz.getApplication(applicationSid)).resolves.toHaveProperty('name', testApplication.name);
    });

    test('Add number', async () => {
      return await expect(jambonz.addNumber({ number: testNumber }).then(n => ((numberSid = n.sid), n))).resolves.toHaveProperty('sid');
    });

    test('Get number', async () => {
      return await expect(jambonz.getNumber(numberSid)).resolves.toHaveProperty('number', testNumber);
    });

    test('List numbers', async () => {
      return await expect(jambonz.listNumbers()).resolves.toBeInstanceOf(Array);
    });

    test('link application to number', async () => {
      return await expect(jambonz.updateNumber(numberSid, { application: applicationSid })).resolves;
    });

    test('DeleteNumber', async () => {
      return await expect(jambonz.deleteNumber(numberSid))
        .resolves;
    });

    test('List numbers', async () => {
      return await expect(jambonz.listNumbers()).resolves.toBeInstanceOf(Array);
    });

    test('Delete Application', async () => {
      return await expect(jambonz.deleteApplication(applicationSid)).resolves;
    });

  }
  catch (e) {
    console.log(`Error ${e.message}`, e);
  }
});

