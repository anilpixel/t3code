import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  submittedCredentials: [] as string[],
  rejectWith: null as string | null,
}));

vi.mock(import("../../environments/primary"), async (original) => ({
  ...(await original()),
  submitServerAuthCredential: vi.fn(async (credential: string) => {
    state.submittedCredentials.push(credential);
    if (state.rejectWith !== null) {
      throw new Error(state.rejectWith);
    }
  }),
}));

import { render } from "../../../test/render";
import { PairingRouteSurface } from "./PairingRouteSurface";

function setup() {
  state.submittedCredentials = [];
  state.rejectWith = null;
  window.history.replaceState({}, document.title, "/pair");
}

it("consumes pairing tokens navigated via URL hash in an already-open /pair tab", async () => {
  setup();
  const onAuthenticated = vi.fn();
  state.rejectWith = "Invalid pairing token. Check the token and try again.";

  // PairingRouteSurface renders outside authenticated route chrome on /pair.
  await using screen = await render(
    <PairingRouteSurface
      auth={{
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      }}
      onAuthenticated={onAuthenticated}
    />,
    { router: false },
  );

  expect(state.submittedCredentials).toEqual([]);

  window.history.replaceState({}, document.title, "/pair#token=EXPIRED_TOKEN");
  window.dispatchEvent(new HashChangeEvent("hashchange"));

  await vi.waitFor(() => {
    expect(state.submittedCredentials).toEqual(["EXPIRED_TOKEN"]);
  });
  expect(window.location.hash).toBe("");
  await expect
    .element(screen.getByText("Invalid pairing token. Check the token and try again."))
    .toBeVisible();
  expect(onAuthenticated).not.toHaveBeenCalled();

  state.rejectWith = null;
  window.history.replaceState({}, document.title, "/pair#token=FRESH_TOKEN");
  window.dispatchEvent(new HashChangeEvent("hashchange"));

  await vi.waitFor(() => {
    expect(state.submittedCredentials).toEqual(["EXPIRED_TOKEN", "FRESH_TOKEN"]);
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });
  expect(window.location.hash).toBe("");
});
