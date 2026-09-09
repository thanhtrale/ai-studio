import type { H3Event } from 'h3';

import { RelayError, SupervisorClient } from './supervisor';

export function supervisorClient(event: H3Event): SupervisorClient {
  const config = useRuntimeConfig(event);
  return new SupervisorClient({
    baseUrl: config.supervisorUrl,
    token: config.supervisorToken,
  });
}

/** Turns a relay failure into an HTTP error that keeps the failure kind intact. */
export async function relay<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RelayError) {
      throw createError({
        statusCode: error.status,
        statusMessage: error.kind,
        data: { kind: error.kind, message: error.message },
      });
    }
    throw error;
  }
}
