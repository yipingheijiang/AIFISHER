// The local edition never contacts the former account/relay operator.
export function isRemovedServiceHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.+$/, '');
  return host === 'work-fisher.com' || host.endsWith('.work-fisher.com');
}

export function assertIndependentUrl(value) {
  const url = value instanceof URL ? value : new URL(value?.url ?? String(value));
  if (isRemovedServiceHost(url.hostname)) {
    const error = new Error('本地版已停用此服务地址，请配置独立供应商或本地服务。');
    error.code = 'REMOVED_SERVICE_URL';
    error.status = 400;
    throw error;
  }
  return url;
}
