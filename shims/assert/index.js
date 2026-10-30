// Node's `assert` for the browser build. Bun's built-in polyfill reaches CommonJS callers as a
// namespace object, so ffjavascript and circomlibjs (which call `assert(value, message)`) crash
// while loading. This keeps the callable default plus the common helpers.
function fail(message) {
  const error = new Error(message || "Assertion failed");
  error.name = "AssertionError";
  throw error;
}

function assert(value, message) {
  if (!value) fail(message);
}

assert.ok = assert;
assert.fail = fail;
assert.equal = (actual, expected, message) => actual == expected || fail(message);
assert.notEqual = (actual, expected, message) => actual != expected || fail(message);
assert.strictEqual = (actual, expected, message) => actual === expected || fail(message);
assert.notStrictEqual = (actual, expected, message) => actual !== expected || fail(message);

module.exports = assert;
