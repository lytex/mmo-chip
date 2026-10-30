import { useMemo } from "react";
import { Ic } from "../icons";
import { useOverlayLayers } from "../state/overlayLayers";

interface Props {
  baseName: string;
  maxWidth?: number;
}

/** Selects the image source used by the cell previews and canvases. */
export function OverlayLayerSelector({ baseName, maxWidth = 220 }: Props) {
  const layers = useOverlayLayers((s) => s.layers);
  const baseImageVisible = useOverlayLayers((s) => s.baseImageVisible);
  const setLayerHidden = useOverlayLayers((s) => s.setLayerHidden);
  const toggleBaseImage = useOverlayLayers((s) => s.toggleBaseImage);
  const selected = useMemo(() => {
    const visible = [...layers].reverse().find((layer) => !layer.hidden && layer.opacity > 0);
    return visible?.id ?? (baseImageVisible ? "__base__" : "");
  }, [layers, baseImageVisible]);

  const select = (id: string) => {
    if (id === "__base__") {
      if (!baseImageVisible) toggleBaseImage();
      for (const layer of layers) if (!layer.hidden) setLayerHidden(layer.id, true);
      return;
    }
    if (baseImageVisible) toggleBaseImage();
    for (const layer of layers) setLayerHidden(layer.id, layer.id !== id);
  };

  return (
    <label
      className="btn"
      style={{ maxWidth, position: "relative", display: "inline-flex", alignItems: "center", gap: 5 }}
      title="Image layer"
    >
      {Ic.image}
      <span className="m" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {selected === "__base__" ? baseName : layers.find((layer) => layer.id === selected)?.name ?? baseName}
      </span>
      {Ic.caret}
      <select
        value={selected}
        onChange={(e) => select(e.target.value)}
        aria-label="Image layer"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer" }}
      >
        <option value="__base__">{baseName}</option>
        {layers.map((layer) => (
          <option key={layer.id} value={layer.id}>{layer.name}</option>
        ))}
      </select>
    </label>
  );
}
