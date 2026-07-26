// ONE way for a WS test to get a server, so no test is ever load-bearing on a process an agent
// happened to leave running.
//
// WHY THIS EXISTS. Four tests (test-3v3, test-builder-size, test-mode-format, test-vs-consistency)
// used to hardcode `process.env.PORT || 30xx` and simply connect, with a header comment telling you to
// start a server yourself. That produced BOTH failure directions in one night:
//   * FALSE RED — nothing was listening on :3013, so test-builder-size and test-mode-format were
//     reported as "pre-existing failures" for whole sessions when the code was fine.
//   * FALSE RED — :3015 held a server started BEFORE shared/wire.js was widened. Node does not
//     hot-reload ES modules, so that process kept encoding 12-byte wall records while the test's
//     freshly-imported decoder expected 15, and test-3v3 died on `RangeError: Offset is outside the
//     bounds of the DataView`. The bug was the process's age, not anyone's diff.
//   * FALSE GREEN, the dangerous one — test-vs-consistency passed against a server on :3014 that
//     predated the change it was cited as covering, so it "verified" a bot loadout generator that
//     process had never loaded. A stale server is worse than no server: no server fails loudly.
//
// So: default to booting our own on a REAL free port, and keep the external-server path for the times
// you actually want it (`PORT=3012 node test-3v3.mjs` to check the user's LAN surface, or URL=...).
// A test that self-boots also means `for f in test*.mjs` passes on a clean machine with nothing set up.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Ask the OS for a genuinely free port. test-party.mjs picked `3900 + pid%90` and a squatter on that
// port resurrects a false failure — do not repeat that.
const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

/**
 * Returns { url, port, own } — `own: false` means you asked for an external server, so nothing was
 * spawned and nothing will be killed. Any spawned child dies with this process.
 * @param {object} [env] extra env for the child (e.g. FOOTBALL_TOKEN_SECRET).
 */
export async function bootServer(env = {}) {
  // An explicit PORT or URL means "test THAT server" — the deliberate override, e.g. pointing a test
  // at the LAN surface on :3012 to prove the running game speaks the current wire format.
  if (process.env.URL) return { url: process.env.URL, port: null, own: false };
  if (process.env.PORT) return { url: `ws://localhost:${process.env.PORT}`, port: Number(process.env.PORT), own: false };

  const port = await freePort();
  const srv = spawn(process.execPath, [join(here, 'server.js')], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const kill = () => { try { srv.kill('SIGKILL'); } catch { /* already gone */ } };
  process.on('exit', kill);
  process.on('SIGINT', () => { kill(); process.exit(130); });

  // Wait for the LISTENER, not a fixed sleep — server.js prints the port once it is bound.
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`server did not start in 10s on :${port}`)), 10000);
    srv.stdout.on('data', (b) => { if (String(b).includes(String(port))) { clearTimeout(t); res(); } });
    srv.stderr.on('data', (b) => process.stderr.write(b));
    srv.on('exit', (code) => { clearTimeout(t); rej(new Error(`server exited early (code ${code})`)); });
  });
  return { url: `ws://localhost:${port}`, port, own: true };
}
