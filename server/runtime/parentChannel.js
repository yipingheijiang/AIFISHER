// Local repair for runtime files omitted from upstream bdcf3bec.

export function createParentChannel({ parentPort = process.parentPort, ipc = process } = {}) {
  const stopListeners = new Set();
  function send(message) {
    if (parentPort) parentPort.postMessage(message);
    else if (ipc.connected && typeof ipc.send === 'function') ipc.send(message);
    else return false;
    return true;
  }
  function receive(event) {
    const message = parentPort ? event?.data : event;
    if (message?.type === 'stop') {
      for (const listener of stopListeners) listener();

    }
  }
  if (parentPort) parentPort.on('message', receive);
  else ipc.on('message', receive);
  return {
    notifyReady() { send({ type: 'ready' }); },
    onStop(listener) { stopListeners.add(listener); return () => stopListeners.delete(listener); },
  };
}
