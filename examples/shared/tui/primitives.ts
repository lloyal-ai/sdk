let _jsonlMode = false;
let _verboseMode = false;

export function setJsonlMode(on: boolean): void { _jsonlMode = on; }
export function setVerboseMode(on: boolean): void { _verboseMode = on; }
export function isJsonlMode(): boolean { return _jsonlMode; }
export function isVerboseMode(): boolean { return _verboseMode; }

export const isTTY = !!process.stdout.isTTY;

export const c = isTTY ? {
  bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m',
  green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m',
} : { bold: '', dim: '', reset: '', green: '', cyan: '', yellow: '', red: '' };

let _statusText = '';

export function status(text: string): void {
  if (_jsonlMode || !isTTY) return;
  _statusText = text;
  process.stdout.write('\r\x1b[K' + text);
}

export function statusClear(): void {
  if (!_statusText) return;
  _statusText = '';
  process.stdout.write('\r\x1b[K');
}

export const log = (...a: unknown[]): void => {
  if (_jsonlMode) return;
  statusClear();
  console.log(...a);
};

export function emit(event: string, data: Record<string, unknown>): void {
  if (_jsonlMode) console.log(JSON.stringify({ event, ...data }));
}

export const fmtSize = (bytes: number): string => bytes > 1e9
  ? (bytes / 1e9).toFixed(1) + ' GB'
  : (bytes / 1e6).toFixed(0) + ' MB';

export const pad = (s: unknown, n: number): string => String(s).padStart(n);
