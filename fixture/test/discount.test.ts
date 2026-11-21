import { test } from "node:test";
import assert from "node:assert/strict";
import { checkout } from "../src/orders/checkout.ts";

test("a known discount changes the total", () => {
  assert.equal(checkout(1000, new URLSearchParams({ code: "SAVE10" })), 900);
});
test("an unknown code leaves the total unchanged", () => {
  assert.equal(checkout(1000, new URLSearchParams({ code: "UNKNOWN" })), 1000);
});
test("an apostrophe is part of the discount code", () => {
  assert.equal(checkout(1000, new URLSearchParams({ code: "O'NEIL" })), 850);
});
