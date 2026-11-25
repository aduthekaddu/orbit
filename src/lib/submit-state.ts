// One form submission: idle until submitted, then pending until it fails or succeeds.
// `succeeded` holds the success notice until the user edits a field or it times out.
export type SubmitState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "failed"; error: string }
  | { status: "succeeded" };

export type SubmitEvent =
  | { type: "submit" }
  | { type: "fail"; error: string }
  | { type: "succeed" }
  | { type: "edit" };

export const idleSubmit: SubmitState = { status: "idle" };

export function submitTransition(state: SubmitState, event: SubmitEvent): SubmitState {
  switch (event.type) {
    case "submit":
      return state.status === "pending" ? state : { status: "pending" };
    case "fail":
      return state.status === "pending" ? { status: "failed", error: event.error } : state;
    case "succeed":
      return state.status === "pending" ? { status: "succeeded" } : state;
    case "edit":
      return state.status === "pending" ? state : idleSubmit;
  }
}
