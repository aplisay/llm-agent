require("dotenv").config();
const axios = require("axios");

if (!process.env.JAMBONZ_API_KEY) {
  throw new Error(
    "No OpenAI api key, set OPENAI_API_KEY in server environment ;"
  );
}

const api = axios.create({
  baseURL: `https://${process.env.JAMBONZ_SERVER || "api.jambonz.xyz"}/v1`,
  method: "post",
  headers: {
    Authorization: `Bearer ${process.env.JAMBONZ_API_KEY}`,
  },
});

class Jambonz {
  constructor(logger, user) {
    this.logger = logger.child({ user });
  }

  async listNumbers() {
    let { data } = await api.get("PhoneNumbers");
    this.logger.info({ data }, 'list numbers');
    return data;
  }


  async getNumber(sid) {
    let { data } = await api.get(`PhoneNumbers/${sid}`);
    this.logger.info({ data }, 'get number');
    return data;
  }



  async addNumber({ number, carrier, application }) {
    let { data } = await api.post("PhoneNumbers", {
      number, voip_carrier_sid: carrier, application_sid: application
    });
    this.logger.info({ data }, 'add number');
    return data;
  };

  async updateNumber(sid, { carrier, application }) {
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
    this.logger.info({ sid }, `delete PhoneNumbers/${sid}`);
    let { data } = await api.delete(`PhoneNumbers/${sid}`);
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
      call_hook: {
        url,
        method: "POST",
      },
      call_status_hook: {
        url,
        method: "POST",
      },
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
