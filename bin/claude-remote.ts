#!/usr/bin/env node
import { buildCli } from '../src/cli.js';

buildCli()
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(`\nError: ${(err as Error).message}`);
    process.exitCode = 1;
  });
