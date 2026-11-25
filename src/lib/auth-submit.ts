import { idleSubmit, submitTransition, type SubmitEvent, type SubmitState } from "./submit-state";

// Re-enable the auth submit button if navigation never leaves the page.
export const AUTH_REDIRECT_RESET_MS = 5000;

export type AuthSubmitEvent = SubmitEvent | { type: "timeout" };
export type AuthResult = { error?: { message?: string | null } | null };
export type AuthRouter = { push: (href: string) => void; refresh: () => void };

// Hold `succeeded` until navigation leaves the page or the redirect timer expires,
// so editing a field in flight cannot unlock submit and send a second auth request.
export function authSubmitTransition(state: SubmitState, event: AuthSubmitEvent): SubmitState {
  if (event.type === "timeout") return state.status === "succeeded" ? idleSubmit : state;
  if (state.status === "succeeded") return state;
  return submitTransition(state, event);
}

export async function runAuthSubmit({
  request,
  router,
  dispatch,
  fallbackError,
}: {
  request: () => Promise<AuthResult>;
  router: AuthRouter;
  dispatch: (event: SubmitEvent) => void;
  fallbackError: string;
}) {
  dispatch({ type: "submit" });
  try {
    const result = await request();
    if (result.error) {
      dispatch({ type: "fail", error: result.error.message || fallbackError });
      return;
    }
    router.push("/");
    router.refresh();
    dispatch({ type: "succeed" });
  } catch {
    dispatch({ type: "fail", error: "Network error" });
  }
}
