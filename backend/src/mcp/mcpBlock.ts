/**
 * Block extraction over an exported CDL netlist.
 *
 * The rule is deliberately rigid, matching the floorplan partition in the
 * SPICE tab: a net touched only by devices inside the block is internal; a net
 * that also touches a device outside is a port. No heuristics, no guessing.
 */

export type BlockDeviceKind = "R" | "C" | "Q" | "D";

export interface BlockDevice {
  name: string;
  kind: BlockDeviceKind;
  nets: string[];
  model: string;
  params: Record<string, string>;
  raw: string;
}

export interface BlockSubcircuit {
  subckt: string;
  ports: string[];
  internalNets: string[];
  selectedNames: string[];
  missingNames: string[];
  deviceCount: number;
}

function parseDevice(line: string): BlockDevice | null {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return null;
  const name = tokens[0];
  const letter = name[0]?.toUpperCase();
  const kind = letter === "R" || letter === "C" || letter === "Q" || letter === "D" ? letter : null;
  if (!kind) return null;
  const netCount = kind === "Q" ? 3 : 2;
  if (tokens.length < netCount + 2) return null;
  const nets = tokens.slice(1, 1 + netCount);
  const model = tokens[1 + netCount] ?? "";
  const params: Record<string, string> = {};
  for (const token of tokens.slice(2 + netCount)) {
    const eq = token.indexOf("=");
    if (eq > 0) params[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return { name, kind, nets, model, params, raw: line.trim() };
}

/** Parse device lines; directives, comments and `.SUBCKT` wrappers are ignored. */
export function parseCdlDevices(text: string): BlockDevice[] {
  const devices: BlockDevice[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("*") || trimmed.startsWith(".")) continue;
    const device = parseDevice(trimmed);
    if (device) devices.push(device);
  }
  return devices;
}

function paramText(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function emitDevice(device: BlockDevice): string {
  const nets = device.nets.join(" ");
  if (device.kind === "R") {
    const value = device.params.r ?? device.params.R ?? (/^[0-9.]+(?:[a-zA-Z]+)?$/.test(device.model) ? device.model : "1k");
    return `${device.name} ${nets} ${value}`;
  }
  if (device.kind === "C") {
    const value = device.params.c ?? device.params.C ?? (/^[0-9.]+(?:[a-zA-Z]+)?$/.test(device.model) ? device.model : "1p");
    return `${device.name} ${nets} ${value}`;
  }
  const params = paramText(device.params);
  return [device.name, nets, device.model, params].filter(Boolean).join(" ");
}

function safeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) && cleaned ? cleaned : `block_${cleaned || "x"}`;
}

/**
 * Build a `.SUBCKT` for the selected device instance names.
 *
 * `ports` is sorted alphabetically. `internalNets` is every other net touched
 * by the selection. A selected name absent from the netlist is reported in
 * `missingNames` (the caller decides whether that is fatal).
 */
export function buildBlockSubcircuit(
  devices: BlockDevice[],
  selectedNames: Iterable<string>,
  blockName: string
): BlockSubcircuit {
  const byName = new Map(devices.map((device) => [device.name, device]));
  const wanted = [...new Set(selectedNames)];
  const selected: BlockDevice[] = [];
  const missingNames: string[] = [];
  for (const name of wanted) {
    const device = byName.get(name);
    if (device) selected.push(device);
    else missingNames.push(name);
  }

  const selectedSet = new Set(selected.map((device) => device.name));
  const inside = new Set<string>();
  const outside = new Set<string>();
  for (const device of devices) {
    const target = selectedSet.has(device.name) ? inside : outside;
    for (const net of device.nets) target.add(net);
  }
  const ports = [...inside].filter((net) => outside.has(net)).sort();
  const portSet = new Set(ports);
  const internalNets = [...inside].filter((net) => !portSet.has(net)).sort();

  const name = safeName(blockName);
  const lines = [`.SUBCKT ${name} ${ports.join(" ")}`.trim()];
  for (const device of selected) lines.push(`  ${emitDevice(device)}`);
  lines.push(`.ENDS ${name}`);
  return {
    subckt: lines.join("\n"),
    ports,
    internalNets,
    selectedNames: selected.map((device) => device.name),
    missingNames,
    deviceCount: selected.length
  };
}

/** Models referenced by the selection, for the default `.MODEL` cards. */
export function selectedModels(devices: BlockDevice[], selectedNames: Iterable<string>): string[] {
  const wanted = new Set(selectedNames);
  return [
    ...new Set(
      devices
        .filter((device) => wanted.has(device.name))
        .filter((device) => device.kind === "Q" || device.kind === "D")
        .map((device) => device.model.toLowerCase())
    )
  ];
}
