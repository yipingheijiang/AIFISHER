// Local repair for the HTTP fallback; Electron serves its UI through appProtocol.
import express from 'express';
import path from 'node:path';

export function serveCanvas(app, directory) {
  const root = path.resolve(directory);
  app.use(express.static(root));
  app.get('/{*path}', (request, response, next) => {
    if (path.extname(request.path)) return next();
    return response.sendFile(path.join(root, 'index.html'));
  });
}
