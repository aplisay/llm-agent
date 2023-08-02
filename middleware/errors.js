const { STATUS_CODES } = require("http");

// eslint-disable-next-line no-unused-vars
function handleError(error, req, res, next) {
  const status =
    error.status || (error.response && error.response.statusCode) || 500;
  res.status(status);
  const message = STATUS_CODES[status];
  if (process.env.NODE_ENV === "development") {
    req.log.error({ error, data: error.data, message, status });
    res.json({
      error: message,
      info: (error.response && error.response.body) || error.message,
      stack: error.stack
    });
  } else {
    res.json({ error: message, info: error.message });
  }
}

module.exports = handleError;