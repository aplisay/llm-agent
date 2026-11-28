import { STATUS_CODES } from "http";

const errorItems = (errors) => Array.isArray(errors)
  ? errors.map((item) => ({ path: item?.path, errorCode: item?.errorCode, message: item?.message, location: item?.location }))
  : undefined;

// eslint-disable-next-line no-unused-vars
function handleError(error, req, res, next) {
  const status =
    error.status || (error.response && error.response.statusCode) || 500;
  res.status(status);
  const message = STATUS_CODES[status];
  if (process.env.NODE_ENV === "development") {
    req.log && req.log.error({ err: error, data: error.data, message, status });
    res.json({
      error: message,
      errors: errorItems(error?.errors),
      info: (error.response && error.response.body) || error.message,
      stack: error.stack
    });
  } else {
    res.json({ error: message, info: error.message, errors: errorItems(error?.errors) });
  }
}

export default handleError;
