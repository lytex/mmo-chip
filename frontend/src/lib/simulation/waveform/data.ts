import type { TransientDataset } from './types';

/**
 * Convert our WaveformTrace[] format to TransientDataset[] for the renderer.
 *
 * Our format: WaveformTrace { name, type, xValues, yValues }[]
 * Their format: TransientDataset { time, signals: Map<string, number[]>, label }
 */
export function normalizeWaveformTraces(
  traces: Array<{ name: string; type: string; xValues: number[]; yValues: number[] }>,
): TransientDataset[] {
  if (traces.length === 0) return [];

  // Find the time trace (type === 'time') or use the first trace's xValues as time
  const timeTrace = traces.find((t) => t.type === 'time');
  const time = timeTrace ? timeTrace.xValues : traces[0].xValues;

  // Build signals map from all non-time traces
  const signals = new Map<string, number[]>();
  for (const trace of traces) {
    if (trace.type === 'time') continue;
    signals.set(trace.name, trace.yValues);
  }

  return [{ time, signals, label: '' }];
}

/**
 * Legacy adapter: normalize data from @spice-ts/core TransientResult format.
 * This handles both TransientDataset[] and TransientResult-like objects.
 */
export function normalizeTransientData(
  data: unknown,
  signals: string[],
): TransientDataset[] {
  // Already TransientDataset[]
  if (Array.isArray(data)) return data as TransientDataset[];

  // TransientResult-like with voltage/current methods
  const resultLike = data as {
    time?: number[];
    voltage?: (node: string) => number[];
    current?: (source: string) => number[];
  };

  if (resultLike.time && typeof resultLike.voltage === 'function') {
    const signalMap = new Map<string, number[]>();
    for (const name of signals) {
      try {
        signalMap.set(name, resultLike.voltage(name));
      } catch {
        try {
          signalMap.set(name, resultLike.current!(name));
        } catch {
          /* skip */
        }
      }
    }
    return [{ time: resultLike.time, signals: signalMap, label: '' }];
  }

  throw new Error('Invalid data: expected TransientDataset[] or TransientResult-like object');
}
