import { z } from 'zod';

export const PROBE_PROTOCOL_VERSION = 1 as const;

export type ProbeCapability =
  | 'gpu.query'
  | 'gpu.processes'
  | 'ram.procfs'
  | 'disk.statvfs'
  | 'cpu.loadavg'
  | 'temperature.thermal'
  | 'command.kill'
  | 'command.diskScan'
  | 'command.stop';

export type ProbeMetricName =
  | 'gpu'
  | 'gpu.processes'
  | 'ram'
  | 'swap'
  | 'disk'
  | 'cpu'
  | 'temperature';

export interface ProbeHello {
  readonly type: 'HELLO';
  readonly protocol: 1;
  readonly bootId: string;
  readonly vmBootId: string;
  readonly pid: number;
  readonly python: string;
  readonly startedAtMs: number;
  readonly sampleIntervalMs: number;
  readonly probeDir: string;
  readonly metricsFile: string;
  readonly capabilities: readonly ProbeCapability[];
}

export interface ProbeSample {
  readonly type: 'SAMPLE';
  readonly protocol: 1;
  readonly bootId: string;
  readonly seq: number;
  readonly timestampMs: number;
  readonly intervalMs: number;
  readonly metrics: ProbeMetrics;
  readonly errors: readonly ProbeError[];
}

export interface ProbeMetrics {
  readonly gpu: GpuGroup;
  readonly ram: RamMetrics;
  readonly swap: SwapMetrics | null;
  readonly disk: DiskMetrics;
  readonly cpu: CpuMetrics;
  readonly temperature: TemperatureMetrics;
}

export interface GpuGroup {
  readonly present: boolean;
  readonly source: 'nvidia-smi' | 'procfs' | 'none';
  readonly gpus: readonly GpuMetrics[];
  readonly processes: readonly GpuProcess[];
}

export interface GpuMetrics {
  readonly index: number;
  readonly name: string;
  readonly utilizationPct: number | null;
  readonly memoryUsedBytes: number | null;
  readonly memoryTotalBytes: number | null;
  readonly memoryPeakBytes: number | null;
  readonly temperatureC: number | null;
  readonly powerWatts: number | null;
}

export interface GpuProcess {
  readonly pid: number;
  readonly name: string;
  readonly command: string | null;
  readonly usedMemoryBytes: number | null;
  readonly gpuUuid: string | null;
}

export interface RamMetrics {
  readonly totalBytes: number;
  readonly availableBytes: number;
  readonly usedBytes: number;
  readonly source: 'procfs' | 'psutil';
}

export interface SwapMetrics {
  readonly totalBytes: number;
  readonly freeBytes: number;
}

export interface DiskMetrics {
  readonly path: string;
  readonly totalBytes: number;
  readonly freeBytes: number;
  readonly usedBytes: number;
  readonly source: 'statvfs';
}

export interface CpuMetrics {
  readonly count: number;
  readonly load1: number;
  readonly load5: number;
  readonly load15: number;
}

export interface TemperatureMetrics {
  readonly cpuC: number | null;
  readonly gpuC: number | null;
  readonly source: 'thermal_zone' | 'hwmon' | 'nvidia-smi' | 'none';
}

export interface ProbeError {
  readonly metric: ProbeMetricName;
  readonly message: string;
  readonly recoverable: boolean;
}

export interface ProbeStatus {
  readonly protocol: 1;
  readonly bootId: string;
  readonly vmBootId: string;
  readonly pid: number;
  readonly python: string;
  readonly startedAtMs: number;
  readonly serverNowMs: number;
  readonly lastSampleAtMs: number;
  readonly seq: number;
  readonly sampleIntervalMs: number;
  readonly probeDir: string;
  readonly metricsFile: string;
  readonly state: 'running' | 'stopping' | 'error';
  readonly capabilities: readonly ProbeCapability[];
}

export type ProbeCommand =
  | {
      readonly type: 'LIST_GPU_PROCESSES';
      readonly protocol: 1;
      readonly requestId: string;
      readonly issuedAtMs: number;
    }
  | {
      readonly type: 'KILL_PROCESS';
      readonly protocol: 1;
      readonly requestId: string;
      readonly issuedAtMs: number;
      readonly pid: number;
    }
  | {
      readonly type: 'SCAN_DISK';
      readonly protocol: 1;
      readonly requestId: string;
      readonly issuedAtMs: number;
      readonly path: string;
      readonly maxEntries: number;
      readonly maxDepth: number;
    }
  | {
      readonly type: 'GET_PROBE_STATUS';
      readonly protocol: 1;
      readonly requestId: string;
      readonly issuedAtMs: number;
    }
  | {
      readonly type: 'STOP';
      readonly protocol: 1;
      readonly requestId: string;
      readonly issuedAtMs: number;
    };

export interface DiskEntry {
  readonly path: string;
  readonly bytes: number;
  readonly kind: 'file' | 'directory';
}

export type ProbeCommandResultPayload =
  | {
      readonly kind: 'LIST_GPU_PROCESSES';
      readonly processes: readonly GpuProcess[];
      readonly source: 'nvidia-smi' | 'procfs' | 'none';
      readonly errors: readonly ProbeError[];
    }
  | {
      readonly kind: 'KILL_PROCESS';
      readonly pid: number;
      readonly killed: boolean;
      readonly alreadyDead: boolean;
      readonly verified: boolean;
    }
  | {
      readonly kind: 'SCAN_DISK';
      readonly path: string;
      readonly entries: readonly DiskEntry[];
      readonly truncated: boolean;
    }
  | {
      readonly kind: 'GET_PROBE_STATUS';
      readonly status: ProbeStatus;
    }
  | {
      readonly kind: 'STOP';
    };

export interface ProbeCommandResult {
  readonly type: 'COMMAND_RESULT';
  readonly protocol: 1;
  readonly bootId: string;
  readonly requestId: string;
  readonly ok: boolean;
  readonly result: ProbeCommandResultPayload | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface ProbeBye {
  readonly type: 'BYE';
  readonly protocol: 1;
  readonly bootId: string;
  readonly reason: 'stop' | 'signal' | 'error';
  readonly message: string | null;
}

export type ProbeMessage = ProbeHello | ProbeSample | ProbeCommandResult | ProbeBye;

const byteCount = z.number().int().nonnegative();
const nullableByteCount = byteCount.nullable();
const nullableNumber = z.number().nullable();
const errorObject = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export const probeErrorSchema = z
  .object({
    metric: z.enum(['gpu', 'gpu.processes', 'ram', 'swap', 'disk', 'cpu', 'temperature']),
    message: z.string().min(1),
    recoverable: z.boolean(),
  })
  .strict();

export const gpuProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    name: z.string(),
    command: z.string().nullable(),
    usedMemoryBytes: nullableByteCount,
    gpuUuid: z.string().nullable(),
  })
  .strict();

export const gpuMetricsSchema = z
  .object({
    index: z.number().int().nonnegative(),
    name: z.string().min(1),
    utilizationPct: z.number().min(0).max(100).nullable(),
    memoryUsedBytes: nullableByteCount,
    memoryTotalBytes: nullableByteCount,
    memoryPeakBytes: nullableByteCount,
    temperatureC: nullableNumber,
    powerWatts: nullableNumber,
  })
  .strict();

export const gpuGroupSchema = z
  .object({
    present: z.boolean(),
    source: z.enum(['nvidia-smi', 'procfs', 'none']),
    gpus: z.array(gpuMetricsSchema),
    processes: z.array(gpuProcessSchema),
  })
  .strict();

export const ramMetricsSchema = z
  .object({
    totalBytes: byteCount,
    availableBytes: byteCount,
    usedBytes: byteCount,
    source: z.enum(['procfs', 'psutil']),
  })
  .strict();

export const swapMetricsSchema = z
  .object({
    totalBytes: byteCount,
    freeBytes: byteCount,
  })
  .strict();

export const diskMetricsSchema = z
  .object({
    path: z.string().min(1),
    totalBytes: byteCount,
    freeBytes: byteCount,
    usedBytes: byteCount,
    source: z.literal('statvfs'),
  })
  .strict();

export const cpuMetricsSchema = z
  .object({
    count: z.number().int().positive(),
    load1: z.number().nonnegative(),
    load5: z.number().nonnegative(),
    load15: z.number().nonnegative(),
  })
  .strict();

export const temperatureMetricsSchema = z
  .object({
    cpuC: nullableNumber,
    gpuC: nullableNumber,
    source: z.enum(['thermal_zone', 'hwmon', 'nvidia-smi', 'none']),
  })
  .strict();

export const probeMetricsSchema = z
  .object({
    gpu: gpuGroupSchema,
    ram: ramMetricsSchema,
    swap: swapMetricsSchema.nullable(),
    disk: diskMetricsSchema,
    cpu: cpuMetricsSchema,
    temperature: temperatureMetricsSchema,
  })
  .strict();

export const probeSampleSchema = z
  .object({
    type: z.literal('SAMPLE'),
    protocol: z.literal(1),
    bootId: z.string().min(1),
    seq: z.number().int().positive(),
    timestampMs: z.number().int().nonnegative(),
    intervalMs: z.number().int().min(1000).max(60_000),
    metrics: probeMetricsSchema,
    errors: z.array(probeErrorSchema),
  })
  .strict();

export const probeHelloSchema = z
  .object({
    type: z.literal('HELLO'),
    protocol: z.literal(1),
    bootId: z.string().min(1),
    vmBootId: z.string().min(1),
    pid: z.number().int().positive(),
    python: z.string().min(1),
    startedAtMs: z.number().int().nonnegative(),
    sampleIntervalMs: z.number().int().min(1000).max(60_000),
    probeDir: z.string().min(1),
    metricsFile: z.string().min(1),
    capabilities: z.array(
      z.enum([
        'gpu.query',
        'gpu.processes',
        'ram.procfs',
        'disk.statvfs',
        'cpu.loadavg',
        'temperature.thermal',
        'command.kill',
        'command.diskScan',
        'command.stop',
      ]),
    ),
  })
  .strict();

export const probeStatusSchema = z
  .object({
    protocol: z.literal(1),
    bootId: z.string().min(1),
    vmBootId: z.string().min(1),
    pid: z.number().int().positive(),
    python: z.string().min(1),
    startedAtMs: z.number().int().nonnegative(),
    serverNowMs: z.number().int().nonnegative(),
    lastSampleAtMs: z.number().int().nonnegative(),
    seq: z.number().int().nonnegative(),
    sampleIntervalMs: z.number().int().min(1000).max(60_000),
    probeDir: z.string().min(1),
    metricsFile: z.string().min(1),
    state: z.enum(['running', 'stopping', 'error']),
    capabilities: z.array(
      z.enum([
        'gpu.query',
        'gpu.processes',
        'ram.procfs',
        'disk.statvfs',
        'cpu.loadavg',
        'temperature.thermal',
        'command.kill',
        'command.diskScan',
        'command.stop',
      ]),
    ),
  })
  .strict();

export const diskEntrySchema = z
  .object({
    path: z.string().min(1),
    bytes: byteCount,
    kind: z.enum(['file', 'directory']),
  })
  .strict();

export const probeCommandResultPayloadSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('LIST_GPU_PROCESSES'),
      processes: z.array(gpuProcessSchema),
      source: z.enum(['nvidia-smi', 'procfs', 'none']),
      errors: z.array(probeErrorSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal('KILL_PROCESS'),
      pid: z.number().int().positive(),
      killed: z.boolean(),
      alreadyDead: z.boolean(),
      verified: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('SCAN_DISK'),
      path: z.string().min(1),
      entries: z.array(diskEntrySchema),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('GET_PROBE_STATUS'),
      status: probeStatusSchema,
    })
    .strict(),
  z.object({ kind: z.literal('STOP') }).strict(),
]);

export const probeCommandResultSchema = z
  .object({
    type: z.literal('COMMAND_RESULT'),
    protocol: z.literal(1),
    bootId: z.string().min(1),
    requestId: z.string().min(1),
    ok: z.boolean(),
    result: probeCommandResultPayloadSchema.nullable(),
    error: errorObject.nullable(),
  })
  .strict();

export const probeByeSchema = z
  .object({
    type: z.literal('BYE'),
    protocol: z.literal(1),
    bootId: z.string().min(1),
    reason: z.enum(['stop', 'signal', 'error']),
    message: z.string().nullable(),
  })
  .strict();

export const probeMessageSchema = z.discriminatedUnion('type', [
  probeHelloSchema,
  probeSampleSchema,
  probeCommandResultSchema,
  probeByeSchema,
]);

export const probeCommandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('LIST_GPU_PROCESSES'),
      protocol: z.literal(1),
      requestId: z.string().min(1),
      issuedAtMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('KILL_PROCESS'),
      protocol: z.literal(1),
      requestId: z.string().min(1),
      issuedAtMs: z.number().int().nonnegative(),
      pid: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('SCAN_DISK'),
      protocol: z.literal(1),
      requestId: z.string().min(1),
      issuedAtMs: z.number().int().nonnegative(),
      path: z.string().min(1),
      maxEntries: z.number().int().min(1).max(1000),
      maxDepth: z.number().int().min(0).max(16),
    })
    .strict(),
  z
    .object({
      type: z.literal('GET_PROBE_STATUS'),
      protocol: z.literal(1),
      requestId: z.string().min(1),
      issuedAtMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('STOP'),
      protocol: z.literal(1),
      requestId: z.string().min(1),
      issuedAtMs: z.number().int().nonnegative(),
    })
    .strict(),
]);

export const PROBE_CAPABILITIES: readonly ProbeCapability[] = [
  'gpu.query',
  'gpu.processes',
  'ram.procfs',
  'disk.statvfs',
  'cpu.loadavg',
  'temperature.thermal',
  'command.kill',
  'command.diskScan',
  'command.stop',
];
