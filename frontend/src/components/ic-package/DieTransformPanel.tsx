import { useIcPackageStore } from "../../state/icPackage";

export function DieTransformPanel() {
  const transform = useIcPackageStore((s) => s.transform);
  const setRotation = useIcPackageStore((s) => s.setRotation);
  const toggleMirrorX = useIcPackageStore((s) => s.toggleMirrorX);
  const toggleMirrorY = useIcPackageStore((s) => s.toggleMirrorY);
  const resetTransform = useIcPackageStore((s) => s.resetTransform);

  return (
    <div className="panel" style={{ padding: "8px 10px" }}>
      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}>
        Die transform
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: "var(--ink3)", width: 36 }}>Rotate</span>
        {[0, 90, 180, 270].map((deg) => (
          <button
            key={deg}
            className={`chip${transform.rotationDeg === deg ? " on" : ""}`}
            onClick={() => setRotation(deg)}
            style={{ fontSize: 10, padding: "2px 6px" }}
          >
            {deg}°
          </button>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: "var(--ink3)", width: 36 }}>Mirror</span>
        <button
          className={`chip${transform.mirrorX ? " on" : ""}`}
          onClick={toggleMirrorX}
          style={{ fontSize: 10, padding: "2px 6px" }}
        >
          X
        </button>
        <button
          className={`chip${transform.mirrorY ? " on" : ""}`}
          onClick={toggleMirrorY}
          style={{ fontSize: 10, padding: "2px 6px" }}
        >
          Y
        </button>
        <button
          className="chip"
          onClick={resetTransform}
          style={{ fontSize: 10, padding: "2px 6px", marginLeft: 4 }}
          title="Reset transform"
        >
          ↺
        </button>
      </div>
    </div>
  );
}
