'use strict';

const { redactObject, redactText } = require('./redaction-service');

function fmt(v) {
  if (v == null) return v;
  if (typeof v === 'string') return redactText(v);
  if (typeof v === 'object') return redactObject(v);
  return v;
}

function info(msg, meta) {
  if (meta === undefined) return console.info(fmt(msg));
  return console.info(fmt(msg), fmt(meta));
}

function warn(msg, meta) {
  if (meta === undefined) return console.warn(fmt(msg));
  return console.warn(fmt(msg), fmt(meta));
}

function error(msg, meta) {
  if (meta === undefined) return console.error(fmt(msg));
  return console.error(fmt(msg), fmt(meta));
}

module.exports = { info, warn, error };
