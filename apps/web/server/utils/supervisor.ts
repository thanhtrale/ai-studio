import type { ArmSummary, ControlErrorBody, ControlErrorCode, InventoryResponse } from '@ai-studio/arm-contract';

/**
 * Failure categories the browser is allowed to distinguish. The point of the
 * split is that "the supervisor is down" must never look like "the arm is
 * stopped".
 */
export type RelayErrorKind =
  | 'supervisor_unreachable'
  | 'arm_not_running'
  | 'arm_error'
  | 'invalid_request'
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'supervisor_error';

const KIND_BY_CODE: Record<ControlErrorCode, RelayErrorKind> = {
  unauthorized: 'unauthorized',
  not_found: 'not_found',
  invalid_request: 'invalid_request',
  invalid_manifest: 'invalid_request',
  invalid_params: 'invalid_request',
  eviction_failed: 'conflict',
  health_timeout: 'arm_error',
  launch_failed: 'arm_error',
  arm_not_running: 'arm_not_running',
  arm_error: 'arm_error',
  supervisor_unavailable: 'supervisor_unreachable',
  reconciling: 'conflict',
};

const STATUS_BY_KIND: Record<RelayErrorKind, number> = {
  supervisor_unreachable: 503,
  arm_not_running: 409,
  arm_error: 502,
  invalid_request: 400,
  unauthorized: 500,
  not_found: 404,
  conflict: 409,
  supervisor_error: 502,
};

export class RelayError extends Error {
  readonly kind: RelayErrorKind;
  readonly status: number;

  constructor(kind: RelayErrorKind, message: string) {
    super(message);
    this.name = 'RelayError';
    this.kind = kind;
    this.status = STATUS_BY_KIND[kind];
  }
}

export function classifyControlError(code: string, message: string): RelayError {
  const kind = KIND_BY_CODE[code as ControlErrorCode] ?? 'supervisor_error';
  return new RelayError(kind, message);
}

export interface SupervisorClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof globalThis.fetch;
}

export class SupervisorClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor({ baseUrl, token, fetchImpl }: SupervisorClientOptions) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#token = token;
    this.#fetch = fetchImpl ?? globalThis.fetch;
  }

  async #call<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${pathname}`, {
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${this.#token}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (error) {
      throw new RelayError(
        'supervisor_unreachable',
        `supervisor is not reachable at ${this.#baseUrl} (${(error as Error).message})`,
      );
    }

    const text = await response.text();
    const body: unknown = text ? JSON.parse(text) : {};

    if (!response.ok) {
      const failure = body as ControlErrorBody;
      throw classifyControlError(
        failure.error?.code ?? 'supervisor_error',
        failure.error?.message ?? `supervisor responded ${response.status}`,
      );
    }

    return body as T;
  }

  inventory(): Promise<InventoryResponse> {
    return this.#call<InventoryResponse>('/v1/arms');
  }

  start(armId: string, params: Record<string, unknown> = {}): Promise<{ arm: ArmSummary; evicted: string[] }> {
    return this.#call(`/v1/arms/${encodeURIComponent(armId)}/start`, {
      method: 'POST',
      body: JSON.stringify({ params }),
    });
  }

  stop(armId: string): Promise<{ arm: ArmSummary }> {
    return this.#call(`/v1/arms/${encodeURIComponent(armId)}/stop`, { method: 'POST' });
  }
}
