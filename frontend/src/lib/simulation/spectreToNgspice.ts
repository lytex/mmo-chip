/**
 * spectreToNgspice.ts — Convert Spectre-format netlist to valid ngspice SPICE.
 *
 * The extraction pipeline generates Spectre syntax by default:
 *   Q10 (Net_35 Net_35 GND 0) npn m=1.23
 *   R8 (ref Net_29) resistor r=4858
 *   D1 (Net_94 Net_95) diode
 *   .subckt bandgap (GND_1 net230 ref VCC GND)
 *
 * ngspice needs standard SPICE/CDL format:
 *   Q10 Net_35 Net_35 GND 0 npn_model m=1.23
 *   R8 ref Net_29 4858
 *   D1 Net_94 Net_95 d_model
 *   .subckt bandgap GND_1 net230 ref VCC GND
 *
 * This module also generates default .model cards for device types found in
 * the netlist, so the simulation can run without external model libraries.
 */

/** Default .model cards for generic devices. */
const DEFAULT_MODELS: Record<string, string> = {
  npn: ".MODEL npn NPN (BF=200 IS=1e-16 VAF=50)",
  pnp: ".MODEL pnp PNP (BF=100 IS=1e-16 VAF=50)",
  diode: ".MODEL diode D (IS=1e-14 N=1)",
  nmos: ".MODEL nmos NMOS (VTO=0.7 KP=1e-4 LAMBDA=0.1)",
  pmos: ".MODEL pmos PMOS (VTO=-0.7 KP=1e-4 LAMBDA=0.1)",
  njf: ".MODEL njf NJF (VTO=-2 BETA=1e-3)",
  pjf: ".MODEL pjf PJF (VTO=2 BETA=1e-3)",
  zener: ".MODEL zener D (IS=1e-14 BV=5.6 N=1)",
  schottky: ".MODEL schottky D (IS=1e-10 N=1.05)",
};

/**
 * Strip Spectre backslash escapes: `\X` → `X`.
 */
function stripEscapes(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

/**
 * Convert a single Spectre device line to ngspice SPICE format.
 *
 * R8 (ref Net_29) resistor r=4858    →  R8 ref Net_29 4858
 * C1 (n1 n2) capacitor c=1p          →  C1 n1 n2 1p
 * Q10 (c b e sub) npn m=1            →  Q10 c b e sub npn m=1
 * D1 (anode cathode) diode           →  D1 anode cathode diode
 * M1 (d g s b) nmos w=10u l=0.35u   →  M1 d g s b nmos w=10u l=0.35u
 */
function convertDeviceLine(line: string): string {
  const trimmed = line.trimStart();
  // Match: DEVNAME (term1 term2 ...) rest
  const m = trimmed.match(/^(\w+)\s+\(([^)]+)\)\s*(.*)$/);
  if (!m) return stripEscapes(line); // already CDL or unknown

  const devName = m[1];
  const terminals = stripEscapes(m[2].replace(/\s+/g, " ").trim());
  const rest = stripEscapes(m[3].trim());
  const prefix = devName[0]?.toUpperCase();

  // R, C, L — strip type keyword, extract value from keyword=value
  if (prefix === "R" || prefix === "C" || prefix === "L") {
    let cleanRest = rest.replace(/^(resistor|capacitor|inductor)\s*/i, "").trim();
    // Extract value from keyword=value (r=1k, c=1p) → positional
    const valMatch = cleanRest.match(/^[a-zA-Z_]\w*\s*=\s*(\S+)/);
    if (valMatch) {
      cleanRest = valMatch[1];
    }
    return `${devName} ${terminals} ${cleanRest}`.trim();
  }

  // Q (BJT) — keep 4 terminals if present, model name as-is
  if (prefix === "Q") {
    return `${devName} ${terminals} ${rest}`.trim();
  }

  // D (diode) — keep format, model name stays
  if (prefix === "D") {
    return `${devName} ${terminals} ${rest}`.trim();
  }

  // M (MOS), J (JFET), others — strip parentheses only
  return `${devName} ${terminals} ${rest}`.trim();
}

/**
 * Convert a Spectre netlist to valid ngspice SPICE format.
 *
 * Handles:
 *   - Parenthesized terminal lists → positional
 *   - Type keywords (resistor/capacitor/inductor) → stripped
 *   - keyword=value params → positional for passives
 *   - .subckt/.ends parentheses stripped
 *   - Backslash escapes stripped
 *   - Default .model cards injected for device types found
 *   - GND_1 → GND alias (if GND_1 is used as a port)
 *
 * @param spectreNetlist — raw Spectre-format netlist
 * @param extraDirectives — user directives to append (sources, analysis, etc.)
 * @returns valid ngspice netlist with .model cards
 */
export function spectreToNgspice(
  spectreNetlist: string,
  extraDirectives?: string,
): string {
  const lines = spectreNetlist.split("\n");
  const out: string[] = [];
  const modelNamesUsed = new Set<string>();

  for (const raw of lines) {
    const trimmed = raw.trim();

    // Skip empty lines (we'll manage spacing)
    if (!trimmed) continue;

    // Comment / blank
    if (trimmed.startsWith("*") || trimmed.startsWith("//")) {
      out.push(raw);
      continue;
    }

    // .subckt — strip parentheses from port list
    if (/^\.?subckt\b/i.test(trimmed)) {
      const fixed = trimmed
        .replace(/^\.?subckt\b/i, ".subckt")
        .replace(/\(/g, " ")
        .replace(/\)/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      out.push(fixed);
      continue;
    }

    // .ends — normalize
    if (/^\.?ends\b/i.test(trimmed)) {
      out.push(trimmed.replace(/^\.?ends\b/i, ".ends").trim());
      continue;
    }

    // Device lines — convert from Spectre format
    const prefix = trimmed[0]?.toUpperCase();
    if (prefix && "MRQCLDJP".includes(prefix) && /^\w+\s/.test(trimmed)) {
      out.push(convertDeviceLine(trimmed));

      // Track model names used for .model card generation
      if (prefix === "Q") {
        const parts = trimmed.match(/\)\s*(\w+)/);
        if (parts) modelNamesUsed.add(parts[1].toLowerCase());
      }
      if (prefix === "D") {
        const parts = trimmed.match(/\)\s*(\w+)/);
        if (parts && parts[1] !== "0") modelNamesUsed.add(parts[1].toLowerCase());
      }
      if (prefix === "M") {
        const parts = trimmed.match(/\)\s*(\w+)/);
        if (parts) modelNamesUsed.add(parts[1].toLowerCase());
      }
      continue;
    }

    // Everything else (directives, .model, etc.) — pass through
    out.push(raw);
  }

  // Collect all model names actually referenced in device lines
  const fullText = out.join("\n");
  const modelRefs = new Set<string>();
  for (const name of ["npn", "pnp", "diode", "nmos", "pmos", "njf", "pjf", "zener", "schottky"]) {
    // Check if model name appears as a device model (after terminals)
    const re = new RegExp(`\\b${name}\\b`, "i");
    if (re.test(fullText)) modelRefs.add(name);
  }

  // Build .model card block
  const modelCards: string[] = [];
  for (const name of modelRefs) {
    if (DEFAULT_MODELS[name]) {
      modelCards.push(DEFAULT_MODELS[name]);
    }
  }

  // Assemble final netlist: models first, then devices, then directives
  const result: string[] = [];

  // .model cards
  if (modelCards.length > 0) {
    result.push("* ── Model Cards ──");
    result.push(...modelCards);
    result.push("");
  }

  // Device/subcircuit lines
  result.push(...out);

  // User directives
  if (extraDirectives) {
    result.push("");
    result.push(extraDirectives);
  }

  return result.join("\n");
}

/**
 * Extract all .MODEL lines from a netlist string.
 * Used to include model cards when simulating a subcircuit subset.
 */
export function extractModelCards(netlist: string): string[] {
  const cards: string[] = [];
  for (const line of netlist.split("\n")) {
    const trimmed = line.trim();
    if (/^\.model\b/i.test(trimmed)) {
      cards.push(trimmed);
    }
  }
  return cards;
}
