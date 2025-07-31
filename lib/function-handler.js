import axios from 'axios';
import logger from './logger.js';

async function functionHandler(function_calls, functions, keys, messageHandler, metadata, builtins) {
  const replaceParameters = (str, input) => {
    let result = str;
    let left = {};
    logger.debug({ str, input }, 'calling replaceParameters onentry');
    Object.keys(input).forEach(key => {
      logger.debug({ key, includes: result.includes(`{${key}}`), str }, 'key');
      if (result.includes(`{${key}}`)) {
        result = result.replace(`{${key}}`, `${input[key]}`);
      }
      else {
        left[key] = input[key];
      }
    });
    logger.debug({ result, left, str, input }, 'replaceParameters done ');
    return { result, left };
  };

  if (function_calls) {
    let function_results = await Promise.all(
      function_calls?.map(async fn => {
        const f = functions.find(entry => entry.name === fn.name);
        let result, error;
        logger.debug({ f }, 'got base function');
        const input = Object.fromEntries(Object.entries(f.input_schema.properties).map(([key, entry]) =>
          [key, (entry.source === 'static' && entry.from)
            || (entry.source === 'metadata' && metadata[entry.from.split('.')[0]][entry.from.split('.')[1]])
            || fn.input[key] || entry.default]
        ));
        logger.debug({ f, input }, 'got base function with inputs');
        if (f && f.implementation === 'stub') {
          ({ result } = replaceParameters(f.result, input));
          return { ...fn, result };
        }
        else if (f && f.implementation === 'rest') {
          let key = f.key && keys.find(entry => entry.name === f.key);
          let authHeader = key?.in  && {
            basic: {
              Authorization: `Basic ${key.value}`
            },
            bearer: {
              Authorization: `Bearer ${key.value}`
            },
            header: {
              [key.header || 'noused']: `${key.value}`            },
          }[key.in];

          logger.debug({ authHeader, key, keys, key: f.key }, 'authHeader');

          try {

            logger.debug({ input }, 'input after defaulting');
            let { result: replaced, left } = replaceParameters(f.url, input);
            let url, data;
            if (f.method?.toUpperCase() === 'POST') {
              url = new URL(replaced);
              data = left;
            }
            else {
              let params = new URLSearchParams(left);
              url = new URL(replaced + (params.toString() ? `?${params.toString()}` : ''));
            }
            logger.debug({ url, data }, 'url after construction');

            messageHandler && messageHandler({
              rest_callout: {
                url: url.toString(),
                method: f.method?.toUpperCase(),
                body: f.method === 'post' ? input : '',
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
        else if (f && f.implementation === 'builtin' && builtins[f.platform]) {
          result = JSON.stringify(await builtins[f.platform](input));
        }

        if (f.implementation === 'rest')
          return { ...fn, result };
        else if (f.implementation === 'builtin')
          return { ...fn, result };
      }));
    messageHandler({ function_results });
    logger.debug({ function_calls, functions, function_results }, 'function_results');
    return { function_results };
  }
};

export {
  functionHandler,
};
