import cors from "cors";
import express from "express";
import { createImportJobManager } from "./dieImport/jobs.js";
import { createAnnotationsRouter } from "./api/annotations.js";
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
import { createAssistantRouter } from "./api/assistant.js";
import { createTilesRouter } from "./api/tiles.js";
import { enqueueOverlayPrebuilds } from "./api/overlayImages.js";
import { listDieRecords } from "./store.js";

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
      importJobManager
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
  app.use(createMLRouter({
    mlSidecarUrl: config.mlSidecarUrl,
    dataRoot: config.dataRoot,
    mlPredictPad: config.mlPredictPad,
    broadcaster: config.broadcaster
  }));
  app.use(createMetalStackRouter({ dataRoot: config.dataRoot }));
  app.use(createProjectIORouter({ dataRoot: config.dataRoot, tileScheduler }));
  app.use(createAssistantRouter({ dataRoot: config.dataRoot }));
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
