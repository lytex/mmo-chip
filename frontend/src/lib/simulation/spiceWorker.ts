/**
 * Web Worker for running ngspice simulations via eecircuit-engine (WASM).
 *
 * Pattern taken from jwt625/WebSpice — Simulation class runs synchronously
 * inside the worker, Comlink exposes async methods to the main thread.
 */

import { Simulation } from "eecircuit-engine";
import * as Comlink from "comlink";
import type { SimulationResult, SimulationStatus, SimulationWorkerAPI } from "./types";

class SpiceSimulationWorker implements SimulationWorkerAPI {
  private sim: Simulation | null = null;
  private initialized = false;
  private running = false;
  private lastError: string | null = null;
  private errors: string[] = [];
  private initInfo = "";

  async init(): Promise<string> {
    if (this.initialized) return this.initInfo;

    this.sim = new Simulation();
    await this.sim.start();
    this.initialized = true;
    this.lastError = null;
    this.initInfo = this.sim.getInitInfo();
    return this.initInfo;
  }

  async run(netlist: string): Promise<SimulationResult> {
    if (!this.sim || !this.initialized) {
      throw new Error("Simulation engine not initialized. Call init() first.");
    }
    if (this.running) {
      throw new Error("Simulation already running.");
    }

    this.running = true;
    this.errors = [];
    this.lastError = null;

    try {
      this.sim.setNetList(netlist);
      const result = await this.sim.runSim();

      this.errors = this.sim.getError();
      return result as SimulationResult;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.errors = this.sim.getError();
      throw err;
    } finally {
      this.running = false;
    }
  }

  getStatus(): SimulationStatus {
    return {
      initialized: this.initialized,
      running: this.running,
      error: this.lastError,
    };
  }

  getErrors(): string[] {
    return this.errors;
  }

  getInitInfo(): string {
    return this.initInfo;
  }
}

Comlink.expose(new SpiceSimulationWorker());
