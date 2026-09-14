/**
 * SPICE simulation types — shared between worker and main thread.
 */

export interface RealDataType {
  name: string;
  type: "voltage" | "current" | "time" | "frequency" | "notype";
  values: number[];
}

export interface ComplexDataType {
  name: string;
  type: "voltage" | "current" | "time" | "frequency" | "notype";
  values: Array<{ real: number; img: number }>;
}

interface BaseResult {
  header: string;
  numVariables: number;
  variableNames: string[];
  numPoints: number;
}

export interface RealResult extends BaseResult {
  dataType: "real";
  data: RealDataType[];
}

export interface ComplexResult extends BaseResult {
  dataType: "complex";
  data: ComplexDataType[];
}

export type SimulationResult = RealResult | ComplexResult;

export interface SimulationStatus {
  initialized: boolean;
  running: boolean;
  error: string | null;
}

/** API exposed by the Web Worker via Comlink. */
export interface SimulationWorkerAPI {
  init(): Promise<string>;
  run(netlist: string): Promise<SimulationResult>;
  getStatus(): SimulationStatus;
  getErrors(): string[];
  getInitInfo(): string;
}

/** Parsed waveform trace for the viewer. */
export interface WaveformTrace {
  name: string;
  type: "voltage" | "current" | "time" | "frequency" | "notype";
  xValues: number[];
  yValues: number[];
}

/** Directives that the user types in the editor. */
export interface SpiceDirectives {
  /** Raw ngspice directives (lines starting with .) plus source definitions. */
  text: string;
}

/** Result of a full simulation run including parsed waveforms. */
export interface SpiceSimulationOutput {
  raw: SimulationResult;
  waveforms: WaveformTrace[];
  errors: string[];
  durationMs: number;
}

// ── Spice Agent types ────────────────────────────────────────────

/** A single turn in the spice agent conversation. */
export interface SpiceAgentTurn {
  role: "user" | "agent";
  content: string;
  /** If agent generated directives for this turn. */
  directives?: string;
  /** If simulation was run for this turn. */
  simResult?: {
    ok: boolean;
    errors: string[];
    measurements?: Record<string, number>;
    variableNames?: string[];
    numPoints?: number;
  };
}

/** Request to the spice agent endpoint. */
export interface SpiceAgentRequest {
  netlist: string;
  prompt: string;
  history: Array<{ role: string; content: string; directives?: string; simResult?: SpiceAgentTurn["simResult"] }>;
  llmConfig?: { provider?: string; apiKey?: string; baseUrl?: string; model?: string };
}

/** Response from the spice agent endpoint. */
export interface SpiceAgentResponse {
  ok: boolean;
  content?: string;
  directives?: string;
  error?: string;
}
