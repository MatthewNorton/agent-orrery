// @ts-check
'use strict';

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

// Reads only an own data property, so getters and inherited values are never invoked.
function ownString(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, key)) {
    return '';
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
    ? descriptor.value.trim() : '';
}

function bufferValue(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value == null) return Buffer.alloc(0);
  return Buffer.from(String(value), 'utf8');
}

module.exports = { boundedInteger, ownString, bufferValue };
