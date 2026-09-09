import { z } from 'zod';

export const ARM_MODALITIES = ['text', 'image', 'video', 'audio'] as const;
export const ARM_PROTOCOLS = ['native', 'openai', 'comfy', 'cli'] as const;
export const ARM_LIFECYCLES = ['resident', 'oneshot'] as const;
export const ARM_GPU_MODES = ['exclusive', 'none'] as const;

export type ArmModality = (typeof ARM_MODALITIES)[number];
export type ArmProtocol = (typeof ARM_PROTOCOLS)[number];
export type ArmLifecycle = (typeof ARM_LIFECYCLES)[number];
export type ArmGpuMode = (typeof ARM_GPU_MODES)[number];

/** Substituted by the supervisor with the loopback port it allocated. */
export const PORT_PLACEHOLDER = 'port';

const armIdSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/,
    'must be lowercase alphanumeric segments separated by "-" or "."',
  );

const launchSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const healthSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('none') }),
  z.strictObject({
    type: z.literal('http'),
    path: z.string().startsWith('/'),
    timeoutMs: z.number().int().positive(),
  }),
]);

const resourcesSchema = z.strictObject({
  gpu: z.enum(ARM_GPU_MODES).default('exclusive'),
  vramEstimateMb: z.number().int().positive().optional(),
  device: z.number().int().nonnegative().optional(),
});

const referencesPort = (args: readonly string[]): boolean =>
  args.some((arg) => arg.includes(`{{${PORT_PLACEHOLDER}}}`));

export const armManifestSchema = z
  .strictObject({
    id: armIdSchema,
    name: z.string().min(1).optional(),
    modality: z.enum(ARM_MODALITIES),
    protocol: z.enum(ARM_PROTOCOLS),
    lifecycle: z.enum(ARM_LIFECYCLES),
    resources: resourcesSchema.default({ gpu: 'exclusive' }),
    launch: launchSchema,
    health: healthSchema.default({ type: 'none' }),
    params: z.string().min(1),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.lifecycle !== 'resident') return;

    if (manifest.health.type !== 'http') {
      ctx.addIssue({
        code: 'custom',
        path: ['health', 'type'],
        message: 'resident arms must declare an http health check',
      });
    }

    if (!referencesPort(manifest.launch.args)) {
      ctx.addIssue({
        code: 'custom',
        path: ['launch', 'args'],
        message: `resident arms must accept an injected port via a {{${PORT_PLACEHOLDER}}} placeholder`,
      });
    }
  });

export type ArmManifest = z.infer<typeof armManifestSchema>;

export interface ManifestIssue {
  path: string;
  message: string;
}

export type ManifestParseResult =
  | { ok: true; manifest: ArmManifest }
  | { ok: false; issues: ManifestIssue[] };

export function parseArmManifest(input: unknown): ManifestParseResult {
  const result = armManifestSchema.safeParse(input);
  if (result.success) return { ok: true, manifest: result.data };

  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

export function formatManifestIssues(issues: readonly ManifestIssue[]): string {
  return issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join('; ');
}
