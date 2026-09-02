import assert from "node:assert/strict";
import { test } from "node:test";

import { documentText, normalizeWhitespace, sha256Fingerprint, tokenize, tokenizeWithBigrams } from "../lib/text.mjs";

test("tokenize drops stopwords and short tokens", () => {
  // "this", "paper", "the", "and", "methods" (-> "method") are all stopwords;
  // "ai"/"ml" are shorter than three characters and are dropped.
  const tokens = tokenize("This paper uses the transformer and neural methods with AI ML");
  assert.ok(!tokens.includes("the"));
  assert.ok(!tokens.includes("and"));
  assert.ok(!tokens.includes("method"));
  assert.ok(!tokens.includes("ai"));
  assert.ok(!tokens.includes("ml"));
  assert.ok(tokens.includes("neural"));
  assert.deepEqual(tokenize("We AI ML"), []);
});

test("tokenize is deterministic and lowercase", () => {
  assert.deepEqual(tokenize("Neural Networks"), tokenize("neural networks"));
  assert.ok(tokenize("Neural Networks").includes("neural"));
});

test("tokenizeWithBigrams joins adjacent tokens with underscores", () => {
  const expanded = tokenizeWithBigrams("Neural language models");
  assert.deepEqual(expanded, [
    "neural",
    "language",
    "model",
    "neural_language",
    "language_model",
  ]);
});

test("normalizeWhitespace collapses all whitespace runs", () => {
  assert.equal(normalizeWhitespace("  a \n\t b  "), "a b");
  assert.equal(normalizeWhitespace(null), "");
});

test("sha256Fingerprint has the sha256:<64 hex> shape and is stable", () => {
  const fingerprint = sha256Fingerprint("conference-atlas");
  assert.match(fingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(sha256Fingerprint("conference-atlas"), fingerprint);
  assert.notEqual(sha256Fingerprint("conference-atlas"), sha256Fingerprint("conference-atlas-v2"));
});

test("documentText includes the Title: prefix and Abstract: body", () => {
  const text = documentText({
    title: "  Atlas of   Neural Maps ",
    abstract: "\nWe study maps of ideas.\n",
  });
  assert.equal(text, "Title: Atlas of Neural Maps\nAbstract: We study maps of ideas.");
});

test("documentText falls back to Context: from tags when abstract is empty", () => {
  const text = documentText({
    title: "Tagged Record",
    abstract: "",
    categoryTags: ["Robotics"],
    areaTags: ["Manipulation"],
  });
  assert.match(text, /^Title: Tagged Record$/mu);
  assert.match(text, /^Context: Robotics Manipulation$/mu);
  assert.ok(!text.includes("Abstract:"));
});
