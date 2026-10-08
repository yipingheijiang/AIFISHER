// Local repair for runtime files omitted from upstream bdcf3bec.
import http from 'node:http';

export function resolveListenTarget(environment = process.env) {
  const pipe = String(environment.AIFISHER_BACKEND_PIPE || '').trim();
  if (pipe) {
    if (!/^\\\\\.\\pipe\\aifisher-backend-[0-9a-f-]+$/u.test(pipe)) throw new Error('INVALID_BACKEND_PIPE');
    return { path: pipe };
  }
  const port = Number(environment.COLLAB_PORT || environment.SERVER_PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_BACKEND_PORT');
  return { host: '127.0.0.1', port };
}

export function describeListenTarget(target) {
  return target.path ? 'private named pipe' : `http://${target.host}:${target.port}`;
}

export function createLocalRuntimeLifecycle({ app, listen, workflowStore, writeProjectSnapshot, codexService, canvasExternalService, stopOwnedComfy } = {}) {
  let server;
  let starting;
  let stopping;
  let stopped = false;
  function start() {
    if (stopped) return Promise.resolve(false);
    starting ??= (async () => {
      await workflowStore?.init();
      if (stopped) return false;
      server = http.createServer(app);
      await new Promise((resolve, reject) => {
        const fail = error => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', fail); resolve(); };
        server.once('error', fail);
        server.once('listening', ready);
        server.listen(listen);
      });
      return true;
    })();
    return starting;
  }
  function stop() {
    stopped = true;
    stopping ??= (async () => {
      const errors = [];
      const attempt = async work => { try { await work(); } catch (error) { errors.push(error); } };
      await starting?.catch(() => {});
      // Stop accepting work, then release long polls before waiting for HTTP to drain.
      const drained = server?.listening
        ? new Promise(resolve => server.close(error => { if (error) errors.push(error); resolve(); }))
        : Promise.resolve();
      await attempt(() => canvasExternalService?.close());
      await attempt(() => codexService?.close());
      await attempt(() => stopOwnedComfy?.());
      await drained;
      if (workflowStore?.db && writeProjectSnapshot) {
        await attempt(async () => {
          for (const summary of await workflowStore.listWorkflows()) {
            const project = await workflowStore.getWorkflowById(summary.id);
            if (project) await writeProjectSnapshot(project);
          }
        });
      }
      await attempt(() => workflowStore?.close());
      if (errors.length) throw new AggregateError(errors, 'Backend shutdown did not finish cleanly');
    })();
    return stopping;
  }
  return { start, stop };
}
