// Every jest config maps `node-fetch` to this file. Its callers then use the
// same `fetch` as the rest of the code: the one tests/setup/vendor-stand-ins.js
// installs, which answers the vendor catalogue requests.
//
// CommonJS, because packages under node_modules load `node-fetch` with require().
const fetch = (...args) => globalThis.fetch(...args);

module.exports = fetch;
module.exports.default = fetch;
// The classes some packages take from `node-fetch` as well.
module.exports.Headers = globalThis.Headers;
module.exports.Request = globalThis.Request;
module.exports.Response = globalThis.Response;
