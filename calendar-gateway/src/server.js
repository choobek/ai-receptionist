const { loadConfig } = require('./config');
const { ConnectionStore } = require('./store');
const { createGoogleCalendarProvider } = require('./google-provider');
const { createApp } = require('./app');

async function start() {
  const config = loadConfig();
  const store = new ConnectionStore({
    filePath: config.dataFilePath,
    encryptionKey: config.encryptionKey
  });
  await store.init();

  const app = createApp({
    config,
    store,
    calendarProvider: createGoogleCalendarProvider(config)
  });

  app.listen(config.port, () => {
    console.log(
      `[calendar-gateway] listening on port ${config.port}` +
        (config.startupWarnings.length > 0 ? ` (warnings: ${config.startupWarnings.join('; ')})` : '')
    );
  });
}

start().catch((error) => {
  console.error('[calendar-gateway] failed to start', error);
  process.exitCode = 1;
});
