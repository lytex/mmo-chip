import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import sharp from "sharp";
import request from "supertest";
import { createApp } from "./app.js";
import { resolveOverlayOriginalPath } from "./api/overlayImages.js";
import { ensureDataStore } from "./store.js";

const tempRoots: string[] = [];
const tempServers: Array<import("node:http").Server> = [];

afterEach(async () => {
  await Promise.all(
    tempServers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        })
    )
  );
  tempServers.length = 0;
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

test("imports an image and exposes list/detail/tile endpoints", async () => {
  const { app, dataRoot } = await createHarness();

  const imageBuffer = await sharp({
    create: {
      width: 512,
      height: 256,
      channels: 3,
      background: { r: 200, g: 120, b: 80 }
    }
  })
    .png()
    .toBuffer();

  const importResponse = await request(app)
    .post("/api/dies/import")
    .attach("file", imageBuffer, {
      filename: "test-die.png",
      contentType: "image/png"
    });
  assert.equal(importResponse.status, 202);
  assert.equal(importResponse.body.originalFilename, "test-die.png");

  const completedJob = await waitForCompletedJob(app, importResponse.body.id);
  assert.equal(completedJob.status, "completed");
  assert.ok(completedJob.dieId);
  await waitForTilePrebuild(app, completedJob.dieId);

  const listResponse = await request(app).get("/api/dies");
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.length, 1);

  const detailResponse = await request(app).get(`/api/dies/${completedJob.dieId}`);
  assert.equal(detailResponse.status, 200);
  assert.ok(detailResponse.body.levels.length > 0);
  assert.equal(detailResponse.body.tileFormat, "jpg");
  const tileResponse = await request(app).get(
    `/api/dies/${completedJob.dieId}/tiles/${detailResponse.body.maxZoomLevel}/0/0`
  );
  assert.equal(tileResponse.status, 200);
  assert.match(tileResponse.headers["content-type"] ?? "", /image\/jpeg/);
  const lazyTilePath = path.join(
    dataRoot,
    "dies",
    completedJob.dieId,
    "tiles",
    String(detailResponse.body.maxZoomLevel),
    "0_0.jpg"
  );
  await fs.access(lazyTilePath);
});

test("rejects unsupported file types", async () => {
  const { app } = await createHarness();

  const response = await request(app)
    .post("/api/dies/import")
    .attach("file", Buffer.from("hello"), {
      filename: "notes.txt",
      contentType: "text/plain"
    });
  assert.equal(response.status, 202);
  const failedJob = await waitForCompletedJob(app, response.body.id);
  assert.equal(failedJob.status, "failed");
  assert.match(failedJob.error, /PNG, JPEG and TIFF/);
});

test("deletes a die and its stored data", async () => {
  const { app, dataRoot } = await createHarness();

  const imageBuffer = await sharp({
    create: {
      width: 256,
      height: 256,
      channels: 3,
      background: { r: 40, g: 80, b: 160 }
    }
  })
    .png()
    .toBuffer();

  const importResponse = await request(app)
    .post("/api/dies/import")
    .attach("file", imageBuffer, {
      filename: "delete-me.png",
      contentType: "image/png"
    });
  assert.equal(importResponse.status, 202);

  const completedJob = await waitForCompletedJob(app, importResponse.body.id);
  assert.equal(completedJob.status, "completed");
  assert.ok(completedJob.dieId);

  const tileResponse = await request(app).get(`/api/dies/${completedJob.dieId}/tiles/0/0/0`);
  assert.equal(tileResponse.status, 200);

  const dieDir = path.join(dataRoot, "dies", completedJob.dieId);
  await fs.access(dieDir);

  const deleteResponse = await request(app).delete(`/api/dies/${completedJob.dieId}`);
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(deleteResponse.body, { ok: true });

  const listResponse = await request(app).get("/api/dies");
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.length, 0);

  const detailResponse = await request(app).get(`/api/dies/${completedJob.dieId}`);
  assert.equal(detailResponse.status, 404);

  await assert.rejects(fs.access(dieDir));
});

test("analyses a supplied circuit snapshot without changing annotations", async () => {
  const { app } = await createHarness();
  const imageBuffer = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
  const imported = await request(app).post("/api/dies/import").attach("file", imageBuffer, { filename: "assistant.png", contentType: "image/png" });
  const job = await waitForCompletedJob(app, imported.body.id);
  const before = await request(app).get(`/api/dies/${job.dieId}/annotations`);
  const circuit = {
    devices: [
      { uuid: "mref", instanceName: "MREF", kind: "mos", modelName: "pmos", geometry: { W_um: 10, L_um: 1, fingers: 1, multiplier: 1, totalW_um: 10, mosType: "pmos" }, terminals: [{ name: "D", netId: 1 }, { name: "G", netId: 1 }, { name: "S", netId: 2 }, { name: "B", netId: 2 }] },
      { uuid: "mout", instanceName: "MOUT", kind: "mos", modelName: "pmos", geometry: { W_um: 10, L_um: 1, fingers: 1, multiplier: 1, totalW_um: 10, mosType: "pmos" }, terminals: [{ name: "D", netId: 3 }, { name: "G", netId: 1 }, { name: "S", netId: 2 }, { name: "B", netId: 2 }] },
    ],
    namedNets: [{ id: 1, name: "NREF" }, { id: 2, name: "VDD" }, { id: 3, name: "OUT" }],
  };
  const analysed = await request(app)
    .post(`/api/dies/${job.dieId}/assistant/analyze`)
    .send({ expectedRev: before.body.rev, scope: "die", circuit, brief: { prompt: "Find current mirrors" } });
  assert.equal(analysed.status, 200);
  assert.equal(analysed.body.ok, true);
  assert.equal(analysed.body.data.readOnly, true);
  assert.ok(analysed.body.data.findings.some((finding: { kind: string }) => finding.kind === "current_mirror"));
  const after = await request(app).get(`/api/dies/${job.dieId}/annotations`);
  assert.equal(after.body.rev, before.body.rev);
});

test("cell crops come from the tile pyramid, with ?px previews at coarse levels", async () => {
  const { app, dataRoot } = await createHarness();
  // Left half dark, right half bright: a crop straddling x=256 shows both.
  const imageBuffer = await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 30, g: 30, b: 30 } } })
    .composite([{ input: { create: { width: 256, height: 512, channels: 3, background: { r: 220, g: 220, b: 220 } } }, left: 256, top: 0 }])
    .png()
    .toBuffer();
  const imported = await request(app).post("/api/dies/import").attach("file", imageBuffer, { filename: "crop.png", contentType: "image/png" });
  const job = await waitForCompletedJob(app, imported.body.id);
  await waitForTilePrebuild(app, job.dieId);

  const annotations = (await request(app).get(`/api/dies/${job.dieId}/annotations`)).body;
  annotations.cellTypes = [{ id: "ct1", name: "T", cropRect: { x: 0, y: 0, width: 200, height: 160 } }];
  annotations.cells = [{ id: "c1", cellTypeId: "ct1", x: 150, y: 100 }]; // straddles tile edges at 128/256
  assert.equal((await request(app).put(`/api/dies/${job.dieId}/annotations`).send(annotations)).status, 200);

  const full = await request(app).get(`/api/dies/${job.dieId}/cells/c1/crop`).buffer(true);
  assert.equal(full.status, 200);
  const fullImg = await sharp(full.body).raw().toBuffer({ resolveWithObject: true });
  assert.equal(fullImg.info.width, 200);
  assert.equal(fullImg.info.height, 160);
  const at = (img: typeof fullImg, x: number, y: number) => img.data[(y * img.info.width + x) * img.info.channels];
  assert.ok(at(fullImg, 50, 80) < 60, "left of x=256 is dark"); // die x=200
  assert.ok(at(fullImg, 150, 80) > 190, "right of x=256 is bright"); // die x=300

  const preview = await request(app).get(`/api/dies/${job.dieId}/cells/c1/crop?px=40`).buffer(true);
  assert.equal(preview.status, 200);
  const previewMeta = await sharp(preview.body).metadata();
  assert.ok(previewMeta.width! < 200 && previewMeta.width! >= 40, `preview width ${previewMeta.width}`);

  // Cached per position + size + scale.
  const cached = await fs.readdir(path.join(dataRoot, "dies", job.dieId, "cell-crops"));
  assert.ok(cached.includes("base-c1-150-100-200x160-s1.jpg"), cached.join(","));
  assert.equal(cached.filter((f) => f.startsWith("base-c1-")).length, 2);
});

test("overlay upload accepts a pyramidal TIFF and prebuilds it from its stored levels", async () => {
  const { app, dataRoot } = await createHarness();
  const dieImage = await sharp({
    create: { width: 256, height: 256, channels: 3, background: { r: 10, g: 10, b: 10 } }
  })
    .png()
    .toBuffer();
  const importResponse = await request(app)
    .post("/api/dies/import")
    .attach("file", dieImage, { filename: "die.png", contentType: "image/png" });
  const { dieId } = await waitForCompletedJob(app, importResponse.body.id);

  const tiff = await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: { r: 30, g: 180, b: 60 } }
  })
    .tiff({ pyramid: true, tile: true, compression: "jpeg" })
    .toBuffer();
  const upload = await request(app)
    .post(`/api/dies/${dieId}/overlay-images/upload`)
    // Some browsers send no TIFF MIME type; the extension must suffice.
    .attach("file", tiff, { filename: "Metal 1.tiff", contentType: "application/octet-stream" });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  const image = upload.body.image;
  assert.deepEqual([image.width, image.height, image.tileFormat], [3000, 2000, "jpg"]);
  const sourceDir = path.join(dataRoot, "overlay-images", dieId, image.id);
  await fs.access(path.join(sourceDir, "original.tif"));

  const tile = await request(app).get(`/api/dies/${dieId}/overlay-images/${image.id}/tiles/0/0/0`);
  assert.equal(tile.status, 200);
  const tileMeta = await sharp(tile.body).metadata();
  assert.deepEqual([tileMeta.width, tileMeta.height], [375, 250]);
  const { channels } = await sharp(tile.body).stats();
  assert.ok(Math.abs(channels[1].mean - 180) < 6, "tile keeps the overlay colour");

  for (let attempt = 0; ; attempt += 1) {
    const info = await request(app).get(`/api/dies/${dieId}/tile-info`);
    const source = info.body.overlayTileProgress.sources[0];
    if (source?.status === "completed") {
      assert.equal(source.completedTiles, source.totalTiles);
      break;
    }
    assert.ok(attempt < 300, `overlay prebuild stuck: ${JSON.stringify(source)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const fullLevel = await fs.readdir(path.join(sourceDir, "tiles", String(image.maxZoomLevel)));
  assert.equal(fullLevel.filter((name) => name.endsWith(".jpg")).length, 6 * 4);
});

test("overlay purpose persists, auto-detects from the name and can be forced to none", async () => {
  const { app } = await createHarness();
  const dieImage = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } }
  })
    .png()
    .toBuffer();
  const importResponse = await request(app)
    .post("/api/dies/import")
    .attach("file", dieImage, { filename: "die.png", contentType: "image/png" });
  const { dieId } = await waitForCompletedJob(app, importResponse.body.id);

  const upload = await request(app)
    .post(`/api/dies/${dieId}/overlay-images/upload`)
    .attach("file", dieImage, { filename: "sirtl.png", contentType: "image/png" });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  const id = upload.body.image.id;
  assert.equal(upload.body.image.purpose, "diffusion");
  assert.equal(upload.body.image.purposeSource, "auto");
  assert.equal(upload.body.image.purposeEditable, true);

  const explicit = await request(app)
    .patch(`/api/dies/${dieId}/overlay-images/${id}`)
    .send({ purpose: "metal2" });
  assert.equal(explicit.status, 200, JSON.stringify(explicit.body));
  assert.equal(explicit.body.image.purpose, "metal2");
  assert.equal(explicit.body.image.purposeSource, "user");
  assert.equal(explicit.body.image.explicitPurpose, "metal2");

  const listed = await request(app).get(`/api/dies/${dieId}/overlay-images/list`);
  assert.equal(listed.body.images[0].purpose, "metal2");

  const cleared = await request(app)
    .patch(`/api/dies/${dieId}/overlay-images/${id}`)
    .send({ purpose: null });
  assert.equal(cleared.body.image.purpose, "diffusion");
  assert.equal(cleared.body.image.purposeSource, "auto");

  const forcedNone = await request(app)
    .patch(`/api/dies/${dieId}/overlay-images/${id}`)
    .send({ purpose: "none" });
  assert.equal(forcedNone.body.image.purpose, null);
  assert.equal(forcedNone.body.image.purposeSource, "user");
  assert.equal(forcedNone.body.image.explicitPurpose, "none");
});

test("overlay purpose saves when a moved folder project has a stale originalPath", async () => {
  const { app, dataRoot } = await createHarness();
  const dieImage = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } }
  })
    .png()
    .toBuffer();
  const importResponse = await request(app)
    .post("/api/dies/import")
    .attach("file", dieImage, { filename: "die.png", contentType: "image/png" });
  const { dieId } = await waitForCompletedJob(app, importResponse.body.id);

  const upload = await request(app)
    .post(`/api/dies/${dieId}/overlay-images/upload`)
    .attach("file", dieImage, { filename: "sirtl.png", contentType: "image/png" });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  const id = upload.body.image.id;

  // Simulate a folder project copied from another machine: the absolute
  // originalPath no longer exists, while manifest and original sit together.
  const manifestFile = path.join(dataRoot, "overlay-images", dieId, id, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  manifest.originalPath = path.join("Z:", "moved-away", "original.png");
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2), "utf8");

  const saved = await request(app)
    .patch(`/api/dies/${dieId}/overlay-images/${id}`)
    .send({ purpose: "metal1" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.image.purpose, "metal1");

  const repaired = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  assert.equal(repaired.purpose, "metal1");
  assert.equal(repaired.originalPath, path.join(path.dirname(manifestFile), "original.png"));
});

test("SPICE handoff is stored per project and returned as latest", async () => {
  const { app } = await createHarness();
  const dieImage = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } }
  })
    .png()
    .toBuffer();
  const importResponse = await request(app)
    .post("/api/dies/import")
    .attach("file", dieImage, { filename: "die.png", contentType: "image/png" });
  const { dieId } = await waitForCompletedJob(app, importResponse.body.id);

  const missing = await request(app).get(`/api/dies/${dieId}/spice-handoff/latest`);
  assert.equal(missing.status, 404);

  const posted = await request(app)
    .post(`/api/dies/${dieId}/spice-handoff`)
    .send({
      netlist: "* test\n.op\n.end",
      directives: ".op",
      summary: "Operating Point — 1 device",
      measurements: { vout: 1.2 }
    });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));

  const latest = await request(app).get(`/api/dies/${dieId}/spice-handoff/latest`);
  assert.equal(latest.status, 200);
  assert.equal(latest.body.dieId, dieId);
  assert.match(latest.body.netlist, /\.op/);
  assert.equal(latest.body.measurements.vout, 1.2);
  assert.equal(typeof latest.body.at, "number");
});

test("overlay delete removes the source for everyone", async () => {
  const { app, dataRoot } = await createHarness();
  const dieImage = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } }
  })
    .png()
    .toBuffer();
  const importResponse = await request(app)
    .post("/api/dies/import")
    .attach("file", dieImage, { filename: "die.png", contentType: "image/png" });
  const { dieId } = await waitForCompletedJob(app, importResponse.body.id);

  const upload = await request(app)
    .post(`/api/dies/${dieId}/overlay-images/upload`)
    .attach("file", dieImage, { filename: "layer.png", contentType: "image/png" });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  const id = upload.body.image.id;
  const sourceDir = path.join(dataRoot, "overlay-images", dieId, id);
  await fs.access(sourceDir);

  const deleted = await request(app).delete(`/api/dies/${dieId}/overlay-images/${id}`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  await assert.rejects(fs.access(sourceDir));
  const list = await request(app).get(`/api/dies/${dieId}/overlay-images/list`);
  assert.deepEqual(list.body.images, []);
  const again = await request(app).delete(`/api/dies/${dieId}/overlay-images/${id}`);
  assert.equal(again.status, 404);
});

test("overlay source resolution accepts legacy filenames and tiled ids", async () => {
  const { dataRoot } = await createHarness();
  const dieId = "die1";
  const dieImage = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } }
  })
    .png()
    .toBuffer();
  const overlayDir = path.join(dataRoot, "overlay-images", dieId);
  await fs.mkdir(overlayDir, { recursive: true });

  // Legacy flat overlays keep their filename (with extension) as the source id.
  const legacyPath = path.join(overlayDir, "me2.png");
  await fs.writeFile(legacyPath, dieImage);
  assert.equal(
    await resolveOverlayOriginalPath({ dataRoot, dieId, sourceId: "me2.png" }),
    legacyPath
  );
  assert.equal(
    await resolveOverlayOriginalPath({ dataRoot, dieId, sourceId: "../me2.png" }),
    null
  );

  // Tiled sources resolve through their manifest, even after a move leaves the
  // recorded absolute originalPath stale (copied folder project).
  const id = "tiled1";
  const sourceDir = path.join(overlayDir, id);
  const originalPath = path.join(sourceDir, "original.png");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(originalPath, dieImage);
  const manifestPath = path.join(sourceDir, "manifest.json");
  const manifest = {
    id,
    name: id,
    originalFilename: "original.png",
    originalPath,
    size: dieImage.length,
    width: 64,
    height: 64,
    tileSize: 512,
    tileFormat: "png",
    hasAlpha: false,
    maxZoomLevel: 0,
    levels: [],
    ready: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  assert.equal(await resolveOverlayOriginalPath({ dataRoot, dieId, sourceId: id }), originalPath);

  manifest.originalPath = path.join("Z:", "moved-away", "original.png");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  assert.equal(await resolveOverlayOriginalPath({ dataRoot, dieId, sourceId: id }), originalPath);
});

test("overlay upload rejects formats other than PNG, JPEG, WebP and TIFF", async () => {
  const { app } = await createHarness();
  const dieImage = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } }
  })
    .png()
    .toBuffer();
  const importResponse = await request(app)
    .post("/api/dies/import")
    .attach("file", dieImage, { filename: "die.png", contentType: "image/png" });
  const { dieId } = await waitForCompletedJob(app, importResponse.body.id);

  const gif = await sharp(dieImage).gif().toBuffer();
  const upload = await request(app)
    .post(`/api/dies/${dieId}/overlay-images/upload`)
    .attach("file", gif, { filename: "layer.png", contentType: "image/png" });
  assert.equal(upload.status, 400);
  assert.match(upload.body.error, /PNG, JPEG, WebP and TIFF/);
});

async function createHarness() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chiptool-test-"));
  tempRoots.push(dataRoot);
  await ensureDataStore(dataRoot);
  const server = createServer(
    createApp({
      dataRoot,
      tileSize: 128,
      limitInputPixels: false,
      tileConcurrency: 2
    })
  );
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  tempServers.push(server);
  return { app: server, dataRoot };
}

async function waitForTilePrebuild(app: import("node:http").Server, dieId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await request(app).get(`/api/dies/${dieId}`);
    const progress = response.body.tileProgress;
    if (progress && progress.completedTiles === progress.totalTiles) {
      return progress;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for tile prebuild for ${dieId}`);
}

async function waitForCompletedJob(

  app: import("node:http").Server,
  jobId: string
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await request(app).get(`/api/import-jobs/${jobId}`);
    if (response.body.status === "completed" || response.body.status === "failed") {
      return response.body;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for import job ${jobId}`);
}
