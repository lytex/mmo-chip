import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import sharp from "sharp";
import request from "supertest";
import { createApp } from "../app.js";
import type { AnnotationNet } from "shared";
import { ensureDataStore } from "../store.js";

const tempRoots: string[] = [];
const tempServers: Server[] = [];

afterEach(async () => {
  await Promise.all(tempServers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  tempServers.length = 0;
  await Promise.all(tempRoots.map((root) => fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50
  })));
  tempRoots.length = 0;
});

test("speaks the MCP Streamable HTTP handshake", async () => {
  const { app, dieId } = await createHarness();

  const init = await request(app)
    .post("/mcp")
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1" } }
    });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.ok(init.body.result.capabilities.tools);
  const session = init.headers["mcp-session-id"];
  assert.ok(session);

  const initialized = await request(app)
    .post("/mcp")
    .set("Mcp-Session-Id", session)
    .send({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(initialized.status, 202);

  const list = await rpc(app, "tools/list", {}, session);
  const names = list.result.tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes("get_die_image"));
  assert.ok(names.includes("add_comment"));
  assert.ok(names.includes("add_wire"));
  assert.ok(names.includes("list_overlay_layers"));
  assert.ok(names.includes("get_region_summary"));
  assert.ok(names.includes("export_netlist"));
  assert.ok(names.includes("run_ngspice"));
  assert.ok(names.includes("simulate_block"));
  assert.ok(names.includes("run_lvs"));
  assert.ok(names.includes("export_project"));
  assert.ok(names.includes("ml_job"));
  assert.ok(names.includes("cell_detection"));
  assert.ok(names.includes("edit_cells"));
  assert.ok(names.includes("edit_pins"));

  assert.equal((await rpc(app, "nope", {}, session)).error.code, -32601);
  assert.equal((await request(app).get("/mcp")).status, 405);
  assert.equal(
    (await request(app).post("/mcp").set("Origin", "https://evil.example").send({ jsonrpc: "2.0", id: 1, method: "ping" })).status,
    403
  );
  assert.equal((await request(app).post(`/mcp/${dieId}`).send({ jsonrpc: "2.0", id: 1, method: "ping" })).status, 404);
});

test("global endpoint serves every die after a user approves it", async () => {
  const { app, dieId } = await createHarness({ approve: false });
  const init = await request(app)
    .post("/mcp")
    .send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { clientInfo: { name: "global-client" } } });
  assert.match(init.body.result.instructions, /list_dies/);
  const session = init.headers["mcp-session-id"] as string;
  const callTool = async (name: string, args: Record<string, unknown>) =>
    (await rpc(app, "tools/call", { name, arguments: args }, session)).result;

  const tools = (await rpc(app, "tools/list", {}, session)).result.tools as {
    name: string;
    inputSchema: { required?: string[] };
  }[];
  assert.ok(tools.some((t) => t.name === "list_dies"));
  assert.deepEqual(tools.find((t) => t.name === "get_die_info")?.inputSchema.required, ["dieId"]);

  const listed = JSON.parse((await callTool("list_dies", {})).content[0].text);
  assert.deepEqual(listed.dies.map((d: { dieId: string; access: string }) => [d.dieId, d.access]), [[dieId, "not_requested"]]);

  assert.match((await callTool("get_die_info", {})).content[0].text, /dieId/);
  assert.match((await callTool("get_die_info", { dieId: "missing" })).content[0].text, /Unknown die/);

  // First call on an unapproved die waits, then reports it pending.
  const pending = await callTool("get_die_info", { dieId });
  assert.equal(pending.isError, true);
  assert.match(pending.content[0].text, /waiting for a user's approval/);
  const access = (await request(app).get("/api/mcp/access")).body;
  assert.equal(access.endpointPath, "/mcp");
  assert.equal(access.dies[0].state, "pending");
  assert.equal(access.dies[0].clientName, "global-client");
  assert.equal((await request(app).get(`/api/dies/${dieId}/mcp`)).body.access.state, "pending");

  // A call waiting for the decision goes through once a user approves.
  const waiting = callTool("get_die_info", { dieId });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await request(app).put(`/api/mcp/access/${dieId}`).send({ state: "approved" })).status, 200);
  const info = await waiting;
  assert.equal(info.isError, undefined);
  assert.equal(JSON.parse(info.content[0].text).dieId, dieId);

  // Denied: refused right away.
  assert.equal((await request(app).put(`/api/mcp/access/${dieId}`).send({ state: "denied" })).status, 200);
  assert.match((await callTool("get_die_info", { dieId })).content[0].text, /denied/);
  assert.equal((await request(app).put(`/api/mcp/access/${dieId}`).send({ state: "maybe" })).status, 400);
});

test("reads die info, annotations and image", async () => {
  const { app, dieId } = await createHarness();

  const info = JSON.parse((await call(app, dieId, "get_die_info", {})).content[0].text);
  assert.equal(info.width, 512);
  assert.equal(info.height, 256);
  assert.equal(info.mcpWriteMode, "off");

  const image = await call(app, dieId, "get_die_image", { x: 0, y: 0, width: 256, height: 256, maxSize: 64 });
  assert.equal(image.isError, undefined);
  assert.equal(image.content[0].type, "image");
  const meta = JSON.parse(image.content[1].text);
  assert.deepEqual(meta.output, { width: 64, height: 64 });
  assert.equal(meta.diePixelsPerOutputPixel, 4);

  const ann = JSON.parse((await call(app, dieId, "get_annotations", { sections: ["comments", "nets"] })).content[0].text);
  assert.deepEqual(Object.keys(ann.sections).sort(), ["nets"]);
  assert.ok(ann.mcpOwnedIds);
});

test("writes are gated by the per-die mode and tracked on the MCP undo stack", async () => {
  const { app, dieId } = await createHarness();

  // off: read-only
  const refused = await call(app, dieId, "add_comment", { x: 10, y: 10, text: "hi" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /off/);

  // create: add only
  await setMode(app, dieId, "create");
  const added = await call(app, dieId, "add_comment", { x: 10, y: 10, text: "bandgap here?" });
  assert.equal(added.isError, undefined);
  const { commentId } = JSON.parse(added.content[0].text);
  const editRefused = await call(app, dieId, "update_comment", { commentId, text: "x" });
  assert.equal(editRefused.isError, true);

  // A human comment is never editable by MCP, even in edit mode.
  await request(app)
    .put(`/api/dies/${dieId}/comments/human`)
    .send({ id: "human", x: 1, y: 1, text: "mine", authorId: "dev", authorName: "dev", createdAt: "", replies: [] })
    .expect(200);
  await setMode(app, dieId, "edit");
  const humanRefused = await call(app, dieId, "delete_comment", { commentId: "human" });
  assert.equal(humanRefused.isError, true);
  assert.match(humanRefused.content[0].text, /not created by MCP/);

  // edit: own items
  assert.equal((await call(app, dieId, "update_comment", { commentId, text: "bandgap" })).isError, undefined);
  const outside = await call(app, dieId, "add_ruler", { x1: 0, y1: 0, x2: 9999, y2: 0 });
  assert.equal(outside.isError, true);

  let status = (await request(app).get(`/api/dies/${dieId}/mcp`)).body;
  assert.deepEqual(status.undo.map((e: { tool: string }) => e.tool), ["add_comment", "update_comment"]);
  assert.equal(status.undo[0].clientName, "test-client");

  // Undo / redo
  await request(app).post(`/api/dies/${dieId}/mcp/undo`).expect(200);
  assert.equal(await commentText(app, dieId, commentId), "bandgap here?");
  await request(app).post(`/api/dies/${dieId}/mcp/redo`).expect(200);
  assert.equal(await commentText(app, dieId, commentId), "bandgap");

  // A human edit in between blocks the undo instead of being overwritten.
  const comment = (await request(app).get(`/api/dies/${dieId}/annotations`)).body.comments.find(
    (c: { id: string }) => c.id === commentId
  );
  await request(app).put(`/api/dies/${dieId}/comments/${commentId}`).send({ ...comment, x: 50 }).expect(200);
  const conflict = await request(app).post(`/api/dies/${dieId}/mcp/undo`);
  assert.equal(conflict.status, 409);
  status = (await request(app).get(`/api/dies/${dieId}/mcp`)).body;
  assert.equal(status.undo.length, 2);

  // The human comment and main annotations are untouched by all of this.
  assert.equal(await commentText(app, dieId, "human"), "mine");
});

test("wire edits: separate toggle, extend human nets, only own geometry is editable", async () => {
  const { app, dieId } = await createHarness();

  // A human net: a—b on metal1.
  const human: AnnotationNet = {
    id: "human",
    name: "VDD",
    nodes: [{ id: "a", x: 10, y: 10 }, { id: "b", x: 110, y: 10 }],
    edges: [{ id: "ab", from: "a", to: "b", layer: "metal1" }]
  };
  await request(app).put(`/api/dies/${dieId}/nets/human`).send(human).expect(200);

  // Markup mode does not unlock wires.
  await setMode(app, dieId, "edit");
  const refused = await call(app, dieId, "add_wire", { points: [{ x: 5, y: 50 }, { x: 50, y: 50 }], layer: "metal1" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /wire edits are off/);
  await setWires(app, dieId, true);
  assert.equal((await call(app, dieId, "add_wire", { points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], layer: "metal9" })).isError, true);

  // New net.
  const created = ok(await call(app, dieId, "add_wire", { points: [{ x: 60, y: 100 }, { x: 60, y: 60 }], layer: "metal2" }));
  assert.equal(created.netName, "Net 1");

  // Tap into the middle of the human segment and run to the new net → split + merge into VDD.
  const tap = ok(
    await call(app, dieId, "add_wire", {
      from: { netId: "human", edgeId: "ab", x: 60, y: 14 },
      to: { netId: created.netId, nodeId: created.nodeIds[1] },
      layer: "metal1"
    })
  );
  assert.equal(tap.netId, "human");
  assert.equal(tap.mergedNetId, created.netId);
  let all = await nets(app, dieId);
  assert.equal(all.length, 1);
  const vdd = all[0];
  assert.equal(vdd.name, "VDD");
  assert.ok(vdd.nodes.some((n) => n.x === 60 && n.y === 10), "junction on the human segment");
  assert.equal(vdd.edges.filter((e) => e.layer === "metal1").length, 3, "split halves keep metal1");

  // Human vertices and segments stay read-only; own ones are editable.
  const near = ok(await call(app, dieId, "find_wires_near", { x: 10, y: 10, radius: 2 }));
  assert.equal(near.nodes[0].nodeId, "a");
  assert.equal(near.nodes[0].mcpOwned, false);
  assert.equal((await call(app, dieId, "update_wire", { netId: "human", moveNodes: [{ nodeId: "a", x: 0, y: 0 }] })).isError, true);
  assert.equal((await call(app, dieId, "update_wire", { netId: "human", name: "GND" })).isError, true);
  const junction = tap.nodeIds[0];
  const moveJunction = await call(app, dieId, "update_wire", { netId: "human", moveNodes: [{ nodeId: junction, x: 60, y: 30 }] });
  assert.equal(moveJunction.isError, true, "junction touches human-derived halves");
  ok(await call(app, dieId, "update_wire", { netId: "human", setLayers: [{ edgeId: tap.edgeIds[0], layer: "poly" }] }));

  // Deleting the tap segment disconnects the old Net 1 part again → split back out.
  const del = ok(await call(app, dieId, "delete_wire", { netId: "human", edgeIds: [tap.edgeIds[0]] }));
  assert.equal(del.netIds.length, 2);
  all = await nets(app, dieId);
  assert.ok(all.find((n) => n.id === "human")?.nodes.some((n) => n.id === "a"), "human part keeps id");
  const splitOff = all.find((n) => n.id !== "human")!;
  assert.equal(splitOff.name, "VDD (2)");
  ok(await call(app, dieId, "delete_wire", { netId: splitOff.id }));
  assert.equal((await call(app, dieId, "delete_wire", { netId: "human" })).isError, true);

  // Vias.
  assert.equal((await call(app, dieId, "add_via", { x: 60, y: 60, via: "VIA99" })).isError, true);
  const via = ok(await call(app, dieId, "add_via", { x: 60, y: 60, via: "VIA12" }));
  ok(await call(app, dieId, "update_via", { viaId: via.viaId, via: "VIA23" }));
  ok(await call(app, dieId, "delete_via", { viaId: via.viaId }));

  // Undo everything back to the original human net.
  for (;;) {
    const status = (await request(app).get(`/api/dies/${dieId}/mcp`)).body;
    if (status.undo.length === 0) break;
    await request(app).post(`/api/dies/${dieId}/mcp/undo`).expect(200);
  }
  assert.deepEqual(await nets(app, dieId), [human]);
});

test("full edits: any section, human items, one undo step per batch", async () => {
  const { app, dieId } = await createHarness();
  await request(app)
    .put(`/api/dies/${dieId}/comments/human`)
    .send({ id: "human", x: 1, y: 1, text: "mine", authorId: "dev", authorName: "dev", createdAt: "", replies: [] })
    .expect(200);

  const batch = {
    description: "Add inverter",
    operations: [
      { op: "upsert", section: "cellTypes", item: { id: "inv", name: "INV", cropRect: { x: 0, y: 0, width: 40, height: 30 } } },
      { op: "upsert", section: "cells", item: { id: "c1", cellTypeId: "inv", x: 100, y: 100 } },
      { op: "upsert", section: "pins", item: { id: "p1", x: 5, y: 5, pin: 1, name: "VCC" } },
      { op: "set", section: "umPerPx", value: 0.25 },
      { op: "delete", section: "comments", id: "human" }
    ]
  };
  const refused = await call(app, dieId, "edit_annotations", batch);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /Full MCP edits are off/);

  await request(app).put(`/api/dies/${dieId}/mcp/settings`).send({ full: true }).expect(200);
  const bad = await call(app, dieId, "edit_annotations", {
    operations: [{ op: "upsert", section: "cells", item: { id: "c2", cellTypeId: "nope", x: 1, y: 1 } }]
  });
  assert.equal(bad.isError, true);
  ok(await call(app, dieId, "edit_annotations", batch));

  let ann = (await request(app).get(`/api/dies/${dieId}/annotations`)).body;
  assert.equal(ann.cells.length, 1);
  assert.equal(ann.pins.length, 1);
  assert.equal(ann.umPerPx, 0.25);
  assert.equal(ann.comments.length, 0);

  // Full edits also lift the ownership rule of the specific tools.
  ok(await call(app, dieId, "add_comment", { x: 3, y: 3, text: "temp" }));
  const status = (await request(app).get(`/api/dies/${dieId}/mcp`)).body;
  assert.equal(status.full, true);
  assert.equal(status.undo[0].summary, "Add inverter (5 ops)");

  await request(app).post(`/api/dies/${dieId}/mcp/undo`).expect(200);
  await request(app).post(`/api/dies/${dieId}/mcp/undo`).expect(200);
  ann = (await request(app).get(`/api/dies/${dieId}/annotations`)).body;
  assert.equal(ann.cells.length, 0);
  assert.equal(ann.cellTypes.length, 0);
  assert.equal(ann.umPerPx, undefined);
  assert.deepEqual(ann.comments.map((c: { id: string }) => c.id), ["human"]);
});

test("renders annotated images and attaches them to comments", async () => {
  const { app, dieId } = await createHarness();
  await request(app)
    .put(`/api/dies/${dieId}/nets/n1`)
    .send({ id: "n1", name: "OUT", nodes: [{ id: "a", x: 20, y: 20 }, { id: "b", x: 300, y: 20 }], edges: [{ id: "ab", from: "a", to: "b", layer: "metal1" }] })
    .expect(200);

  const render = await call(app, dieId, "render_annotated_image", {
    maxSize: 256,
    highlight: ["n1"],
    layers: ["wires", "netLabels", "comments"],
    marks: [{ kind: "arrow", x1: 200, y1: 150, x2: 150, y2: 30, label: "output" }, { kind: "box", x: 10, y: 10, width: 50, height: 30 }]
  });
  assert.equal(render.isError, undefined, render.content[0]?.text);
  assert.equal(render.content[0].type, "image");
  const meta = JSON.parse(render.content[1].text);
  assert.deepEqual(meta.region, { x: 0, y: 0, width: 512, height: 256 });
  assert.equal(meta.width, 256);
  assert.equal(meta.wireLayerColors.metal1, "#2dd4bf");
  assert.equal((await call(app, dieId, "render_annotated_image", { marks: [{ kind: "star" }] })).isError, true);

  // Mode off: the image isn't rendered / stored.
  assert.equal((await call(app, dieId, "add_comment", { x: 5, y: 5, text: "x", image: {} })).isError, true);
  await setMode(app, dieId, "create");
  const added = ok(
    await call(app, dieId, "add_comment", { x: 150, y: 20, text: "OUT runs here", image: { maxSize: 200, highlight: ["n1"], caption: "OUT" } })
  );
  const comment = (await request(app).get(`/api/dies/${dieId}/annotations`)).body.comments[0];
  assert.equal(comment.images[0].id, added.imageId);
  assert.equal(comment.images[0].caption, "OUT");
  const image = await request(app).get(`/api/dies/${dieId}/comment-images/${added.imageId}.jpg`);
  assert.equal(image.status, 200);
  assert.match(image.headers["content-type"] ?? "", /image\/jpeg/);
  assert.equal((await request(app).get(`/api/dies/${dieId}/comment-images/..%2Fannotations.json`)).status, 404);
});

test("region summary and dedicated cell/pin edits", async () => {
  const { app, dieId } = await createHarness();
  await request(app).put(`/api/dies/${dieId}/mcp/settings`).send({ full: true }).expect(200);
  ok(await call(app, dieId, "edit_annotations", {
    operations: [
      { op: "upsert", section: "cellTypes", item: { id: "inv", name: "INV", cropRect: { x: 0, y: 0, width: 40, height: 30 } } }
    ]
  }));
  ok(await call(app, dieId, "edit_cells", { action: "upsert", cellId: "c1", cellTypeId: "inv", x: 10, y: 20 }));
  ok(await call(app, dieId, "edit_pins", { action: "upsert", pinId: "p1", x: 5, y: 5, pin: 1, name: "OUT" }));

  const summary = ok(await call(app, dieId, "get_region_summary", { x: 0, y: 0, width: 100, height: 100 }));
  assert.equal(summary.counts.cells, 1);
  assert.equal(summary.counts.pins, 1);
  assert.deepEqual(summary.cells[0].rect, { x: 10, y: 20, width: 40, height: 30 });

  ok(await call(app, dieId, "edit_cells", { action: "delete", cellId: "c1" }));
  ok(await call(app, dieId, "edit_pins", { action: "delete", pinId: "p1" }));
  const ann = (await request(app).get(`/api/dies/${dieId}/annotations`)).body;
  assert.equal(ann.cells.length, 0);
  assert.equal(ann.pins.length, 0);
});

test("process layers: silicon wire layers, contacts and floorplan layer tags", async () => {
  const { app, dieId } = await createHarness();
  await setWires(app, dieId, true);
  await setMode(app, dieId, "edit");
  // No process: diffusion is not a layer of this die yet.
  assert.equal((await call(app, dieId, "add_wire", { points: [{ x: 10, y: 10 }, { x: 50, y: 10 }], layer: "ndiff" })).isError, true);

  await request(app)
    .put(`/api/dies/${dieId}/config`)
    .send({ process: { kind: "cmos", substrate: "p", layers: ["nwell", "ndiff", "pdiff", "poly"] } })
    .expect(200);
  const info = JSON.parse((await call(app, dieId, "get_die_info", {})).content[0].text);
  assert.equal(info.process.substrate, "P-substrate");
  assert.ok(info.metalStack.wireLayers.includes("nwell"));
  assert.ok(info.metalStack.vias.some((v: { id: string }) => v.id === "CT_NDIFF"));

  ok(await call(app, dieId, "add_wire", { points: [{ x: 10, y: 10 }, { x: 50, y: 10 }], layer: "ndiff" }));
  ok(await call(app, dieId, "add_via", { x: 50, y: 10, via: "CT_NDIFF" }));
  assert.equal((await call(app, dieId, "add_wire", { points: [{ x: 1, y: 1 }, { x: 5, y: 1 }], layer: "pwell" })).isError, true);

  const fp = ok(
    await call(app, dieId, "add_floorplan_region", { name: "bias", kind: "rect", points: [{ x: 0, y: 0 }, { x: 40, y: 40 }], layerTag: "nwell" })
  );
  assert.equal((await request(app).get(`/api/dies/${dieId}/annotations`)).body.floorplanRegions[0].layerTag, "nwell");
  ok(await call(app, dieId, "update_floorplan_region", { regionId: fp.regionId, layerTag: "none" }));
  const ann = (await request(app).get(`/api/dies/${dieId}/annotations`)).body;
  assert.equal(ann.floorplanRegions[0].layerTag, undefined);
  assert.equal(ann.process.kind, "cmos");
});

async function setMode(app: Server, dieId: string, mode: string) {
  await request(app).put(`/api/dies/${dieId}/mcp/settings`).send({ mode }).expect(200);
}

async function setWires(app: Server, dieId: string, wires: boolean) {
  await request(app).put(`/api/dies/${dieId}/mcp/settings`).send({ wires }).expect(200);
}

async function nets(app: Server, dieId: string): Promise<AnnotationNet[]> {
  return (await request(app).get(`/api/dies/${dieId}/annotations`)).body.nets;
}

function ok(result: { isError?: boolean; content: { text: string }[] }) {
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return JSON.parse(result.content[0].text);
}

async function commentText(app: Server, dieId: string, id: string): Promise<string | undefined> {
  const ann = (await request(app).get(`/api/dies/${dieId}/annotations`)).body;
  return ann.comments?.find((c: { id: string }) => c.id === id)?.text;
}

let rpcId = 0;
async function rpc(app: Server, method: string, params: unknown, session?: string) {
  const req = request(app).post("/mcp");
  if (session) req.set("Mcp-Session-Id", session);
  const response = await req.send({ jsonrpc: "2.0", id: ++rpcId, method, params });
  assert.equal(response.status, 200);
  return response.body;
}

const sessions = new Map<Server, string>();
async function call(app: Server, dieId: string, name: string, args: Record<string, unknown>) {
  let session = sessions.get(app);
  if (!session) {
    const init = await request(app)
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { clientInfo: { name: "test-client" } } });
    session = init.headers["mcp-session-id"] as string;
    sessions.set(app, session);
  }
  const body = await rpc(app, "tools/call", { name, arguments: { dieId, ...args } }, session);
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  return body.result;
}

async function createHarness(options: { approve?: boolean } = {}) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chiptool-mcp-test-"));
  tempRoots.push(dataRoot);
  await ensureDataStore(dataRoot);
  const server = createServer(
    createApp({
      dataRoot,
      tileSize: 128,
      limitInputPixels: false,
      tileConcurrency: 2,
      mlSidecarUrl: "http://127.0.0.1:1",
      mlPredictPad: 0,
      mcpApprovalWaitMs: 300
    })
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  tempServers.push(server);

  const image = await sharp({ create: { width: 512, height: 256, channels: 3, background: { r: 200, g: 120, b: 80 } } })
    .png()
    .toBuffer();
  const imported = await request(server)
    .post("/api/dies/import")
    .attach("file", image, { filename: "die.png", contentType: "image/png" });
  assert.equal(imported.status, 202);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = (await request(server).get(`/api/import-jobs/${imported.body.id}`)).body;
    if (job.status === "completed") {
      const dieId = job.dieId as string;
      if (options.approve !== false) {
        assert.equal((await request(server).put(`/api/mcp/access/${dieId}`).send({ state: "approved" })).status, 200);
      }
      return { app: server, dataRoot, dieId };
    }
    if (job.status === "failed") throw new Error(`import failed: ${job.error}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for import");
}
