import { randomUUID } from "node:crypto";
import type { Session } from "./types";

const store = new Map<string, Session>();

export function _resetStoreForTests() {
  store.clear();
}

export function createSession(problemText: string): Session {
  const session: Session = {
    id: randomUUID(),
    problem_text: problemText,
    methods: [],
    steps: [],
    assembled_lean: "",
    build_status: "idle",
    created_at: Date.now(),
  };
  store.set(session.id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return store.get(id);
}

export function updateSession(id: string, patch: Partial<Session>): Session {
  const cur = store.get(id);
  if (!cur) throw new Error(`session not found: ${id}`);
  const next = { ...cur, ...patch, id: cur.id };
  store.set(id, next);
  return next;
}

export function resetStepsForMethod(id: string, methodId: string): Session {
  return updateSession(id, {
    selected_method_id: methodId,
    steps: [],
    assembled_lean: "",
    build_status: "idle",
  });
}
