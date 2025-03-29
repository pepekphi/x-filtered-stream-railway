/*
 * Paused version of the service.
 * No connection to the X.com (Twitter) API is made.
 */

console.log("Service is paused. No operations are running.");

// Setup graceful shutdown handlers
function shutdown() {
  console.log("Shutdown initiated. Exiting paused service.");
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
