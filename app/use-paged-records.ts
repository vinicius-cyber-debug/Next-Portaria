'use client';
import { useEffect, useState } from 'react';
import { request } from '../lib/http-client';
import type { PortalRecord } from './portal-types';

interface Page<T> {
  rows: T[];
  total: number;
  totalPages: number;
  page: number;
  error?: { message?: string };
}
export function usePagedRecords<T = PortalRecord>(
  collection: string,
  params: Record<string, unknown>,
  page = 1,
  pageSize = 20,
  revision = 0,
) {
  const [attempt, setAttempt] = useState(0),
    [result, setResult] = useState<{
      scope: string;
      data: Page<T>;
      loading: boolean;
      error: string;
    } | null>(null);
  const key = JSON.stringify(params),
    scope = JSON.stringify([collection, key, page, pageSize]);
  useEffect(() => {
    if (!collection) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      setResult((previous) => ({
        scope,
        data:
          previous?.scope === scope ? previous.data : { rows: [], total: 0, totalPages: 1, page },
        loading: true,
        error: '',
      }));
      async function read(index: number) {
        const search = new URLSearchParams({
          collection,
          page: String(index),
          pageSize: String(pageSize),
        });
        for (const [name, value] of Object.entries(JSON.parse(key) as Record<string, unknown>))
          if (value !== undefined && value !== null && value !== '')
            search.set(name, String(value));
        const response = await request('/api/records?' + search, {
            cache: 'no-store',
            signal: abort.signal,
          }),
          data = (await response.json()) as Page<T>;
        if (!response.ok)
          throw Error(data.error?.message || 'Não foi possível consultar os registros.');
        return data;
      }
      try {
        let data = await read(page);
        if (data.totalPages > 0 && page > data.totalPages) data = await read(data.totalPages);
        if (!abort.signal.aborted) setResult({ scope, data, loading: false, error: '' });
      } catch (error) {
        if (!abort.signal.aborted)
          setResult((previous) => ({
            scope,
            data:
              previous?.scope === scope
                ? previous.data
                : { rows: [], total: 0, totalPages: 1, page },
            loading: false,
            error: error instanceof Error ? error.message : 'Consulta indisponível.',
          }));
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [collection, key, page, pageSize, revision, attempt, scope]);
  const current = result?.scope === scope ? result : null;
  return {
    rows: current?.data.rows ?? [],
    total: current?.data.total ?? 0,
    totalPages: Math.max(1, current?.data.totalPages ?? 1),
    page: current?.data.page ?? page,
    loading: Boolean(collection) && (!current || current.loading),
    error: current?.error ?? '',
    retry: () => setAttempt((value) => value + 1),
  };
}
