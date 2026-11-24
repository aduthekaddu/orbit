import type { SubmitEvent } from "./submit-state";

// Re-enable the auth submit button if navigation never leaves the page.
export const AUTH_REDIRECT_RESET_MS = 5000;

export type AuthResult = { error?: { message?: string | null } | null };
export type AuthRouter = { push: (href: string) => void; refresh: () => void };

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
