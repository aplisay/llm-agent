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
axios.interceptors.response.use(
  function (response) {
    return response;
  },
  function (error) {
    return Promise.reject();
  }
);
let numberApi = null,
  accountApi = null;

// The PhoneNumbers endpoint isn't currently documented at https://api.jambonz.org/
// On older versions (which versions?), there is directly a /v1/PhoneNumbers
//  route. On newer versions we have to specify the service provider, and account id
//  in the path or POST data.
const getServiceProvider = async () => {
  let serviceProviderSid, accountSid;
  try {
    let { data } = await api.get("ServiceProviders");
    serviceProviderSid = data.length && data[0]?.service_provider_sid;
    if (serviceProviderSid) {
      numberApi = api.create({
        baseURL: `${api.defaults.baseURL}/ServiceProviders/${serviceProviderSid}`,
      });
    }
    ({ data } = await api.get("Accounts"));
    accountSid = data.length && data[0]?.account_sid;
    this.logger.debug({ data, accountSid }, "accounts");
    if (accountSid) {
      accountApi = api.create({
        baseURL: `${api.defaults.baseURL}/Accounts/${accountSid}`,
      });
    }
  } catch (e) {
    // no `/ServiceProviders` path, we are talking to an old version
    this.logger.info({ e }, "No serviceprovider numberApi = api;");
  } finally {
    numberApi = numberApi || api;
    accountApi = accountApi || api;
    return { serviceProviderSid, accountSid };
  }
};

/**
 * Client implementation of selected parts of the Jambonz API
 *
 * @class Jambonz
 */
class Jambonz {
  /**
   * Creates an instance of Jambonz.
   * @param {Object} logger pino logger instance
   * @param {string} user User identifier
   * @memberof Jambonz
   */
  constructor(logger, user) {
    this.logger = logger.child({ user });
    this.serviceProvider = getServiceProvider();
  }

  /**
   *  Gett all of the Jambonz numbers on the instance
   *
   * @return {Promise<Object[]>} All Jambonz number resources on the instance
   * @memberof Jambonz
   */
  async listNumbers() {
    await this.serviceProvider;
    let { data } = await numberApi.get("PhoneNumbers");
    this.logger.debug({ data }, "list numbers");
    return data;
  }

  /**
   *  Get all of the Jambonz Service Providers
   *
   * @return {Promise<Object[]>} All Jambonz number resources on the instance
   * @memberof Jambonz
   */
  async listCarriers() {
    await this.serviceProvider;
    let { data } = await numberApi.get("VoipCarriers");
    this.logger.debug({ data }, "list serviceProviders");
    return data;
  }

  /**
   *
   *
   * @param {string} sid
   * @return {Promise<Object>} Jambonz number detail
   * @memberof Jambonz
   */
  async getNumber(sid) {
    await this.serviceProvider;
    let { data } = await api.get(`PhoneNumbers/${sid}`);
    this.logger.debug({ data }, "get number");
    return data;
  }

  /**
   * Add a new number
   *
   * @param {Object} { number, carrier, application }
   * @return {Promise<string>} sid
   * @memberof Jambonz
   */
  async addNumber({ number, carrier, application }) {
    await this.serviceProvider;
    let { data } = await api.post("PhoneNumbers", {
      account_sid: (await this.serviceProvider).accountSid,
      number,
      voip_carrier_sid: carrier,
      application_sid: application,
    });

    return data;
  }

  /**
   * Update detail of a number
   *
   * @param {string} sid
   * @param {Object} { carrier, application } to update
   * @return {Promise} resolves on completion
   * @memberof Jambonz
   */
  async updateNumber(sid, { carrier, application }) {
    await this.serviceProvider;
    if (!sid) throw new Error("No SID in update call");
    let request = {
      voip_carrier_sid: carrier === false ? null : carrier,
      application_sid: application === false ? null : application,
    };
    this.logger.debug({ request }, "update number request");
    let { data } = await api.put(`PhoneNumbers/${sid}`, request);
    this.logger.debug({ data }, "update numbers");
    return data;
  }

  /**
   * Delete Number
   *
   * @param {string} sid
   * @return {Promise} resolves on completion
   * @memberof Jambonz
   */
  async deleteNumber(sid) {
    await this.serviceProvider;
    this.logger.debug({ sid }, `delete PhoneNumbers/${sid}`);
    let { data } = await api.delete(`PhoneNumbers/${sid}`);
    this.logger.debug({ data }, "delete number");
    return data;
  }

  /**
   * Get a list of applications
   *
   * @return {Promise<Object[]>} List of applications
   * @memberof Jambonz
   */
  async listApplications() {
    let { data } = await api.get("Applications");
    this.logger.debug({ data }, "list applications");
    return data;
  }

  /**
   * Get an application by sid
   *
   * @param {string} sid
   * @return {Promise<Object>}
   * @memberof Jambonz
   */
  async getApplication(sid) {
    let { data } = await api.get(`Applications/${sid}`);
    this.logger.debug({ data }, "get application");
    return data;
  }

  /**
   * Add an application
   *
   * @param {Object} {
   *     name,
   *     url,
   *     stt,
   *     tts
   *   }
   * @return {Promise} resolves on creation
   * @memberof Jambonz
   */
  async addApplication({ name, url, stt, tts }) {
    stt = {
      vendor: "google",
      language: "en-GB",
      voice: "en-GB-Wavenet-B",
      ...stt,
    };
    tts = {
      vendor: "google",
      language: "en-GB",
      ...tts,
    };
    let request = {
      name,
      account_sid: (await this.serviceProvider)["accountSid"],
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
    this.logger.debug({ request }, "add application request");
    let { data } = await api.post("Applications", request);
    this.logger.debug({ data }, "add application response");
    return data;
  }

  /**
   * Update an application
   *
   * @param {string} sid
   * @param {Object} {
   *     name,
   *     url,
   *     stt,
   *     tts
   *   }
   * @return {Promise} resolves on update
   * @memberof Jambonz
   */
  async updateApplication(sid, { name, url, stt, tts }) {
    stt = {
      vendor: "google",
      language: "en-UK",
      voice: "en-GB-Wavenet-B",
      ...stt,
    };
    tts = {
      vendor: "google",
      language: "en-GB",
      ...tts,
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
    this.logger.debug({ data }, "update application");
    return data;
  }

  /**
   *
   *
   * @param {string} sid
   * @return {Promise} resolves on completion
   * @memberof Jambonz
   */
  async deleteApplication(sid) {
    let { data } = await api.delete(`Applications/${sid}`);
    this.logger.debug({ data }, "delete application");
    return data;
  }
}

module.exports = Jambonz;
