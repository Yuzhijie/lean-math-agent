import { describe, expect, it } from "vitest";
import { INITIAL_STATE, reducer } from "@/app/hooks/useProofSession";

describe("solve job state in the page", () => {
  it("job id, queue place, cancel requested, cancelled", () => {
    let s = reducer({ ...INITIAL_STATE, busy: "solve-all" }, { type: "SOLVE_JOB", jobId: "j1", sessionId: "s1" });
    expect(s).toMatchObject({ jobId: "j1", sessionId: null });
    s = reducer(s, { type: "SOLVE_PROGRESS", stage: "queued", detail: "Queued: 1 solve(s) ahead", position: 2 });
    expect(s.queuePosition).toBe(2);
    s = reducer(s, { type: "SOLVE_PROGRESS", stage: "classifying", detail: "…" });
    expect(s.queuePosition).toBeNull();
    s = reducer(s, { type: "SOLVE_CANCELLING" });
    expect(s.cancelling).toBe(true);
    s = reducer(s, { type: "SOLVE_CANCELLED", detail: "Cancelled" });
    expect(s).toMatchObject({ busy: null, jobId: null, cancelling: false });
    expect(s.solveEvents.at(-1)).toEqual({ stage: "cancelled", detail: "Cancelled" });
  });
});
