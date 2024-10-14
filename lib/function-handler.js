const axios = require('axios');
const logger = require('./logger');

async function functionHandler(function_calls, functions, keys, messageHandler) {
  const replaceParameters = (str, fcn) => {
    let result = str;
    let left = {};
    logger.info({ str, input: fcn.input }, 'calling replaceParameters onentry');
    Object.keys(fcn.input).forEach(key => {
      logger.info({ key, includes: result.includes(`{${key}}`), str }, 'key');
      if (result.includes(`{${key}}`)) {
        result = result.replace(`{${key}}`, `${fcn.input[key]}`);
      }
      else {
        left[key] = fcn.input[key];
      }
    });
    logger.info({ result, left, str, fcn }, 'replaceParameters done ');
    return { result, left };
  };

  if (function_calls) {
    let function_results = await Promise.all(
      function_calls?.map(async fn => {
        let f = functions.find(entry => entry.name === fn.name);
        let result, error;
        logger.info({ f }, 'got base function');
        if (f && f.implementation === 'stub') {
          ({ result } = replaceParameters(f.result, fn));
          return { ...fn, result };
        }
        else if (f && f.implementation === 'rest') {
          const authType = {
            basic: 'Basic',
            bearer: 'Bearer',
          };
          let key = f.key && keys.find(entry => entry.name === f.key);
          let authHeader = key && key.in && authType[key.in] && {
            Authorization: `${authType[key.in]} ${key.value}`
          };
          logger.info({ authHeader, key, keys, key: f.key }, 'authHeader');

          try {
            let { result: replaced, left } = replaceParameters(f.url, fn);
            let url, data;
            if (f.method?.toUpperCase() === 'POST') {
              url = new URL(replaced);
              data = left;
            }
            else {
              let params = new URLSearchParams(left);
              url = new URL(replaced + (params.toString() ? `?${params.toString()}` : ''));
            }
            logger.info({ url, data }, 'url after construction');

            messageHandler && messageHandler({
              rest_callout: {
                url: url.toString(),
                method: f.method?.toUpperCase(),
                body: f.method === 'post' ? fn.input : '',
                headers: authHeader
              },
            });
            let response = await axios(
              {
                url,
                method: f?.method || 'get',
                data,
                headers: authHeader,
              }
            );
            result = JSON.stringify(response.data, null, 2);
          }
          catch (e) {
            result = e.message;
            console.error(e, 'thing');
            error = JSON.stringify(e);
            return { ...fn, result: JSON.stringify(result, null, 2), error };
          }
        }


        if (f.implementation === 'rest')
          return { ...fn, result };
      }));
    messageHandler({ function_results });
    logger.info({ function_calls, functions, function_results }, 'function_results');
    return { function_results };
  }
};

module.exports = {
  functionHandler,
};
