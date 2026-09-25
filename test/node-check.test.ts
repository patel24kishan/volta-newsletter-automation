import { describe, expect, it } from "vitest";
import { MIN_NODE, nodeVersionProblem } from "../src/install/node-check.js";

describe("the Node version check", () => {
  it("accepts 22.13 and anything newer", () => {
    expect(nodeVersionProblem("v22.13.0")).toBeUndefined();
    expect(nodeVersionProblem("v22.14.1")).toBeUndefined();
    expect(nodeVersionProblem("v23.4.0")).toBeUndefined();
    expect(nodeVersionProblem("v24.16.0")).toBeUndefined();
    expect(nodeVersionProblem(process.version)).toBeUndefined();
  });

  it("refuses older Nodes with one sentence that says what to do", () => {
    const p = nodeVersionProblem("v22.12.0");
    expect(p).toContain(`Node ${MIN_NODE} or newer`);
    expect(p).toContain("this is Node 22.12.0");
    expect(p).toMatch(/Install a newer Node/);
    expect(nodeVersionProblem("v20.11.1")).toBeDefined();
    expect(nodeVersionProblem("v18.20.0")).toBeDefined();
  });

  it("does not refuse a version it cannot read", () => {
    expect(nodeVersionProblem("unknown")).toBeUndefined();
  });
});
