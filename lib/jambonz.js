import 'dotenv/config';
import logger from './logger.js';
import axios from "axios";

if (!process.env.JAMBONZ_API_KEY) {
  throw new Error(
    "No Jambonz api key, set JAMBONZ_API_KEY in server environment ;"
  );
}

let api = axios.create({
  baseURL: `${process.env.JAMBONZ_SERVER || "https://api.jambonz.xyz"}/v1`,
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
    ({ data } = await api.get("Accounts"));
    accountSid = data.length && data[0]?.account_sid;
    serviceProviderSid = serviceProviderSid || (data.length && data[0]?.service_provider_sid);
    if (serviceProviderSid) {
      numberApi = api.create({
        baseURL: `${api.defaults.baseURL}/ServiceProviders/${serviceProviderSid}`,
      });
    }
    logger.debug({ data, accountSid }, "accounts");
    if (accountSid) {
      accountApi = api.create({
        baseURL: `${api.defaults.baseURL}/Accounts/${accountSid}`,
      });
      logger.debug({ accountSid, baseURL: accountApi.baseURL }, "setting accountApi");
    }
  } catch (e) {
    // no `/ServiceProviders` path, we are talking to an old version
    logger.debug(e, "old version");
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
    let { data } = await api.get("PhoneNumbers");
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
    let { data } = await api.get("Carriers");
    this.logger.debug({ data }, "list carriers");
    return data;
  }

  /**
   *  Get a specific Jambonz number
   *
   * @param {string} sid
   * @return {Promise<Object>} Jambonz number resource
   * @memberof Jambonz
   */
  async getNumber(sid) {
    await this.serviceProvider;
    let { data } = await api.get(`PhoneNumbers/${sid}`);
    this.logger.debug({ data }, "get number");
    return data;
  }

  /**
   * Add a number to Jambonz
   *
   * @param {Object} {
   *     number,
   *     carrier,
   *     application
   *   }
   * @return {Promise} resolves on add
   * @memberof Jambonz
   */
  async addNumber({ number, carrier, application }) {
    await this.serviceProvider;
    let request = {
      phone_number: number,
      carrier_sid: carrier,
      application_sid: application,
    };
    this.logger.debug({ request }, "add number request");
    let { data } = await api.post("PhoneNumbers", request);
    this.logger.debug({ data }, "add number response");
    return data;
  }

  /**
   * Update a number
   *
   * @param {string} sid
   * @param {Object} {
   *     carrier,
   *     application
   *   }
   * @return {Promise} resolves on update
   * @memberof Jambonz
   */
  async updateNumber(sid, { carrier, application }) {
    await this.serviceProvider;
    let request = {
      carrier_sid: carrier,
      application_sid: application,
    };
    let { data } = await api.put(`PhoneNumbers/${sid}`, request);
    this.logger.debug({ data }, "update number");
    return data;
  }

  /**
   *
   *
   * @param {string} sid
   * @return {Promise} resolves on completion
   * @memberof Jambonz
   */
  async deleteNumber(sid) {
    await this.serviceProvider;
    let { data } = await api.delete(`PhoneNumbers/${sid}`);
    this.logger.debug({ data }, "delete number");
    return data;
  }

  /**
   *  Get all of the Jambonz applications on the instance
   *
   * @return {Promise<Object[]>} All Jambonz application resources on the instance
   * @memberof Jambonz
   */
  async listApplications() {
    await this.serviceProvider;
    let { data } = await api.get("Applications");
    this.logger.debug({ data }, "list applications");
    return data;
  }

  /**
   *  Get a specific Jambonz application
   *
   * @param {string} sid
   * @return {Promise<Object>} Jambonz application resource
   * @memberof Jambonz
   */
  async getApplication(sid) {
    await this.serviceProvider;
    let { data } = await api.get(`Applications/${sid}`);
    this.logger.debug({ data }, "get application");
    return data;
  }

  /**
   * Add an application to Jambonz
   *
   * @param {Object} {
   *     name,
   *     url,
   *     stt,
   *     tts
   *   }
   * @return {Promise} resolves on add
   * @memberof Jambonz
   */
  async addApplication({ name, url, stt, tts }) {
    await this.serviceProvider;
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

  /**
 *  Get all of the Jambonz credentials on the instance
 *
 * @return {Promise<Object[]>} All Jambonz number resources on the instance
 * @memberof Jambonz
 */
  async getCredentials() {
    await this.serviceProvider;
    let { data } = await accountApi.get("SpeechCredentials");
    this.logger.debug({ data }, "list credentials");
    return data;
  }

}

export default Jambonz;
