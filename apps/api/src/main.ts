import { createApp } from './app.factory';
import { loadConfig } from './config';

async function bootstrap() {
  const config = loadConfig();
  const app = await createApp(config);
  app.enableShutdownHooks();
  await app.listen(config.port);
  console.log(`RepairOS API listening on http://localhost:${config.port}/api (v${config.version})`);
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
