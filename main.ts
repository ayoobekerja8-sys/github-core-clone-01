import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (!envUrl) {
  process.stderr.write('MAKEFUN_ENV_URL is not set\n');
  process.exit(1);
}

const timeoutMs = 30_000;
const firstPauseMs = 250;
const longestPauseMs = 8_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryPause(failures: number): number {
  return Math.min(longestPauseMs, firstPauseMs * 2 ** Math.min(failures, 12));
}

async function register(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok || response.status === 409) return;
    } catch {
      // The environment may still be coming up; retry registration.
    }
    await pause(retryPause(failures));
  }
}

async function waitUntilDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        const status: unknown = await response.json();
        if (typeof status === 'object' && status !== null && 'done' in status && status.done === true) return;
      }
    } catch {
      // A bad response or timeout is another incomplete poll.
    }
    await pause(retryPause(failures));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, resolve);
  });

  const bound = server.address();
  if (bound === null || typeof bound === 'string') throw new Error('No TCP port was assigned');

  await register(bound.port);
  await waitUntilDone();

  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

try {
  await main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
