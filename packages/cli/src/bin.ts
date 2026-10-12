#!/usr/bin/env node
import { run } from './main.js';

process.exitCode = await run(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(line + '\n'),
  stderr: (line) => process.stderr.write(line + '\n'),
});
