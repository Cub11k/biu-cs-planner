/**
 * The student's preferences, as the page reaches them: the two routes #115 added, behind the
 * typed client and nothing else (`docs/design.md`, "Architecture"; ADR-0002).
 *
 * Beside the components rather than inside one, for the same reason `history.ts` and
 * `timetable/picks.ts` are: the requests and every answer the API can give are testable against
 * a fake fetch, without a browser. Every shape below is read off the contract with
 * `InferResponseType` and none is redeclared here, so a refusal added to the API is a compile
 * error in the component that has to say it rather than a sentence that silently never shows.
 *
 * **Where a preference lives is ADR-0014's decision and not this module's.** A per-device display
 * preference belongs to the browser's own store — that is the colour scheme, and `./scheme.ts`
 * keeps it in `localStorage`. A preference about the person or the document belongs in the State
 * File, and a language is that kind: a Hebrew speaker wants Hebrew on every device they own. So
 * this module reads and writes a language over HTTP, and nothing here mirrors it into the browser.
 *
 * **What the first paint does, and why it is not a guess.** The page cannot know the language
 * until it has read a State File, so the first render is `en`/`ltr` and the document flips when
 * the answer lands — a flash of left-to-right for a Hebrew student, once, on a same-origin
 * loopback GET. The two alternatives were weighed and turned down:
 *
 *   - **Holding the first paint** until the answer arrives. The answer may never arrive — the
 *     server is not running, or this page has no launch token — so a hold needs a timeout, which
 *     is this flash with extra steps and a blank page in front of it. `main.tsx` can apply the
 *     scheme before React mounts because `localStorage` is synchronous; nothing makes an HTTP
 *     answer synchronous.
 *   - **Seeding from `navigator.language`**, which is the only signal there is on a first run. It
 *     cannot work as the code stands, and the reason is concrete rather than a preference:
 *     `settingsSchema` gives `language` the non-null default `"en"`, so nothing above `core` can
 *     tell *never chosen* from *chose English*. A guess would therefore be overwritten by the
 *     default the moment the answer landed — or, if it were written to the file to make it stick,
 *     would overwrite a deliberate English choice with Hebrew. Making that distinction expressible
 *     is a change to `core`'s schema and belongs in its own ticket.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import type { ApiClient } from "./changes.ts";
import { LANGUAGES, type Language } from "./i18n/strings.ts";
import type { InferRequestType, InferResponseType } from "hono/client";

type SettingsRoutes = ApiClient["api"]["settings"];
type ReadRoute = SettingsRoutes["$get"];
type SaveRoute = SettingsRoutes["$patch"];

type Answer = InferResponseType<ReadRoute>;

/** The answer that carries the preferences; the other carries the reason and the Warnings. */
type ServedSettings = Extract<Answer, { language: unknown }>;

/** Why the API would not serve or change the preferences, in one word. */
export type SettingsRefusal = Extract<Answer, { reason: unknown }>["reason"];

/**
 * A Warning the answer carried. `settings-unreadable` is the one this ticket is about: `core`
 * raises it per field it could not read, and something has to show it — a preference silently
 * back at its default is the one a student cannot tell from a preference they never set.
 */
export type SettingsWarning = ServedSettings["warnings"][number];

/**
 * Which revision of the State File the preferences were read from, and what a change made on
 * them has to be based on (docs/design.md, "External edits"). Opaque: held and handed back, never
 * taken apart, and never compared for anything but equality. `undefined` is the claim that there
 * is no State File yet, which the server fails closed on when there is one — so a page with no
 * revision in hand must not send a change at all rather than send one (#111).
 */
export type SettingsVersion = ServedSettings["version"];

/** The preferences to change, and only those. A field not named is a field left alone. */
export type SettingsChange = {
  language?: Language;
  examSpacingDays?: number;
};

export type SettingsResult =
  | {
      kind: "served";
      /**
       * `undefined` when the API served a language this build has no strings for. Not an error
       * and not a crash: `t()` would index the translation tables with it and render nothing, so
       * an unrecognised value is read as *never told* and whatever is on screen is kept —
       * `./scheme.ts` gives every way of not knowing that same one answer.
       */
      language: Language | undefined;
      examSpacingDays: number;
      version: SettingsVersion;
      warnings: SettingsWarning[];
    }
  | { kind: "refused"; reason: SettingsRefusal | undefined; warnings: SettingsWarning[] }
  /** This page has no launch token, so the server will not talk to it (ADR-0004). */
  | { kind: "unauthorized" }
  /** The request never arrived: the server is not running, or not running here. */
  | { kind: "unreachable" };

/** The guard answers before the route does, so its status is not one of the route's. */
const UNAUTHORIZED = 401;

/**
 * The language the first render is in, before any State File has been read.
 *
 * The same default `core`'s `settingsSchema` gives the field, deliberately: the page and the file
 * agree about what "nothing chosen" looks like, so the commonest first paint — a student who has
 * chosen nothing — is already correct and flips to nothing at all.
 */
export const FIRST_PAINT_LANGUAGE: Language = "en";

/** A language the translation files have strings for, or nothing. */
const languageOf = (served: string): Language | undefined =>
  LANGUAGES.find((known) => known === served);

/** Every answer read the same way, so one place decides what each status means. */
async function read(answer: Response & { ok: boolean; status: number }): Promise<SettingsResult> {
  if (!answer.ok) {
    // widened deliberately: the launch token guard rejects before the route runs, so 401 is not
    // among the answers the contract knows about
    const status: number = answer.status;
    if (status === UNAUTHORIZED) return { kind: "unauthorized" };

    const refused = (await answer.json()) as {
      reason?: SettingsRefusal;
      warnings?: SettingsWarning[];
    };
    return { kind: "refused", reason: refused.reason, warnings: refused.warnings ?? [] };
  }

  const body = (await answer.json()) as ServedSettings;
  return {
    kind: "served",
    language: languageOf(body.language),
    examSpacingDays: body.examSpacingDays,
    version: body.version,
    warnings: body.warnings,
  };
}

/**
 * Sends one request and reads the answer **outside** the catch: only the request failing is the
 * server not being there. An answer this module cannot make sense of is a contract problem, and
 * calling it "unreachable" would send the student to look at a server that answered them.
 */
async function ask(
  send: () => Promise<Response & { ok: boolean; status: number }>,
): Promise<SettingsResult> {
  let answer: Response & { ok: boolean; status: number };
  try {
    answer = await send();
  } catch {
    return { kind: "unreachable" };
  }
  return read(answer);
}

/** The preferences the State File holds, and the revision a change has to be based on. */
export async function fetchSettings(client: ApiClient): Promise<SettingsResult> {
  return ask(() => client.api.settings.$get());
}

/**
 * Changes the preferences named and answers with what the file holds afterwards.
 *
 * `basedOn` is a parameter rather than something this module remembers, exactly as it is in
 * `timetable/picks.ts`: a module that kept "the last version I saw" would happily save a second
 * tab's change onto a revision the first tab replaced.
 *
 * The route parses its body with `bodyAs` rather than a validator, so the contract types the path
 * and the answer but not the body — which is why the request is cast, as the Pick routes' are.
 */
export async function saveSettings(
  client: ApiClient,
  change: SettingsChange,
  basedOn: SettingsVersion,
): Promise<SettingsResult> {
  const request = { json: { ...change, basedOn } } as InferRequestType<SaveRoute>;
  return ask(() => client.api.settings.$patch(request));
}

/**
 * What happened to a change the student asked for, when what happened was *not that*.
 *
 * There is no `moved` arm and that is the point: a language that changed flips the whole document,
 * which is its own account and needs no sentence beside it. What needs saying is a change that did
 * not happen — and a preference change *can* fail, because it is a change to a guarded document.
 */
export type SettingsNotice =
  | { kind: "refused"; reason: SettingsRefusal | undefined }
  | { kind: "unauthorized" }
  | { kind: "unreachable" };

export type UseSettingsOptions = {
  client?: ApiClient;
  /**
   * How many times the Workspace has changed since the page loaded. Named among this hook's
   * dependencies for the same reason a screen names it among its own: another tab, or an editor,
   * can change the language in the file, and this page hears about anything on disk the one way
   * it hears about anything on disk (`./changes.ts`).
   */
  changes?: number;
};

export type SettingsUse = {
  /** The language to render in: the file's, once it has been read, and `en` before that. */
  language: Language;
  /** The Warnings the last served read carried, `settings-unreadable` among them. */
  warnings: SettingsWarning[];
  /**
   * How a preference is changed, or `undefined` for *not now*.
   *
   * `undefined` until the settings have been read, which is structural rather than careful: a
   * change carries the revision it was based on, and `undefined` there is the claim that there is
   * no State File — so a page that had not read one would send a change that fails closed and
   * then tell the student their page was stale about something they had no part in. That is #111
   * exactly. Also `undefined` while a change is in flight, so a second click cannot be sent on a
   * revision the first has already moved past.
   */
  choose: ((change: SettingsChange) => void) | undefined;
  /** What the last change did, when it did nothing. Retired by the next one. */
  notice: SettingsNotice | undefined;
  /**
   * That the last read was **refused**, so these are the schema's defaults and not the student's
   * preferences.
   *
   * A separate flag from `notice` because it is about a different moment: `notice` answers for a
   * change the student asked for, and this answers for a page that never had their preferences to
   * begin with. False for an unauthorized or unreachable answer, which the screen already says
   * once from the Catalog — two sentences about one dead server is noise.
   */
  unread: boolean;
};

/** What the page knows about the preferences: only ever set from an answer that carried them. */
type Known = { language: Language; version: SettingsVersion; warnings: SettingsWarning[] };

/**
 * The language the page renders in, and the way to change it.
 *
 * Answers are counted rather than flagged, the way `useReloading` and `useHistory` count them: a
 * change's own write moves the Workspace change count, so the re-read that triggers can be sent
 * before the change lands and answer after it, and a bare "is this effect current" flag would let
 * that older answer put the previous language back.
 */
export function useSettings(options: UseSettingsOptions = {}): SettingsUse {
  const { client = api, changes = 0 } = options;
  const [known, setKnown] = useState<Known | undefined>(undefined);
  const [notice, setNotice] = useState<SettingsNotice | undefined>(undefined);
  const [unread, setUnread] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Ask again, for a refusal whose whole remedy is a fresher revision. */
  const [asks, setAsks] = useState(0);
  /** Which answer the page is showing. Every source of one moves it. */
  const shown = useRef(0);

  /**
   * A served answer, whoever it came from. The language is kept when the answer names one this
   * build cannot render, rather than snapping to the default — the file holds a language, and the
   * page not knowing the word for it is not the student having chosen English.
   */
  const show = (fresh: Extract<SettingsResult, { kind: "served" }>): void => {
    setKnown((was) => ({
      language: fresh.language ?? was?.language ?? FIRST_PAINT_LANGUAGE,
      version: fresh.version,
      warnings: fresh.warnings,
    }));
  };

  useEffect(() => {
    const mine = (shown.current += 1);
    // `fetchSettings` resolves rather than rejects for every answer the API can give, so there is
    // no `catch` here: a rejection would be a bug in the client, not an answer.
    void fetchSettings(client).then((fresh) => {
      if (shown.current !== mine) return;
      setUnread(fresh.kind === "refused");
      if (fresh.kind !== "served") return;
      show(fresh);
    });

    return () => {
      // whatever this run asked about is no longer what the page is waiting on
      shown.current += 1;
    };
  }, [client, changes, asks]);

  const choose =
    known === undefined || saving
      ? undefined
      : (change: SettingsChange): void => {
          // whatever the last change was told, this one is the account owed now
          setNotice(undefined);
          setSaving(true);
          void saveSettings(client, change, known.version).then((fresh) => {
            setSaving(false);
            if (fresh.kind === "served") {
              // an answer from the write itself is the newest there is, by definition
              shown.current += 1;
              show(fresh);
              return;
            }
            setNotice(fresh.kind === "refused" ? { kind: "refused", reason: fresh.reason } : fresh);
            // The file is not what this page read, so the revision in hand is spent and the
            // remedy is a fresher one. Only this reason: nothing else is mended by asking again.
            if (fresh.kind === "refused" && fresh.reason === "state-file-changed") {
              setAsks((count) => count + 1);
            }
          });
        };

  return {
    language: known?.language ?? FIRST_PAINT_LANGUAGE,
    warnings: known?.warnings ?? [],
    choose,
    notice,
    unread,
  };
}
