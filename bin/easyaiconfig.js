#!/usr/bin/env node
import { startServer } from '../src/server.js';

startServer().catch((error) => {
  console.error('[easyaiconfig] failed to start');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
