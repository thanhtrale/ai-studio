import { describe, expect, it } from 'vitest';

import { parseArmManifestYaml } from './manifest-yaml.js';

// Verbatim from design.md - decision 3.
const RESIDENT_EXAMPLE = `
id: text-llamacpp-cu124
modality: text
protocol: openai
lifecycle: resident
resources: { gpu: exclusive, vramEstimateMb: 8000 }
launch:
  cwd: ./bin
  command: ./llama-server.exe
  args: ["-m", "{{model}}", "--host", "127.0.0.1", "--port", "{{port}}"]
health: { type: http, path: /health, timeoutMs: 120000 }
params: ./params.schema.json
`;

const ONESHOT_EXAMPLE = `
id: image-sdcpp-v03-cu121
modality: image
protocol: cli
lifecycle: oneshot
resources: { gpu: exclusive, vramEstimateMb: 6000 }
launch:
  cwd: ./bin
  command: ./sd.exe
  args: ["-m", "{{model}}", "-p", "{{prompt}}", "-o", "{{outPath}}"]
health: { type: none }
params: ./params.schema.json
`;

describe('arm manifest', () => {
  it('accepts the resident example from the design', () => {
    const result = parseArmManifestYaml(RESIDENT_EXAMPLE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.id).toBe('text-llamacpp-cu124');
    expect(result.manifest.protocol).toBe('openai');
    expect(result.manifest.lifecycle).toBe('resident');
    expect(result.manifest.resources.gpu).toBe('exclusive');
    expect(result.manifest.resources.vramEstimateMb).toBe(8000);
    expect(result.manifest.health).toEqual({ type: 'http', path: '/health', timeoutMs: 120000 });
  });

  it('accepts the one-shot example from the design', () => {
    const result = parseArmManifestYaml(ONESHOT_EXAMPLE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.id).toBe('image-sdcpp-v03-cu121');
    expect(result.manifest.protocol).toBe('cli');
    expect(result.manifest.lifecycle).toBe('oneshot');
    expect(result.manifest.launch.args).toContain('{{outPath}}');
  });

  it('reports the offending field when a required field is missing', () => {
    const result = parseArmManifestYaml(ONESHOT_EXAMPLE.replace('params: ./params.schema.json', ''));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContain('params');
  });

  it('rejects a protocol outside the supported set', () => {
    const result = parseArmManifestYaml(RESIDENT_EXAMPLE.replace('protocol: openai', 'protocol: telepathy'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContain('protocol');
  });

  it('rejects unknown top-level keys', () => {
    const result = parseArmManifestYaml(`${ONESHOT_EXAMPLE}\nshell: true\n`);

    expect(result.ok).toBe(false);
  });

  it('rejects malformed YAML without throwing', () => {
    const result = parseArmManifestYaml('id: [unterminated');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/invalid YAML/i);
  });

  describe('lifecycle rules', () => {
    it('requires an http health check for resident arms', () => {
      const result = parseArmManifestYaml(
        RESIDENT_EXAMPLE.replace('health: { type: http, path: /health, timeoutMs: 120000 }', 'health: { type: none }'),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.path)).toContain('health.type');
    });

    it('requires resident arms to accept an injected port', () => {
      const result = parseArmManifestYaml(RESIDENT_EXAMPLE.replace('"--port", "{{port}}"', '"--port", "8080"'));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.path)).toContain('launch.args');
    });

    it('allows one-shot arms to omit both health check and port', () => {
      const result = parseArmManifestYaml(`
id: image-sdcpp-minimal
modality: image
protocol: cli
lifecycle: oneshot
launch:
  command: ./sd.exe
  args: ["-p", "{{prompt}}"]
params: ./params.schema.json
`);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.manifest.health).toEqual({ type: 'none' });
      expect(result.manifest.resources.gpu).toBe('exclusive');
    });
  });
});
