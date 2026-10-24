#!/usr/bin/env node
import { main } from './cli.js';

const code = await main(process.argv.slice(2));
if (code !== 0) {
  process.exitCode = code;
}
