'use strict';

// Build counts as a file from outside may hold them, for every test of how a project keeps them:
// two casings of one folder; a count that is a string beside a casing that is a number (joined as
// they stood they made "46"); a fraction; two casings of 1e308 (added as they stood they made
// Infinity, which saves as null); counts that are none; and a folder named __proto__.

const MAX = Number.MAX_SAFE_INTEGER;
// As text: '__proto__' is an own key only out of JSON.parse.
const CASED_COUNTS = '{ "Docs": 5, "docs": 7, "Odd": "4", "odd": 6, "src": 2.9, "big": 1e308, "BIG": 1e308,'
  + ' "neg": -1, "none": null, "zero": 0, "__proto__": 3 }';
const casedCounts = () => JSON.parse(CASED_COUNTS);

// What a project keeps of them where two casings are two folders, and where they are one: added
// up when they were counted under a path, the larger alone when they came from a record with no
// path, which counted nothing itself.
const KEPT_APART = [['Docs', 5], ['docs', 7], ['odd', 6], ['src', 2], ['big', MAX], ['BIG', MAX], ['__proto__', 3]];
const KEPT_AS_ONE = [['Docs', 12], ['odd', 6], ['src', 2], ['big', MAX], ['__proto__', 3]];
const KEPT_LARGER = [['Docs', 7], ['odd', 6], ['src', 2], ['big', MAX], ['__proto__', 3]];

// A buckets object's own counts, in key order: reading buckets.__proto__ answers the prototype, not a count.
const own = (buckets) => Object.keys(buckets).map((name) => [name, Object.getOwnPropertyDescriptor(buckets, name).value]);

module.exports = { CASED_COUNTS, casedCounts, own, KEPT_APART, KEPT_AS_ONE, KEPT_LARGER };
