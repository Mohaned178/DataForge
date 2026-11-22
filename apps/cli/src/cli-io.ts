import { readFileSync } from 'node:fs';
import { stripByteOrderMark } from '@dataforge/core';

export interface CliIo {
  out(line?: string): void;
  err(line?: string): void;
}

export const processIo: CliIo = {
  out: (line = '') => process.stdout.write(`${line}\n`),
  err: (line = '') => process.stderr.write(`${line}\n`),
};

export const EXIT_OK = 0;
/** The command ran, and what it checked did not hold (for example, a verification failure). */
export const EXIT_FAILED = 1;
/** The command could not run because of its input: bad arguments, files or configuration. */
export const EXIT_USAGE = 2;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Reads a JSON input file (a UTF-8 BOM, as written by Windows PowerShell 5.1, is accepted). */
export function readJsonFile(path: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new UsageError(`Cannot read ${label} file: ${path}`);
  }
  try {
    return JSON.parse(stripByteOrderMark(text));
  } catch (error) {
    const title = label.charAt(0).toUpperCase() + label.slice(1);
    throw new UsageError(`${title} file is not valid JSON (${path}): ${(error as Error).message}`);
  }
}
