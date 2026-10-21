// Writes a value in .env: replaces the line NAME=… if there is one, else appends it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function setEnvValue(file, name, value) {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const line = new RegExp(`^${name}=.*$`, 'm');
  let next;
  if (line.test(current)) next = current.replace(line, () => `${name}=${value}`);
  else next = `${current}${current && !current.endsWith('\n') ? '\n' : ''}${name}=${value}\n`;
  writeFileSync(file, next, 'utf8');
  process.env[name] = value;
}
