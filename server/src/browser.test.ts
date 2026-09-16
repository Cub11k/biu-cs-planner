import { expect, it, vi } from "vitest";
import { browserCommand, openInBrowser, type Spawner } from "./browser.ts";

const URL = "http://localhost:8900/#t=abc";

it("opens the URL with the platform's own command", () => {
  expect(browserCommand("darwin", URL)).toEqual({ command: "open", args: [URL] });
  expect(browserCommand("linux", URL)).toEqual({ command: "xdg-open", args: [URL] });
});

it("gives Windows the empty title cmd's start needs before the URL", () => {
  // without the "" the URL becomes the window title and no browser opens
  expect(browserCommand("win32", URL)).toEqual({
    command: "cmd",
    args: ["/c", "start", "", URL],
  });
});

it("never hands the URL to a shell", () => {
  const spawner = vi.fn(() => fakeChild()) as unknown as Spawner;

  openInBrowser(URL, "linux", spawner);

  expect(spawner).toHaveBeenCalledWith("xdg-open", [URL], {
    detached: true,
    stdio: "ignore",
  });
});

it("lets the server run on a machine with no way to open a browser", () => {
  const spawner = (() => {
    throw new Error("spawn xdg-open ENOENT");
  }) as unknown as Spawner;

  // the URL has already been printed; a missing xdg-open is not a failed launch
  expect(() => openInBrowser(URL, "linux", spawner)).not.toThrow();
});

function fakeChild() {
  return { on: () => {}, unref: () => {} };
}
