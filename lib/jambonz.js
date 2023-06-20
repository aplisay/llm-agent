require("dotenv").config();
const axios = require("axios");

if (!process.env.JAMBONZ_API_KEY) {
  throw new Error(
    "No Jambonz api key, set JAMBONZ_API_KEY in server environment ;"
  );
}

let api = axios.create({
  baseURL: `https://${process.env.JAMBONZ_SERVER || "api.jambonz.xyz"}/v1`,
  method: "post",
  headers: {
    Authorization: `Bearer ${process.env.JAMBONZ_API_KEY}`,
  },
});
let numberApi;

const getServiceProvider = async () => {

  let { data } = await api.get("ServiceProviders");
  let serviceProviderSid = data.length && data[0]?.service_provider_sid;
  let accountSid;
  if (serviceProviderSid) {
    numberApi = api.create({
      baseURL: `${api.defaults.baseURL}/ServiceProviders/${serviceProviderSid}`
    });
    ({ data } = await numberApi.get("Accounts"))
    accountSid = data.length && data[0]?.account_sid;

  }
  else {
    numberApi = api;
  }
  return { serviceProviderSid, accountSid }; 
}


class Jambonz {
  constructor(logger, user) {
    this.logger = logger.child({ user });
    this.serviceProvider = getServiceProvider();
  }

  async listNumbers() {
    await this.serviceProvider
    let { data } = await numberApi.get("PhoneNumbers");
    this.logger.info({ data }, 'list numbers');
    return data;
  }


  async getNumber(sid) {
    await this.serviceProvider
    let { data } = await api
      .get(`PhoneNumbers/${sid}`);
    this.logger.info({ data }, 'get number');
    return data;
  }

  async addNumber({ number, carrier, application }) {
    await this.serviceProvider
      let { data } = await api.post("PhoneNumbers", {
        account_sid: (await this.serviceProvider).accountSid,
        number, voip_carrier_sid: carrier, application_sid: application
      });

    return data;
  };

  async updateNumber(sid, { carrier, application }) {
    await this.serviceProvider
    if (!sid)
      throw new Error('No SID in update call');
    let request = {
      voip_carrier_sid: (carrier === false) ? null : carrier,
      application_sid: (application === false) ? null : application
    };
    this.logger.info({ request }, 'update number request');
    let { data } = await api.put(`PhoneNumbers/${sid}`, request);
    this.logger.info({ data }, 'update numbers');
    return data;
  };

  async deleteNumber(sid) {
    await this.serviceProvider
    this.logger.info({ sid }, `delete PhoneNumbers/${sid}`);
    let { data } = await numberApi.delete(`PhoneNumbers/${sid}`);
    this.logger.info({ data }, 'delete number');
    return data;
  };


  async listApplications() {
    let { data } = await api.get("Applications");
    this.logger.info({ data }, 'list applications');
    return data;
  }

  async getApplication(sid) {
    let { data } = await api.get(`Applications/${sid}`);
    this.logger.info({ data }, 'get application');
    return data;
  }


  async addApplication({
    name,
    url,
    stt,
    tts
  }) {
    stt = {
      vendor: "google",
      language: "en-GB",
      voice: "en-GB-Standard-A",
      ...stt
    };
    tts = {
      vendor: "google",
      language: "en-GB",
      ...tts
    };
    let request = {
      name,
      account_sid: (await this.serviceProvider)['accountSid'],
      call_hook: {
        url,
        method: "POST",
      },
      call_status_hook: {
        url,
        method: "POST",
      },
      record_all_calls: 0,
      speech_synthesis_vendor: tts.vendor,
      speech_synthesis_language: tts.language,
      speech_synthesis_voice: tts.voice,
      speech_recognizer_vendor: stt.vendor,
      speech_recognizer_language: stt.language,
    };
    this.logger.info({ request }, 'add application request');
    let { data } = await api.post("Applications", request);
    this.logger.info({ data }, 'add application response');
    return data;
  }

  async updateApplication(sid, {
    name,
    url,
    stt,
    tts
  }) {
    stt = {
      vendor: "google",
      language: "en-UK",
      voice: "en-GB-Standard-A",
      ...stt
    };
    tts = {
      vendor: "google",
      language: "en-GB",
      ...tts
    };
    let request = {
      name,
      call_hook: {
        url,
        method: "POST",
      },
      call_status_hook: {
        url,
        method: "POST",
      },
      record_all_calls: 0,
      speech_synthesis_vendor: tts.vendor,
      speech_synthesis_language: tts.language,
      speech_synthesis_voice: tts.voice,
      speech_recognizer_vendor: stt.vendor,
      speech_recognizer_language: stt.language,
    };
    let { data } = await api.put(`Applications/${sid}`, request);
    this.logger.info({ data }, 'update application');
    return data;
  }

  async deleteApplication(sid) {
    let { data } = await api.delete(`Applications/${sid}`);
    this.logger.info({ data }, 'delete application');
    return data;
  }
}

module.exports = Jambonz;
