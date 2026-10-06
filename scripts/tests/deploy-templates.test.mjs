// Tests for the service templates in deploy/ that the launcher tests don't cover.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const unit = fileURLToPath(new URL('../../deploy/systemd/oneloop.service.example', import.meta.url));

/** The value of `key` in `[section]` of a systemd unit, or undefined. */
function setting(text, section, key) {
  let current = null, value;
  for (const line of text.split('\n')) {
    const header = /^\[(\w+)\]$/.exec(line.trim());
    if (header) current = header[1];
    else if (current === section && line.startsWith(`${key}=`)) value = line.slice(key.length + 1).trim();
  }
  return value;
}
/** A systemd time span such as `5`, `30s`, `10min` or `1h`, in seconds. */
function seconds(span) {
  const match = /^(\d+)(s|min|h)?$/.exec(span);
  if (!match) throw new Error(`Unsupported time span ${span}`);
  return Number(match[1]) * {s: 1, min: 60, h: 3600}[match[2] ?? 's'];
}

// A missing or old database fails every start with exit code 1, which
// RestartPreventExitStatus=2 doesn't stop. Only the start limit ends the loop
// and marks the unit failed, so alerts on failed units notice.
test('the systemd unit stops restarting when every start fails', () => {
  const text = readFileSync(unit, 'utf8');
  const restart = seconds(setting(text, 'Service', 'RestartSec'));
  // systemd's defaults apply when the [Unit] section sets no start limit.
  const interval = seconds(setting(text, 'Unit', 'StartLimitIntervalSec') ?? '10s');
  const burst = Number(setting(text, 'Unit', 'StartLimitBurst') ?? 5);
  // Starts that fail at once come RestartSec apart; one start more than the
  // burst must fit in the interval.
  assert.ok(burst * restart < interval, `${burst} restarts ${restart} s apart don't fit in ${interval} s`);
});

