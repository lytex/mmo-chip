import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  answerPrompt,
  cancelPrompt,
  cancelPromptsForDie,
  clearPromptsForTests,
  createPrompt,
  listPendingPrompts,
  PromptAnswerError,
  setPromptChangeHandler
} from "./userPrompt.js";

afterEach(() => {
  setPromptChangeHandler(null);
  clearPromptsForTests();
});

function create(overrides: Partial<Parameters<typeof createPrompt>[0]> = {}) {
  return createPrompt({
    dieId: "die-1",
    dieName: "Test die",
    clientName: "unit-test",
    question: "Proceed?",
    kind: "confirm",
    options: [
      { id: "yes", label: "Yes", role: "approve" },
      { id: "no", label: "No", role: "reject" }
    ],
    allowFreeText: false,
    multiSelect: false,
    timeoutMs: 5_000,
    ...overrides
  });
}

test("times out unanswered prompts without approval", async () => {
  const { prompt, done } = create({ timeoutMs: 25 });
  assert.equal(listPendingPrompts().length, 1);
  const result = await done;
  assert.equal(result.promptId, prompt.id);
  assert.equal(result.answered, false);
  assert.equal(result.reason, "timeout");
  assert.equal(result.approved, null);
  assert.ok(result.elapsedMs >= 20);
  assert.equal(listPendingPrompts().length, 0);
});

test("approval comes only from a single approve/reject option", async () => {
  const { prompt, done } = create();
  const change = answerPrompt(prompt.id, { optionId: "yes" }, "alice");
  assert.equal(change?.approved, true);
  assert.equal(change?.answeredBy, "alice");
  const result = await done;
  assert.equal(result.answered, true);
  assert.deepEqual(result.labels, ["Yes"]);
  assert.equal(result.approved, true);
  assert.equal(result.reason, undefined);
});

test("multi-select answers carry every option but no approval", async () => {
  const { prompt, done } = create({
    kind: "choose",
    multiSelect: true,
    options: [
      { id: "a", label: "A", role: "approve" },
      { id: "b", label: "B" },
      { id: "c", label: "C" }
    ]
  });
  answerPrompt(prompt.id, { optionIds: ["a", "c"] }, null);
  const result = await done;
  assert.deepEqual(result.optionIds, ["a", "c"]);
  assert.deepEqual(result.labels, ["A", "C"]);
  assert.equal(result.approved, null, "two options are a combination, not a yes/no");
});

test("a cancel option settles as cancelled rather than an answer", async () => {
  const { prompt, done } = create({
    options: [
      { id: "yes", label: "Yes", role: "approve" },
      { id: "later", label: "Not now", role: "cancel" }
    ]
  });
  const result = answerPrompt(prompt.id, { optionId: "later" }, null);
  assert.equal(result?.answered, false);
  assert.equal(result?.reason, "cancelled");
  assert.equal((await done).reason, "cancelled");
});

test("bad answers are refused and leave the prompt open", async () => {
  const { prompt, done } = create({
    allowFreeText: true,
    fields: [
      { id: "name", label: "Name", type: "text", required: true },
      { id: "vdd", label: "VDD", type: "number", default: 5 },
      { id: "mode", label: "Mode", type: "select", options: [{ value: "a", label: "A" }] }
    ]
  });
  assert.throws(() => answerPrompt(prompt.id, { optionId: "maybe" }, null), PromptAnswerError);
  assert.throws(() => answerPrompt(prompt.id, { optionIds: ["yes", "no"] }, null), PromptAnswerError);
  assert.throws(() => answerPrompt(prompt.id, { optionId: "yes" }, null), /Name/);
  assert.throws(() => answerPrompt(prompt.id, {}, null), PromptAnswerError);
  assert.equal(listPendingPrompts().length, 1);

  const ok = answerPrompt(prompt.id, { optionId: "yes", fields: { name: "MERGED" } }, null);
  assert.deepEqual(ok?.fields, { name: "MERGED", vdd: 5 });
  assert.equal((await done).approved, true);

  // Once settled, the same id is simply gone.
  assert.equal(answerPrompt(prompt.id, { optionId: "yes" }, null), null);
});

test("each appearance, answer and dismissal notifies the GUI", async () => {
  let changes = 0;
  setPromptChangeHandler(() => {
    changes += 1;
  });
  const { prompt, done } = create();
  assert.equal(changes, 1);
  cancelPrompt(prompt.id, "bob");
  assert.equal(changes, 2);
  const result = await done;
  assert.equal(result.reason, "cancelled");
  assert.equal(result.answeredBy, "bob");
});

test("closing a die cancels only that die's questions", async () => {
  const one = create({ dieId: "die-1" });
  const other = create({ dieId: "die-2" });
  assert.equal(cancelPromptsForDie("die-1", null), 1);
  assert.deepEqual(
    listPendingPrompts().map((entry) => entry.dieId),
    ["die-2"]
  );
  assert.equal((await one.done).reason, "cancelled");
  assert.equal(cancelPromptsForDie("die-2", null), 1);
  assert.equal((await other.done).reason, "cancelled");
});
