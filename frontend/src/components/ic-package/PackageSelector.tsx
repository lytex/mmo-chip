import { useIcPackageStore } from "../../state/icPackage";

export function PackageSelector() {
  const footprint = useIcPackageStore((s) => s.footprint);
  const presets = useIcPackageStore((s) => s.presets);
  const setFootprint = useIcPackageStore((s) => s.setFootprint);
  const pins = useIcPackageStore((s) => s.pins);
  const named = pins.filter((p) => p.name).length;

  return (
    <div className="panel" style={{ padding: "8px 10px" }}>
      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}>
        Package
      </div>
      <select
        value={footprint}
        onChange={(e) => setFootprint(e.target.value)}
        style={{ width: "100%" }}
      >
        {presets.map((p) => (
          <option key={p.value} value={p.value}>{p.label}</option>
        ))}
      </select>
      <div style={{ fontSize: 10, color: "var(--ink3)", marginTop: 6 }}>
        {pins.length} pins · {named} named
      </div>
    </div>
  );
}
