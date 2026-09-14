import { useRef, useEffect, useCallback, type CSSProperties } from 'react';
import { TransientRenderer } from './renderer';
import { resolveTheme } from './theme';
import { normalizeTransientData } from './data';
import { InteractionHandler } from './interaction';
import type { ThemeConfig, CursorState } from './types';
import { useCanvas } from './use-renderer';

export interface TransientPlotHandle {
  fitToData(): void;
}

export interface TransientPlotProps {
  /** TransientResult from @spice-ts/core, or array of TransientDataset for overlay. */
  data: unknown;
  /** Signal names to display. */
  signals: string[];
  /** Signal color overrides. */
  colors?: Record<string, string>;
  /** Theme preset or custom config. */
  theme?: 'dark' | 'light' | ThemeConfig;
  /** CSS width. Default '100%'. */
  width?: number | string;
  /** CSS height. Default 300. */
  height?: number | string;
  /** Cursor move callback. */
  onCursorMove?: (cursor: CursorState | null) => void;
  /** Signal visibility state (controlled). */
  signalVisibility?: Record<string, boolean>;
  /** Ref to access imperative methods like fitToData(). */
  handleRef?: React.MutableRefObject<TransientPlotHandle | null>;
  /** Fixed x-axis domain [min, max] in seconds. Useful for streaming. */
  xDomain?: [number, number];
}

export function TransientPlot({
  data,
  signals,
  colors,
  theme,
  width = '100%',
  height = 300,
  onCursorMove,
  signalVisibility,
  handleRef,
  xDomain,
}: TransientPlotProps) {
  const rendererRef = useRef<TransientRenderer | null>(null);
  const interactionRef = useRef<InteractionHandler | null>(null);
  const onCursorMoveRef = useRef(onCursorMove);
  onCursorMoveRef.current = onCursorMove;
  const resolvedTheme = resolveTheme(theme);

  const handleResize = useCallback(() => {
    rendererRef.current?.render();
  }, []);

  const { refCallback } = useCanvas(handleResize);

  // Create renderer and interaction handler once when canvas mounts.
  // Does NOT depend on data, signals, or colors — those update via useEffect below.
  const canvasRefCallback = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      rendererRef.current?.destroy();
      interactionRef.current?.destroy();
      rendererRef.current = null;
      interactionRef.current = null;

      refCallback(canvas);

      if (canvas) {
        const renderer = new TransientRenderer(canvas, { theme: resolvedTheme });
        rendererRef.current = renderer;

        renderer.on('cursorMove', (state) => {
          onCursorMoveRef.current?.(state);
        });

        const interaction = new InteractionHandler(canvas, {
          onCursorMove: (pixelX) => {
            renderer.setCursorPixelX(pixelX);
            renderer.render();
          },
          onZoom: (_pixelX, factor, _shiftKey) => {
            renderer.zoomAt(_pixelX, factor);
            renderer.render();
          },
          onPan: (dx, _dy) => {
            renderer.pan(dx, 0);
            renderer.render();
          },
          onDoubleClick: () => {
            renderer.fitToData();
            renderer.render();
          },
        });
        interactionRef.current = interaction;

        if (handleRef) {
          handleRef.current = {
            fitToData() {
              renderer.fitToData();
              renderer.render();
            },
          };
        }
      }
    },
    [resolvedTheme, refCallback, handleRef],
  );

  // Update data on the existing renderer without recreating it.
  // This preserves zoom/pan state during streaming.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    const datasets = normalizeTransientData(data, signals);
    renderer.setData(datasets, signals);

    if (xDomain) {
      renderer.setFixedXDomain(xDomain);
    }

    if (colors) {
      for (const [name, color] of Object.entries(colors)) {
        renderer.setSignalColor(name, color);
      }
    }

    renderer.render();
  }, [data, signals, colors, xDomain]);

  // Update visibility when prop changes
  useEffect(() => {
    if (!rendererRef.current || !signalVisibility) return;
    for (const [name, visible] of Object.entries(signalVisibility)) {
      rendererRef.current.setSignalVisibility(name, visible);
    }
    rendererRef.current.render();
  }, [signalVisibility]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      rendererRef.current?.destroy();
      interactionRef.current?.destroy();
    };
  }, []);

  const style: CSSProperties = {
    width: typeof width === 'number' ? `${width}px` : width,
    height: typeof height === 'number' ? `${height}px` : height,
    position: 'relative',
  };

  return (
    <div style={style}>
      <canvas
        ref={canvasRefCallback}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  );
}
