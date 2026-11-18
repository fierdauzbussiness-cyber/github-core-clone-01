// main.ts — entrypoint: the trial lifecycle. Binds an ephemeral port, tells
// the environment where the forge listens, then waits until the harness
// reports the trial is done and exits 0. Node stdlib only.
import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL;

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<number> {
  if (!ENV_URL) {
    console.error('MAKEFUN_ENV_URL is not set');
    return 1;
  }
  const app = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', () => {
      const addr = app.server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('could not determine listen port'));
    });
  });
  console.log(`github-core-clone-01 forge listening on 127.0.0.1:${port}`);
  const registerUrl = `${ENV_URL.replace(/\/$/, '')}/register`;
  const res = await postJson(registerUrl, { port });
  if (!res.ok) {
    console.error(`register failed: HTTP ${res.status}`);
    app.server.close();
    return 1;
  }
  const doneUrl = `${ENV_URL.replace(/\/$/, '')}/done`;
  for (;;) {
    await sleep(500);
    try {
      const state = (await getJson(doneUrl)) as { done?: boolean };
      if (state.done === true) break;
    } catch {
      // The environment may not be ready yet; keep polling.
    }
  }
  console.log('trial done, shutting down');
  app.server.close();
  return 0;
}

process.exitCode = await main();
