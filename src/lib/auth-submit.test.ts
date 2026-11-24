import assert from "node:assert/strict";
import test from "node:test";
import { runAuthSubmit } from "./auth-submit";
import { idleSubmit, submitTransition, type SubmitEvent, type SubmitState } from "./submit-state";

function makeMachine() {
  let state: SubmitState = idleSubmit;
  return {
    dispatch(event: SubmitEvent) {
      state = submitTransition(state, event);
    },
    state() {
      return state;
    },
  };
}

test("a successful auth submit navigates and holds succeeded until an edit or timeout resets it", async () => {
  const machine = makeMachine();
  const calls: string[] = [];
  await runAuthSubmit({
    request: async () => ({ error: null }),
    router: {
      push: (href) => calls.push(`push:${href}`),
      refresh: () => calls.push("refresh"),
    },
    dispatch: machine.dispatch,
    fallbackError: "Could not sign in",
  });

  assert.deepEqual(calls, ["push:/", "refresh"]);
  assert.deepEqual(machine.state(), { status: "succeeded" });

  machine.dispatch({ type: "edit" });
  assert.equal(machine.state(), idleSubmit);
});

test("a throwing router.push fails the submit instead of stranding it in succeeded", async () => {
  const machine = makeMachine();
  await runAuthSubmit({
    request: async () => ({ error: null }),
    router: {
      push: () => {
        throw new Error("navigation blocked");
      },
      refresh: () => {},
    },
    dispatch: machine.dispatch,
    fallbackError: "Could not sign in",
  });

  assert.deepEqual(machine.state(), { status: "failed", error: "Network error" });
});

test("a throwing router.refresh fails the submit instead of stranding it in succeeded", async () => {
  const machine = makeMachine();
  await runAuthSubmit({
    request: async () => ({ error: null }),
    router: {
      push: () => {},
      refresh: () => {
        throw new Error("refresh blocked");
      },
    },
    dispatch: machine.dispatch,
    fallbackError: "Could not create account",
  });

  assert.deepEqual(machine.state(), { status: "failed", error: "Network error" });
});

test("an auth error shows its message or the fallback without navigating", async () => {
  const calls: string[] = [];
  const router = {
    push: (href: string) => calls.push(`push:${href}`),
    refresh: () => calls.push("refresh"),
  };

  const withMessage = makeMachine();
  await runAuthSubmit({
    request: async () => ({ error: { message: "Invalid email or password" } }),
    router,
    dispatch: withMessage.dispatch,
    fallbackError: "Could not sign in",
  });
  assert.deepEqual(withMessage.state(), { status: "failed", error: "Invalid email or password" });

  const withFallback = makeMachine();
  await runAuthSubmit({
    request: async () => ({ error: {} }),
    router,
    dispatch: withFallback.dispatch,
    fallbackError: "Could not create account",
  });
  assert.deepEqual(withFallback.state(), { status: "failed", error: "Could not create account" });
  assert.deepEqual(calls, []);
});

test("a rejected auth request reports a network error", async () => {
  const machine = makeMachine();
  await runAuthSubmit({
    request: async () => {
      throw new Error("offline");
    },
    router: { push: () => {}, refresh: () => {} },
    dispatch: machine.dispatch,
    fallbackError: "Could not sign in",
  });

  assert.deepEqual(machine.state(), { status: "failed", error: "Network error" });
});
