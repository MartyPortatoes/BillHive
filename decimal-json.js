'use strict';

// Keep JSON numbers as numbers on the wire. Wrap only tokens whose decimal value
// would change through Number -> JSON.stringify; normal browser payloads retain
// their existing JS types. Node 24 supplies the original token to the reviver.
function parts(source) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) throw new SyntaxError('Invalid decimal number');
  let digits = (match[2] + (match[3] || '')).replace(/^0+/, '');
  if (!digits) return {negative:false, digits:'0', exponent:0n};
  const trailing = digits.length - digits.replace(/0+$/, '').length;
  digits = digits.slice(0, digits.length - trailing);
  return {negative:match[1] === '-', digits, exponent:BigInt(match[4] || '0') - BigInt((match[3] || '').length) + BigInt(trailing)};
}
function normalized(source) {
  const p = parts(source);
  return (p.negative ? '-' : '') + p.digits + (p.exponent === 0n ? '' : 'e' + p.exponent);
}
class DecimalNumber {
  #source;
  constructor(source) { this.#source = source; Object.freeze(this); }
  toString() { return this.#source; }
  toJSON() { return JSON.rawJSON(this.#source); }
  [Symbol.toPrimitive](hint) {
    if (hint === 'string') return this.#source;
    throw new TypeError('Use exact decimal operations instead of Number coercion');
  }
}
const exact = value => value instanceof DecimalNumber;
const number = value => exact(value) || typeof value === 'number' && Number.isFinite(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !exact(value);
function revive(_key, value, context) {
    if (typeof value !== 'number') return value;
    if (!Number.isFinite(value)) throw new SyntaxError('Non-finite JSON number');
    const token = context.source;
    if (typeof token !== 'string') throw new Error('Lossless JSON requires Node 24');
    return normalized(token) === normalized(JSON.stringify(value)) ? value : new DecimalNumber(token);
}
const parse = source => JSON.parse(source, revive);
function canonical(value) {
  if (number(value)) return normalized(String(value));
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function legacyCanonical(value) {
  if (exact(value)) return JSON.stringify(Number(String(value)));
  if (Array.isArray(value)) return '[' + value.map(legacyCanonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + legacyCanonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function containsExact(value) {
  return exact(value) || value !== null && typeof value === 'object' && Object.values(value).some(containsExact);
}
function legacyReceiptRisk(value) {
  // Both neighbors of a rounded 16+ digit token are ambiguous, including the
  // neighbor that happens to survive today's parse/stringify unchanged.
  // Four-digit currency units above the safe-integer range also require an
  // exact client, even when the major-unit token happens to be an integer.
  if (number(value)) return exact(value) || parts(String(value)).digits.length > 15 || compare(value,900719925474) > 0 || compare(value,-900719925474) < 0;
  return value !== null && typeof value === 'object' && Object.values(value).some(legacyReceiptRisk);
}
function compare(a, b) {
  if (!number(a) || !number(b)) throw new TypeError('Expected finite JSON numbers');
  const x = parts(String(a)), y = parts(String(b));
  if (x.negative !== y.negative) return x.negative ? -1 : 1;
  let result;
  if (x.digits === '0' || y.digits === '0') result = x.digits === y.digits ? 0 : x.digits === '0' ? -1 : 1;
  else {
    const xm = x.exponent + BigInt(x.digits.length), ym = y.exponent + BigInt(y.digits.length);
    if (xm !== ym) result = xm < ym ? -1 : 1;
    else {
      const length = Math.max(x.digits.length, y.digits.length);
      const xd = x.digits.padEnd(length, '0'), yd = y.digits.padEnd(length, '0');
      result = xd === yd ? 0 : xd < yd ? -1 : 1;
    }
  }
  return x.negative ? -result : result;
}
const amount = value => number(value) && compare(value, 0) >= 0 && compare(value, 1e12) <= 0;
function fixed(value, digits) {
  if (!number(value) || !Number.isInteger(digits) || digits < 0 || digits > 6) throw new TypeError('Invalid currency amount');
  const p = parts(String(value)), shift = p.exponent + BigInt(digits);
  let units;
  if (shift >= 0n) {
    if (shift > 1000n) throw new RangeError('Amount is too large to format');
    units = BigInt(p.digits) * 10n ** shift;
  } else {
    const retained = BigInt(p.digits.length) + shift;
    if (retained < 0n) units = 0n;
    else {
      const cut = Number(retained);
      units = BigInt(p.digits.slice(0, cut) || '0') + (p.digits[cut] >= '5' ? 1n : 0n);
    }
  }
  const text = units.toString().padStart(digits + 1, '0');
  return (p.negative && units !== 0n ? '-' : '') + (digits ? text.slice(0, -digits) + '.' + text.slice(-digits) : text);
}
const units = (value, digits) => BigInt(fixed(value, digits).replace('.', ''));
function fromUnits(value, digits) {
  const negative = value < 0n, text = (negative ? -value : value).toString().padStart(digits + 1, '0');
  return parse((negative ? '-' : '') + (digits ? text.slice(0, -digits) + '.' + text.slice(-digits) : text));
}
module.exports = {parse, revive, exact, number, record, canonical, legacyCanonical, containsExact, legacyReceiptRisk, compare, amount, fixed, units, fromUnits, parts};
