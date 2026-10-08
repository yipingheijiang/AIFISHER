// Local repair: lifecycle-only diagnostics deliberately exclude tokens and payloads.
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export function installBackendLifecycleDiagnostics({ logsDirectory } = {}) {
  const file = logsDirectory ? path.join(logsDirectory, 'backend.lifecycle.log') : null;
  function record(event, reason) {
    if (!file) return;
    try {
      mkdirSync(logsDirectory, { recursive: true });
      appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...(reason ? { reason } : {}) }) + '\n');
    } catch { /* Diagnostics must not prevent startup or graceful shutdown. */ }
  }
  record('starting');
  process.once('exit', code => record('exit', String(code)));
  return { shutdownRequested(reason) { record('shutdown-requested', String(reason).slice(0, 100)); } };
}
