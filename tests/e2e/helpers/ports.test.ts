import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { freePort, httpStatus, pollUntil, waitForHttp, waitForPort } from './ports';

describe("ports and expectations bounded", () => {
  it("freePort gives a free port, waitForPort waits for a service to listen", async () => {
    const port = await freePort();
    assert.ok(port > 0);
    const server = createServer((_req, res) => res.end('ok'));
    const listening = new Promise<void>((resolve) => setImmediate(() => server.listen(port, '127.0.0.1', resolve)));
    await waitForPort(port, { timeout: 3000 });
    await listening;
    await waitForHttp(`http://127.0.0.1:${port}/`, { timeout: 3000 });
    assert.equal(await httpStatus(`http://127.0.0.1:${port}/`), 200);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(await httpStatus(`http://127.0.0.1:${port}/`, 500), 0);
  });

  it("Polluntil raises to exceedance and knows how to interrupt", async () => {
    await assert.rejects(pollUntil(() => false, { timeout: 80, interval: 10, label: 'x' }), /x non atteinte en 80 ms/);
    await assert.rejects(pollUntil(() => false, { timeout: 5000, interval: 10, abortIf: () => 'processus mort', label: 'svc' }), /svc interrompue : processus mort/);
    let n = 0;
    await pollUntil(() => ++n >= 3, { timeout: 1000, interval: 5 });
    assert.equal(n, 3);
  });
});
