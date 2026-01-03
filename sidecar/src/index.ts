const logPrefix = '[sidecar]';

console.log(`${logPrefix} started`);

process.on('SIGTERM', () => {
  console.log(`${logPrefix} shutdown requested`);
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error(`${logPrefix} uncaught exception`, error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error(`${logPrefix} unhandled rejection`, error);
  process.exit(1);
});

process.stdin.resume();
