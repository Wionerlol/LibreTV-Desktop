const { createServer } = require('node:http');

async function probeAlternatePort(url) {
  try {
    const response = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(3500),
    });
    await response.body?.cancel();
    return { settled: true, status: response.status };
  } catch (error) {
    return { settled: error.name !== 'TimeoutError' && error.name !== 'AbortError', status: 0 };
  }
}

async function observeCanary(window, log) {
  const metrics = { controlRequests: 0, rendererRequests: 0, credentialHeaders: 0 };
  const server = createServer((request, response) => {
    if (request.url === '/controller') metrics.controlRequests++;
    else metrics.rendererRequests++;
    if (Object.keys(request.headers).some((name) => (
      name === 'cookie' || name === 'authorization' || name.startsWith('x-libretv-')
    ))) metrics.credentialHeaders++;
    response.writeHead(204, { Connection: 'close' }).end();
  });
  let status = 'FAIL';
  let code = 'CANARY_CONTROL_FAILED';
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const controller = await fetch(origin + '/controller', { signal: AbortSignal.timeout(2500) });
    if (controller.status === 204 && metrics.controlRequests === 1) {
      const result = await window.webContents.executeJavaScript(
        '(' + probeAlternatePort.toString() + ')(' + JSON.stringify(origin + '/renderer') + ')'
      );
      metrics.rendererHttpStatus = result.status;
      if (metrics.credentialHeaders > 0 || metrics.rendererRequests > 0) {
        code = 'CANARY_PRIVATE_PORT_REACHED';
      } else if (result.settled && (result.status === 0 || result.status === 403)) {
        status = 'PARTIAL';
        code = 'CANARY_CROSS_PORT_DENIED';
      } else {
        code = 'CANARY_RENDERER_RESULT_UNEXPECTED';
      }
    }
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      status = 'ENVIRONMENT_BLOCKED';
      code = 'CANARY_LOOPBACK_DENIED';
    }
  } finally {
    if (server.listening) {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
  }
  // This sample covers a private alternate port. Public redirects and post-crash takeover require separate evidence.
  log('integration-check', { name: 'credential-canary', status, code, metrics });
}

module.exports = { observeCanary };
