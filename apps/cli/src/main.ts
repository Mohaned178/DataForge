#!/usr/bin/env node
import { runCli } from './cli';
import { processIo } from './cli-io';

process.exitCode = runCli(process.argv.slice(2), processIo);
