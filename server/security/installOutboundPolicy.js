// Loaded before provider modules, including those that capture fetch at module evaluation.
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import { Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { assertIndependentUrl } from './offlinePolicy.js';

const installed = Symbol.for('aifisher.localOutboundPolicy');
export function checkOutbound(value) {
  let url;
  let error;
  try {
    url = value instanceof URL ? value : new URL(value?.url ?? String(value));
    assertIndependentUrl(url);
    if (process.env.AIFISHER_OFFLINE_TEST === '1'
      && ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      error = Object.assign(new Error('Offline verification: outbound network refused'), { code: 'OFFLINE_TEST' });
    }
  } catch (caught) { error = caught; }
  // Audit only hostname/protocol; never log paths, queries, credentials or request bodies.
  if (process.env.AIFISHER_NETWORK_AUDIT_FILE && url) {
    appendFileSync(process.env.AIFISHER_NETWORK_AUDIT_FILE, JSON.stringify({
      process: process.type || 'node', protocol: url.protocol, host: url.hostname,
      blocked: Boolean(error), code: error?.code || null,
    }) + '\n');
  }
  if (error) throw error;
  return url;
}

if (!globalThis[installed]) {
  globalThis[installed] = true;
  const upstream = getGlobalDispatcher();
  class IndependentDispatcher extends Dispatcher {
    dispatch(options, handler) {
      try { checkOutbound(options.origin); }
      catch (error) { queueMicrotask(() => handler.onError(error)); return false; }
      return upstream.dispatch(options, handler);
    }
    close(...args) { return upstream.close(...args); }
    destroy(...args) { return upstream.destroy(...args); }
  }
  setGlobalDispatcher(new IndependentDispatcher());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    checkOutbound(input);
    // A supplied dispatcher could bypass the global dispatcher. Wrap that too.
    if (init?.dispatcher) {
      const dispatcher = init.dispatcher;
      init = { ...init, dispatcher: { dispatch(options, handler) {
        try { checkOutbound(options.origin); }
        catch (error) { queueMicrotask(() => handler.onError(error)); return false; }
        return dispatcher.dispatch(options, handler);
      } } };
    }
    return originalFetch(input, init);
  };
  for (const [transport, protocol] of [[http, 'http:'], [https, 'https:']]) {
    for (const name of ['request', 'get']) {
      const original = transport[name];
      transport[name] = function (...args) {
        const first = args[0];
        const options = typeof first === 'object' && !(first instanceof URL) ? first : args[1];
        if (typeof first === 'string' || first instanceof URL) checkOutbound(first);
        if (options && typeof options === 'object' && (options.hostname || options.host)) {
          const rawHost = String(options.hostname || options.host);
          const host = rawHost.includes(':') && !rawHost.startsWith('[')
            && (rawHost.split(':').length > 2) ? `[${rawHost}]` : rawHost;
          checkOutbound(`${options.protocol || protocol}//${host}`);
        }
        return original.apply(this, args);
      };
    }
  }
  syncBuiltinESMExports();
}
