import path from "node:path";
import fs from "node:fs";
import cors from "cors";
import express from "express";
import { createImportJobManager } from "./dieImport/jobs.js";
import { createAnnotationsRouter } from "./api/annotations.js";
import { createCellDetectionRouter } from "./api/cellDetection.js";
import { createCellImagingRouter } from "./api/cellImaging.js";
import { createDiesRouter } from "./api/dies.js";
import { createHealthRouter } from "./api/health.js";
import { createJobsRouter } from "./api/jobs.js";
import { createMLRouter } from "./api/ml.js";
import { createOverlayImagesRouter } from "./api/overlayImages.js";
import { createMLExportRouter } from "./api/mlExport.js";
import { createAnalogExportRouter } from "./api/analogExport.js";
import { createLvsRouter } from "./api/lvs.js";
import { createDebugRouter } from "./api/debug.js";
import { createAuthRouter } from "./api/auth.js";
import { createMetalStackRouter } from "./api/metalStack.js";
import { createProjectIORouter } from "./api/projectIO.js";
import { createFsRouter } from "./api/fs.js";
import { createAssistantRouter } from "./api/assistant.js";
import { createSpiceHandoffRouter } from "./api/spiceHandoff.js";
import { createTilesRouter } from "./api/tiles.js";
import { createMcpRouter } from "./api/mcp.js";
import { enqueueOverlayPrebuilds } from "./api/overlayImages.js";
import { createMLPredictor } from "./ml/predict.js";
import { listDieRecords } from "./store.js";
import { resolveProjectDir } from "./projectLayout.js";

import { createTileScheduler } from "./tileScheduler.js";
import type { AnnotationBroadcaster } from "./ws.js";
import { requireAuth, isAuthEnabled } from "./auth/middleware.js";

export function createApp(config: {
  dataRoot: string;
  tileSize: number;
  limitInputPixels: number | false;
  tileConcurrency: number;
  mlSidecarUrl: string;
  mlPredictPad: number;
  broadcaster?: AnnotationBroadcaster;
  /** How long an MCP call on a die awaiting approval waits (default 50 s). */
  mcpApprovalWaitMs?: number;
  /** Serve the built SPA from this directory (desktop packaging). */
  frontendDist?: string;
}) {
  const app = express();
  const tileScheduler = createTileScheduler({
    dataRoot: config.dataRoot,
    concurrency: config.tileConcurrency
  });
  const importJobManager = createImportJobManager({
    ...config,
    tileScheduler
  });

  app.use(cors() as unknown as express.RequestHandler);
  app.use(express.json({ limit: "50mb" }));

  // Auth middleware (applied to all /api/* except public paths)
  app.use("/api", (request, response, next) => {
    const path = request.path;
    const method = request.method;
    // Public GET paths — loaded via <img> tags that can't carry auth headers
    if (method === "GET") {
      if (
        path.startsWith("/auth/") ||
        path.startsWith("/health/") ||
        path.startsWith("/dies/") // tile images, original image, overlays loaded via <img>
      ) {
        return next();
      }
    } else {
      // Non-GET: only auth and health are public
      if (path.startsWith("/auth/") || path.startsWith("/health/")) {
        return next();
      }
    }
    return requireAuth(request, response, next);
  });

  // Public routes
  app.use(createHealthRouter());
  app.use(createAuthRouter({ dataRoot: config.dataRoot }));

  // Protected routes
  app.use(createJobsRouter({ dataRoot: config.dataRoot }));
  app.use(
    createDiesRouter({
      dataRoot: config.dataRoot,
      tileScheduler,
      importJobManager,
      broadcaster: config.broadcaster
    })
  );
  app.use(createTilesRouter({ dataRoot: config.dataRoot, tileScheduler }));
  app.use(
    createAnnotationsRouter({
      dataRoot: config.dataRoot,
      onAnnotationsChanged: (dieId, rev) =>
        config.broadcaster?.emitAnnotationChange(dieId, rev)
    })
  );
  app.use(createMLExportRouter({ dataRoot: config.dataRoot }));
  app.use(createAnalogExportRouter({ dataRoot: config.dataRoot }));
  app.use(createLvsRouter({ dataRoot: config.dataRoot }));
  app.use(createOverlayImagesRouter({ dataRoot: config.dataRoot }));
  const predictor = createMLPredictor({
    mlSidecarUrl: config.mlSidecarUrl,
    dataRoot: config.dataRoot,
    mlPredictPad: config.mlPredictPad
  });
  app.use(createMLRouter({
    mlSidecarUrl: config.mlSidecarUrl,
    dataRoot: config.dataRoot,
    mlPredictPad: config.mlPredictPad,
    broadcaster: config.broadcaster,
    predictor
  }));
  app.use(
    createCellDetectionRouter({
      dataRoot: config.dataRoot,
      predictor,
      broadcaster: config.broadcaster
    })
  );
  app.use(
    createCellImagingRouter({
      dataRoot: config.dataRoot,
      tileScheduler,
      broadcaster: config.broadcaster
    })
  );
  app.use(createMetalStackRouter({ dataRoot: config.dataRoot }));
  app.use(createProjectIORouter({ dataRoot: config.dataRoot, tileScheduler }));
  app.use(createFsRouter({ dataRoot: config.dataRoot, tileScheduler }));
  app.use(createAssistantRouter({ dataRoot: config.dataRoot }));
  app.use(
    createMcpRouter({
      dataRoot: config.dataRoot,
      onAnnotationsChanged: (dieId, rev) =>
        config.broadcaster?.emitAnnotationChange(dieId, rev),
      onAccessChanged: () => config.broadcaster?.emitMcpAccess(),
      onPromptsChanged: () => config.broadcaster?.emitMcpPrompts(),
      approvalWaitMs: config.mcpApprovalWaitMs
    })
  );
  app.use(createSpiceHandoffRouter({ dataRoot: config.dataRoot }));
  app.use(createDebugRouter({ dataRoot: config.dataRoot }));

  // Resume/create the complete overlay disk cache for every known project.
  // The shared overlay scheduler serialises huge originals and keeps a slot for
  // viewport requests, so startup never launches N full-size decodes at once.
  setImmediate(() => {
    void listDieRecords(config.dataRoot)
      .then(async (records) => {
        for (const record of records) {
          await enqueueOverlayPrebuilds(config.dataRoot, record.id);
        }
      })
      .catch((error) => console.warn("Failed to enqueue overlay tile prebuilds", error));
  });

  // The base-tile queue lives in memory, so a restart during the background
  // prebuild left the pyramid half built: missing tiles were then rendered
  // lazily on every visit and the card flipped back to "tiling". Resume it;
  // enqueueBackground skips tiles on disk and is a no-op for complete dies.
  setImmediate(() => {
    void listDieRecords(config.dataRoot)
      .then(async (records) => {
        for (const record of records) {
          if (!(await resolveProjectDir(config.dataRoot, record.id)).available) continue;
          tileScheduler.enqueueBackground(record);
        }
      })
      .catch((error) => console.warn("Failed to resume base tile prebuilds", error));
  });

  // Desktop packaging: serve the built SPA and fall back to index.html for
  // client-side routes. Mounted after every API/MCP router, so it only sees
  // requests no API layer claimed. Dev (Vite on :5173) leaves this unset.
  if (config.frontendDist) {
    const frontendDist = path.resolve(config.frontendDist);
    if (fs.existsSync(path.join(frontendDist, "index.html"))) {
      const sendIndex = (response: express.Response): void => {
        response.sendFile(path.join(frontendDist, "index.html"), (error) => {
          if (error && !response.headersSent) response.status(500).send("frontend dist missing");
        });
      };
      app.use(express.static(frontendDist, { index: false, maxAge: "1h" }));
      app.use((request, response, next) => {
        if (request.method !== "GET" && request.method !== "HEAD") return next();
        if (request.path.startsWith("/api/") || request.path.startsWith("/mcp")) return next();
        if (path.extname(request.path)) return next();
        sendIndex(response);
      });
    } else {
      console.warn(`frontend dist not found at ${frontendDist} — serving API only`);
    }
  }

  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction
    ) => {
      if (response.headersSent) return;

      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        console.error("[http] ENOENT:", error);
        response.status(404).json({ error: "Not found" });
        return;
      }

      response.status(500).json({
        error: error instanceof Error ? error.message : "Unknown server error"
      });
    }
  );

  return app;
}
