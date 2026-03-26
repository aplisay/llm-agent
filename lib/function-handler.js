import axios from 'axios';
import logger from './logger.js';
import { getByPath } from './metadata-path.js';

const hardwiredBuiltins = {
  metadata: (input, metadata, options = {}) => {
    let { keys } = input;
    if (typeof keys === 'string') {
      keys = keys.split(',').map(key => key.trim());
    }
    !Array.isArray(keys) && (keys = [keys]);
    let result = {};
    keys.forEach(key => {
      if (!options.allowToolsCallsMetadataPaths && (key === 'toolsCalls' || key.startsWith('toolsCalls.'))) {
        throw new Error('Access to metadata.toolsCalls is only allowed in LiveKit agents');
      }
      const value = getByPath(metadata, key);
      result[key] = value === undefined || value === null ? 'unknown' : value;
    });
    logger.debug({ result, keys, metadata }, 'metadata result');
    return result;
  }
};

async function functionHandler(function_calls, functions, keys, messageHandler, metadata, specficBuiltins, options = {}) {
  let builtins = { ...hardwiredBuiltins, ...specficBuiltins };
  const tryParseJson = (value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') return undefined;
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  };
  const writeToolResultToMetadata = (toolName, parameter, result, error) => {
    if (!metadata || typeof metadata !== 'object') return;
    metadata.toolsCalls = metadata.toolsCalls || {};
    metadata.toolsCalls[toolName] = metadata.toolsCalls[toolName] || {};
    metadata.toolsCalls[toolName].parameter = parameter;
    if (error) metadata.toolsCalls[toolName].error = error;
    const parsed = tryParseJson(result);
    metadata.toolsCalls[toolName].result = parsed !== undefined ? parsed : result;
  };
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
    // Execute sequentially so later tool calls can read results written to metadata
    let function_results = [];
    for (const fn of function_calls) {
      const f = functions.find(entry => entry.name === fn.name);
      const canRedactFunctionResult = !!(options.allowRedactedFunctionResults && f?.redact);
      let result, error;
      logger.debug({ f }, 'got base function');
      const input = Object.fromEntries(Object.entries(f.input_schema.properties).map(([key, entry]) => {
        let value;
        if (entry.source === 'static' && entry.from) {
          value = entry.from;
        }
        else if (entry.source === 'metadata') {
          if (!options.allowToolsCallsMetadataPaths && (entry.from === 'toolsCalls' || entry.from?.startsWith('toolsCalls.'))) {
            throw new Error('Access to metadata.toolsCalls is only allowed in LiveKit agents');
          }
          value = getByPath(metadata, entry.from);
          if (value === undefined || value === null) {
            throw new Error(`Metadata ${entry.from} not found`);
          }
        }
        value = value ?? fn.input?.[key] ?? entry.default;
        return [key, value];
      }));
      logger.debug({ f, input }, 'got base function with inputs');

      if (f && f.implementation === 'stub') {
        logger.debug({
          function_calls: [{
            name: f.name,
            arguments: input
          }]
        }, 'sending stub function');
        messageHandler && messageHandler({
          function_calls: [{
            name: f.name,
            arguments: input
          }]
        });
        ({ result } = replaceParameters(f.result, input));
      }
      else if (f && f.implementation === 'rest') {
        let key = f.key && keys.find(entry => entry.name === f.key);
        let authHeader = key?.in && {
          basic: {
            Authorization: `Basic ${key.value}`
          },
          bearer: {
            Authorization: `Bearer ${key.value}`
          },
          header: {
            [key.header || 'noused']: `${key.value}`
          },
        }[key.in];

        logger.debug({ authHeader, key, keys, key: f.key }, 'authHeader');

        try {
          logger.debug({ input }, 'input after defaulting');
          let { result: replaced, left } = replaceParameters(f.url, input);
          let url, data;
          const method = f.method?.toUpperCase();
          if (method.includes('POST') || method === 'PUT') {
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
          if (e.response && e.response.data) {
            result = typeof e.response.data === 'object' ? ({ ...e.response.data }) : e.response.data;
          }
          else {
            result = e.message;
          }
          error = { status: e.response?.status, statusText: e.response?.statusText, message: e?.message };
          logger.info({ error }, 'error in function handler');
          result = JSON.stringify(result, null, 2);
        }
      }
      else if (f && f.implementation === 'builtin' && builtins[f.platform]) {
        result = JSON.stringify(await builtins[f.platform](input, metadata, options));
      }

      const rawResult = result;
      const llmResult = canRedactFunctionResult
        ? (error ? 'FAILED - invocation failed' : 'OK - function completed')
        : rawResult;

      const toolResult = error ? { ...fn, result: llmResult, error } : { ...fn, result: llmResult };
      writeToolResultToMetadata(fn.name, input, rawResult, error);
      function_results.push(toolResult);
    }
    messageHandler({ function_results: function_results.map(f => ({ name: f.name, input: f.input, result: f.result })) });
    logger.debug({ function_calls, functions, function_results }, 'function_results');
    return { function_results };
  }
};

export {
  functionHandler,
};

