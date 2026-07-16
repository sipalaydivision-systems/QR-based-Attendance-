// Keep signed-in users active without turning every API poll into a database
// write. Sessions expire only after 30 days without a successful request.
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000;

module.exports = {
    SESSION_MAX_AGE_MS,
    SESSION_TOUCH_INTERVAL_MS,
    SESSION_CACHE_TTL_MS
};
