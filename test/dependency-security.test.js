import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { optimizeAvatarImage } from '../lib/avatar-image.js';

// Resolve the actual SDK dependencies, whether npm hoists them or nests them.
const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve('tiktok-live-api-sdk'));
const axios = sdkRequire('axios').default;
const redirects = createRequire(sdkRequire.resolve('axios'))('follow-redirects');

async function withRedirectServers(run) {
  const received = [];
  const target = http.createServer((request, response) => {
    received.push(request.headers);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true }));
  });
  const source = http.createServer((request, response) => {
    // A different hostname makes this a cross-host redirect; both are loopback.
    response.writeHead(302, { Location: `http://localhost:${target.address().port}/done` });
    response.end();
  });
  try {
    await new Promise(resolve => target.listen(0, resolve));
    await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
    await run(`http://127.0.0.1:${source.address().port}/start`, received);
  } finally {
    for (const server of [source, target]) server.closeAllConnections();
    await Promise.all([source, target].map(server => new Promise(resolve => server.close(resolve))));
  }
}

test('SDK Axios follows loopback redirects and strips cross-host Authorization', { timeout: 10000 }, async () => {
  await withRedirectServers(async (url, received) => {
    const response = await axios.get(url, {
      proxy: false, timeout: 3000,
      headers: { Authorization: 'fixture-only', 'X-Harmless': 'keep' }
    });
    assert.deepEqual(response.data, { ok: true });
    assert.equal(received.length, 1);
    assert.equal(received[0].authorization, undefined);
    assert.equal(received[0]['x-harmless'], 'keep');
  });
});

test('redirect dependency strips cross-realm custom sensitive headers', { timeout: 10000 }, async () => {
  await withRedirectServers(async (url, received) => {
    await new Promise((resolve, reject) => {
      const request = redirects.http.get(url, {
        headers: { 'X-Api-Key': 'fixture-only', 'X-Harmless': 'keep' },
        sensitiveHeaders: vm.runInNewContext("['X-Api-Key']")
      }, response => {
        response.resume();
        response.on('end', resolve);
        response.on('error', reject);
      });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('Loopback request timed out')));
    });
    assert.equal(received.length, 1);
    assert.equal(received[0]['x-api-key'], undefined);
    assert.equal(received[0]['x-harmless'], 'keep');
  });
});

test('avatar decoder preserves supported raster and SVG conversion after native updates', async () => {
  const inputs = [];
  for (const format of ['png', 'jpeg', 'webp', 'avif']) {
    inputs.push(await sharp({ create: { width: 320, height: 200, channels: 3, background: '#e33' } })
      .toFormat(format).toBuffer());
  }
  inputs.push(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="blue"/></svg>'));
  for (const input of inputs) {
    const result = await optimizeAvatarImage(input);
    const metadata = await sharp(result.data).metadata();
    assert.equal(result.mime, 'image/webp');
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, 128);
    assert.equal(metadata.height, 128);
    assert.ok(result.data.length <= 150 * 1024);
  }
});

test('avatar decoder rejects invalid and oversized input after native updates', async () => {
  await assert.rejects(() => optimizeAvatarImage(Buffer.from('invalid image')));
  await assert.rejects(() => optimizeAvatarImage(Buffer.alloc(1024 * 1024 + 1)), /size is invalid/);
});
