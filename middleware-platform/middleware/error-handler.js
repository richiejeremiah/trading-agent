'use strict';

function notFoundHandler(req, res) {
  res.status(404).json({ success: false, error: 'not_found', path: req.path });
}

function errorHandler(err, req, res, _next) {
  console.error('[error]', err.message, req.method, req.path);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'internal_error',
  });
}

module.exports = { notFoundHandler, errorHandler, logError: () => {} };
