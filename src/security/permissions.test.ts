import { describe, expect, it } from "bun:test";

import {
  SESSION_EXCLUDED_REASONS,
  createPermissionStore,
  resolvePermissions,
} from "./permissions.ts";

import type { PermissionPrompter, PermissionRequest, PermissionResponse } from "./permissions.ts";

function mockPrompter(answers: PermissionResponse[]): {
  prompter: PermissionPrompter;
  calls: PermissionRequest[][];
} {
  const calls: PermissionRequest[][] = [];
  const prompter: PermissionPrompter = (requests) => {
    calls.push([...requests]);
    // Return only as many answers as requests asked for (respects batching).
    return Promise.resolve(answers.splice(0, requests.length));
  };
  return { prompter, calls };
}

const req = (reason: string, description = "cmd"): PermissionRequest => ({
  tool: "bash",
  description,
  reason,
});

const alwaysAllowOncePrompter: PermissionPrompter = () => Promise.resolve(["allow"]);

describe("resolvePermissions", () => {
  it("returns an empty array for an empty request list", async () => {
    const store = createPermissionStore();
    const { prompter, calls } = mockPrompter([]);
    expect(await resolvePermissions([], prompter, store)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("passes through a single allow", async () => {
    const store = createPermissionStore();
    const { prompter } = mockPrompter(["allow"]);
    const decisions = await resolvePermissions([req("rm -rf")], prompter, store);
    expect(decisions).toEqual(["allow"]);
  });

  it("passes through a single deny", async () => {
    const store = createPermissionStore();
    const { prompter } = mockPrompter(["deny"]);
    const decisions = await resolvePermissions([req("force push")], prompter, store);
    expect(decisions).toEqual(["deny"]);
  });

  it("remembers allow_session so future batches skip the prompt", async () => {
    const store = createPermissionStore();
    const first = mockPrompter(["allow_session"]);
    let decisions = await resolvePermissions([req("recursive delete")], first.prompter, store);
    expect(decisions).toEqual(["allow"]);
    expect(store.snapshot().has("recursive delete")).toBe(true);

    // Second batch with the same reason — prompter should NOT be called.
    const second = mockPrompter([]);
    decisions = await resolvePermissions(
      [req("recursive delete"), req("recursive delete", "other cmd")],
      second.prompter,
      store,
    );
    expect(decisions).toEqual(["allow", "allow"]);
    expect(second.calls).toHaveLength(0);
  });

  it("only prompts for reasons not yet in the store", async () => {
    const store = createPermissionStore();
    // Prime the store with one reason.
    await resolvePermissions(
      [req("already approved")],
      mockPrompter(["allow_session"]).prompter,
      store,
    );

    const fresh = mockPrompter(["deny"]);
    const decisions = await resolvePermissions(
      [req("already approved"), req("new thing")],
      fresh.prompter,
      store,
    );
    expect(decisions).toEqual(["allow", "deny"]);
    // Prompter saw only the unresolved request.
    expect(fresh.calls[0]).toHaveLength(1);
    expect(fresh.calls[0]?.[0]?.reason).toBe("new thing");
  });

  describe.each([...SESSION_EXCLUDED_REASONS])("excluded reason: %s", (reason) => {
    it("downgrades allow_session to a one-time allow and re-prompts next time", async () => {
      const store = createPermissionStore();
      const { prompter } = mockPrompter(["allow_session"]);
      const decisions = await resolvePermissions([req(reason)], prompter, store);
      expect(decisions).toEqual(["allow"]);
      expect(store.snapshot().has(reason)).toBe(false);

      const { prompter: p2, calls: c2 } = mockPrompter(["deny"]);
      const d2 = await resolvePermissions([req(reason)], p2, store);
      expect(d2).toEqual(["deny"]);
      expect(c2).toHaveLength(1);
    });
  });

  it("handles a mixed batch: one store-approved, one new, one duplicate-new", async () => {
    const store = createPermissionStore();
    // Seed: "rm category" is approved for session.
    await resolvePermissions([req("rm category")], mockPrompter(["allow_session"]).prompter, store);

    const { prompter, calls } = mockPrompter(["deny", "allow"]);
    const decisions = await resolvePermissions(
      [req("rm category"), req("force push"), req("sql drop")],
      prompter,
      store,
    );
    expect(decisions).toEqual(["allow", "deny", "allow"]);
    // Only the two novel reasons reach the prompter.
    expect(calls[0]?.map((r) => r.reason)).toEqual(["force push", "sql drop"]);
  });

  it("preserves order when resolving a mix of store + prompter decisions", async () => {
    const store = createPermissionStore();
    await resolvePermissions(
      [req("pre-approved")],
      mockPrompter(["allow_session"]).prompter,
      store,
    );

    // Store-allowed request sandwiched between two prompter requests.
    const { prompter } = mockPrompter(["deny", "allow"]);
    const decisions = await resolvePermissions(
      [req("new-1"), req("pre-approved"), req("new-2")],
      prompter,
      store,
    );
    expect(decisions).toEqual(["deny", "allow", "allow"]);
  });

  it("throws when the prompter returns the wrong number of responses", async () => {
    const store = createPermissionStore();
    await expect(
      resolvePermissions([req("a"), req("b")], alwaysAllowOncePrompter, store),
    ).rejects.toThrow(/Permission prompter/);
  });

  it("two stores don't share approvals (no cross-contamination)", async () => {
    const storeA = createPermissionStore();
    const storeB = createPermissionStore();

    await resolvePermissions([req("cat-1")], mockPrompter(["allow_session"]).prompter, storeA);
    expect(storeA.snapshot().has("cat-1")).toBe(true);
    expect(storeB.snapshot().has("cat-1")).toBe(false);

    // Store B still has to prompt for the same reason.
    const { calls } = mockPrompter(["allow"]);
    const bPrompter = mockPrompter(["allow"]);
    await resolvePermissions([req("cat-1")], bPrompter.prompter, storeB);
    expect(bPrompter.calls).toHaveLength(1);
    // First mock was never used.
    expect(calls).toHaveLength(0);
  });

  it("store.clear wipes approvals", async () => {
    const store = createPermissionStore();
    await resolvePermissions([req("cat-1")], mockPrompter(["allow_session"]).prompter, store);
    expect(store.snapshot().has("cat-1")).toBe(true);
    store.clear();
    expect(store.snapshot().has("cat-1")).toBe(false);
  });
});
