'use client';
import { useEffect, useState } from 'react';
import type { ConnectionAlert } from '@acm/core/contracts';
import { apiRequest, ApiRequestError } from './api-request';
import { ConnectionAlertBanner } from './connection-alert-banner';

export function AdminConnectionNotice({ csrfToken, initial }: { csrfToken: string; initial: ConnectionAlert[] }) {
  const [alerts, setAlerts] = useState(initial);
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false, pending = false;
    const refresh = async () => {
      if (stopped || pending || document.hidden) return;
      pending = true;
      try {
        const result = await apiRequest<{ items: ConnectionAlert[] }>('/api/admin/connection-alerts', csrfToken, 'GET', undefined, controller.signal);
        if (!stopped) setAlerts(result.items);
      } catch (error) {
        if (!stopped && error instanceof ApiRequestError && [401, 403].includes(error.status ?? 0)) { setAlerts([]); stopped = true; }
      } finally { pending = false; }
    };
    const onVisibility = () => { if (!document.hidden) void refresh(); };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stopped = true; controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [csrfToken]);
  return <ConnectionAlertBanner items={alerts} className="mb-6" />;
}
