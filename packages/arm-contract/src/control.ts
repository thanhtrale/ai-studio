import { z } from 'zod';

import type { ArmGpuMode, ArmLifecycle, ArmModality, ArmProtocol } from './manifest.js';
import type { ParamsSchema } from './params.js';
import type { LaunchValue } from './substitute.js';

export const ARM_STATES = ['stopped', 'starting', 'running', 'stopping', 'failed', 'invalid'] as const;
export type ArmState = (typeof ARM_STATES)[number];

/**
 * Browser-facing view of an arm. Deliberately carries no port or address:
 * clients reach arms only through the web application's server side.
 */
export interface ArmSummary {
  id: string;
  name: string;
  modality: ArmModality | null;
  protocol: ArmProtocol | null;
  lifecycle: ArmLifecycle | null;
  gpu: ArmGpuMode | null;
  vramEstimateMb: number | null;
  state: ArmState;
  /** Failure reason, or the manifest validation error when state is `invalid`. */
  detail: string | null;
  /**
   * The resolved parameters a running arm was launched with, or null when it is
   * not running -- or was adopted after a supervisor restart, which is why the
   * broker reloads such an arm rather than assume it matches.
   */
  startedWith: Record<string, LaunchValue> | null;
  paramsSchema: ParamsSchema | null;
  updatedAt: string;
}

export interface InventoryResponse {
  arms: ArmSummary[];
  /** False while startup reconciliation is still running. */
  ready: boolean;
}

/**
 * Strict on purpose: a caller cannot smuggle a command, argument list,
 * working directory, or environment into a launch.
 */
export const startArmRequestSchema = z.strictObject({
  params: z.record(z.string(), z.unknown()).default({}),
});

export type StartArmRequest = z.infer<typeof startArmRequestSchema>;

/**
 * A job, plus the configuration the arm has to be in to run it.
 *
 * The two travel together because the caller never starts an arm: it says what
 * it needs and the supervisor brokers the card into that state. `job` is opaque
 * here on purpose -- its schema belongs to the arm, and the supervisor
 * deliberately knows nothing about modality-specific payloads.
 */
export const jobRequestSchema = z.strictObject({
  jobId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, 'must be a plain identifier'),
  params: z.record(z.string(), z.unknown()).default({}),
  job: z.record(z.string(), z.unknown()),
});

export type JobRequest = z.infer<typeof jobRequestSchema>;

export interface StartArmResponse {
  arm: ArmSummary;
  /** Arms stopped to free the exclusive GPU slot for this one. */
  evicted: string[];
}

export interface StopArmResponse {
  arm: ArmSummary;
}

export const CONTROL_ERROR_CODES = [
  'unauthorized',
  'not_found',
  'invalid_request',
  'invalid_manifest',
  'invalid_params',
  'eviction_failed',
  'health_timeout',
  'launch_failed',
  'arm_not_running',
  'arm_error',
  'supervisor_unavailable',
  'reconciling',
] as const;

export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

export interface ControlErrorBody {
  error: {
    code: ControlErrorCode;
    message: string;
  };
}

export const AUTHORIZATION_SCHEME = 'Bearer';
