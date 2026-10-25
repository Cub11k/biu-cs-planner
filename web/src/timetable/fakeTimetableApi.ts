/**
 * A fake of the Timetable half of the HTTP API, for the browser tests of #298: one Semester's
 * Timetable with several Variants in memory, served the way `server/src/api.ts` serves it.
 *
 * It stands where `fetch` stands, because `web` reaches the domain only through the typed client
 * (CLAUDE.md) — so what the screen sends is what the real server would receive. It keeps the
 * rules the screen relies on rather than implements: a save on a revision the file has moved
 * past is refused `state-file-changed`, every accepted save moves the revision, and an answer is
 * about the Variant the server says it is about. The domain rules themselves are `core`'s and are
 * tested there; this holds only as much of them as a page can see.
 *
 * It holds the Fall 2027 Timetable on the object it returns, and any other Semester in `semesters`,
 * so the Semester tabs can be tested against Timetables that differ (#418), and serves each
 * Semester's exam period as a test sets it (#419) — the check itself is `core`'s.
 *
 * Test-only. It lives beside the screen because three browser test files share it.
 */
import type { Offering } from "./catalog.ts";
import type { GroupPick, PlanDiff } from "./picks.ts";

export type FakeVariant = {
  name: string;
  primary: boolean;
  picks: GroupPick[];
  tray: string[];
  /** The Variant the student registered with (#297). */
  registered?: boolean;
};
export type FakeBlockedTime = {
  semester: "fall" | "spring" | "summer";
  day: "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday";
  start: string;
  end: string;
  label: string;
};

/**
 * The Plan Diffs the fake serves, by the name of the Variant they are about (#296). The fake does
 * not compute them — `core` does, and is tested there — it serves what a test says the server
 * would, and an apply takes the one it names out of the list, as the real answer would no longer
 * carry it.
 */
export type FakePlanDiffs = Record<string, PlanDiff[]>;

export type FakeRequest = { method: string; pathname: string; search: string; body: unknown };

/** The exam period a Semester is served with, as `checkExams` would answer, or an unreadable answer. */
export type FakeExams =
  | {
      sittings: Array<{
        courseNumber: string;
        moed: string;
        date: string;
        time: string;
        daysSincePrevious: number | undefined;
        yearLong: boolean;
      }>;
      warnings: unknown[];
      coursesWithUnknownExams: number;
    }
  | "unreadable";

/** One Semester's Timetable as the fake holds it. */
export type FakeSemester = {
  variants: FakeVariant[];
  blockedTimes: FakeBlockedTime[];
  planDiffs: FakePlanDiffs;
  exams?: FakeExams;
};

export type FakeApi = FakeSemester & {
  /** The Fall 2027 Timetable the fake holds. */
  variants: FakeVariant[];
  /** Every other Semester, keyed `year/semester`, made empty when first asked about. */
  semesters: Map<string, FakeSemester>;
  /** While set, every save waits for it before it is answered: an edit in flight (#418). */
  saveGate: Promise<void> | undefined;
  blockedTimes: FakeBlockedTime[];
  /** Blocked Times copied to another Semester, keyed `year/semester`. */
  copied: Map<string, FakeBlockedTime[]>;
  /** Every request the screen sent to the API, in order. */
  sent: FakeRequest[];
  /** The labels of the saves accepted, in order — what the undo stack would hold. */
  labels: string[];
  /** The Plan Diffs each Variant is served with; a test may change them between answers. */
  planDiffs: FakePlanDiffs;
  /** While set, the registration preview waits for it before answering (#297). */
  registrationGate: Promise<void> | undefined;
  /** Set to refuse the next save as a file that changed under the page. */
  changeUnderneath: boolean;
  version: number;
  restore: () => void;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const clock = (time: string, asEnd: boolean): number => {
  const [hours, minutes] = time.split(":").map(Number);
  const read = hours! * 60 + minutes!;
  return asEnd && read === 0 ? 24 * 60 : read;
};

const overlaps = (
  a: { day: string; start: string; end: string },
  b: { day: string; start: string; end: string },
): boolean =>
  a.day === b.day &&
  Math.max(clock(a.start, false), clock(b.start, false)) <
    Math.min(clock(a.end, true), clock(b.end, true));

const NEXT_DAY: Record<string, FakeBlockedTime["day"] | undefined> = {
  sunday: "monday",
  monday: "tuesday",
  tuesday: "wednesday",
  wednesday: "thursday",
  thursday: "friday",
  friday: undefined,
};

/** The wrap rule `core/src/state/blocked.ts` keeps, as far as a page can see it. */
function split(range: Omit<FakeBlockedTime, "semester">, semester: FakeBlockedTime["semester"]): FakeBlockedTime[] {
  const start = clock(range.start, false);
  const end = clock(range.end, true);
  if (end >= start) return [{ ...range, semester }];
  const next = NEXT_DAY[range.day];
  return [
    { ...range, semester, end: "00:00" },
    ...(next === undefined ? [] : [{ ...range, semester, day: next, start: "00:00" }]),
  ];
}

/**
 * Installs the fake over `fetch`. `offerings` is the Catalog it serves for every Catalog route.
 */
export function installFakeApi(options: {
  offerings: Offering[];
  variants?: FakeVariant[];
  blockedTimes?: FakeBlockedTime[];
  planDiffs?: FakePlanDiffs;
  /** Courses with a planned Attempt in the Semester, which every Variant's Tray lists (#283). */
  planned?: string[];
  /** What "apply all" would register, by Variant name, for the registration preview (#297). */
  registers?: Record<string, string[]>;
  /** The Fall 2027 exam period; none given is an empty one. */
  exams?: FakeExams;
  /** Other Semesters' Timetables, keyed `year/semester`. */
  semesters?: Record<string, Partial<FakeSemester>>;
  /** Other Semesters' Catalogs, keyed `year/semester`; `null` is no Catalog for it. */
  catalogs?: Record<string, Offering[] | null>;
}): FakeApi {
  const realFetch = globalThis.fetch;
  const fake: FakeApi = {
    variants: options.variants ?? [],
    blockedTimes: options.blockedTimes ?? [],
    copied: new Map(),
    planDiffs: options.planDiffs ?? {},
    ...(options.exams === undefined ? {} : { exams: options.exams }),
    semesters: new Map(
      Object.entries(options.semesters ?? {}).map(([key, held]) => [
        key,
        { variants: [], blockedTimes: [], planDiffs: {}, ...held },
      ]),
    ),
    saveGate: undefined,
    registrationGate: undefined,
    sent: [],
    labels: [],
    changeUnderneath: false,
    version: 0,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };

  /** The helpers below, over one Semester's Timetable. */
  const on = (s: FakeSemester) => {
  /** The Variant a name addresses — of two sharing it, the one at `position` (#322). */
  const named = (name: string, position: number | undefined): FakeVariant | undefined => {
    const at = position === undefined ? undefined : s.variants[position];
    return at?.name === name ? at : s.variants.find((v) => v.name === name);
  };

  const resolve = (requested: string | null | undefined, position?: number): string =>
    resolved(requested, position)?.name ?? "A";

  const resolved = (requested: string | null | undefined, position?: number): FakeVariant | undefined =>
    (requested ? named(requested, position) : undefined) ??
    s.variants.find((v) => v.primary) ??
    s.variants[0];

  const freeName = (): string =>
    [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].find((letter) => !s.variants.some((v) => v.name === letter)) ??
    "A2";

  /** The Variant an edit names, made if it is not there — as a first Pick makes it. */
  const edited = (requested: string | undefined, position?: number): FakeVariant => {
    const name = requested ?? resolve(undefined);
    let variant = named(name, requested === undefined ? undefined : position);
    if (variant === undefined) {
      variant = { name, primary: s.variants.length === 0, picks: [], tray: [] };
      s.variants.push(variant);
    }
    return variant;
  };

  const trayOf = (variant: FakeVariant | undefined) => {
    const planned = options.planned ?? [];
    const order = [
      ...new Set([...(variant?.tray ?? []), ...(variant?.picks.map((p) => p.courseNumber) ?? []), ...planned]),
    ];
    return order.map((courseNumber) => {
      const offering = options.offerings.find((o) => o.courseNumber === courseNumber);
      const mine = variant?.picks.filter((p) => p.courseNumber === courseNumber) ?? [];
      const lessonTypes =
        offering === undefined
          ? mine.map((p) => p.lessonType)
          : [...new Set(offering.groups.map((g) => g.lessonType))];
      const chips = lessonTypes.map((lessonType) => {
        const pick = mine.find((p) => p.lessonType === lessonType);
        return pick === undefined ? { lessonType } : { lessonType, groupNumber: pick.groupNumber };
      });
      return {
        courseNumber,
        origins: [
          ...(variant?.tray.includes(courseNumber) ? ["added"] : []),
          ...(mine.length > 0 ? ["picked"] : []),
          ...(planned.includes(courseNumber) ? ["planned"] : []),
        ],
        known: offering !== undefined,
        chips,
        complete: offering === undefined ? null : chips.every((chip) => "groupNumber" in chip),
      };
    });
  };

  const view = (requested: string | null | undefined, position?: number) => {
    const variant = resolved(requested, position);
    const name = variant?.name ?? "A";
    const picks = variant?.picks ?? [];
    const clashes = picks.flatMap((pick) =>
      pick.meetings.flatMap((meeting) =>
        s.blockedTimes
          .map((blocked, blockedTimeIndex) => ({ blocked, blockedTimeIndex }))
          .filter(({ blocked }) => overlaps(meeting, blocked))
          .map(({ blocked, blockedTimeIndex }) => ({
            kind: "meeting-blocked-time",
            overlap: { ...meeting },
            group: {
              courseNumber: pick.courseNumber,
              lessonType: pick.lessonType,
              number: pick.groupNumber,
            },
            meeting,
            blockedTime: blocked,
            blockedTimeIndex,
          })),
      ),
    );
    const seen = new Set<string>();
    const variantWarnings: Array<Record<string, unknown>> = s.variants.flatMap((v) => {
      if (!seen.has(v.name)) {
        seen.add(v.name);
        return [];
      }
      return [{ kind: "variant-name-not-unique", name: v.name }];
    });
    const registered = s.variants.filter((v) => v.registered === true).length;
    if (registered > 1) variantWarnings.push({ kind: "registered-variant-not-unique", registered });
    return {
      variantName: name,
      variantPosition: variant === undefined ? undefined : s.variants.indexOf(variant),
      variants: s.variants.map((v) => ({
        name: v.name,
        primary: v.primary,
        ...(v.registered === true ? { registered: true } : {}),
      })),
      variantWarnings,
      picks,
      clashes,
      blockedTimes: s.blockedTimes,
      blockedTimeWarnings: s.blockedTimes.flatMap((blocked, index) =>
        clock(blocked.end, true) > clock(blocked.start, false)
          ? []
          : [{ kind: "blocked-time-does-not-advance", index, start: blocked.start, end: blocked.end }],
      ),
      tray: trayOf(variant),
      planDiffs: s.planDiffs[name] ?? [],
      version: `v${fake.version}`,
      warnings: [],
    };
  };
    return { named, resolve, resolved, freeName, edited, view };
  };

  /** The Semester a path names: Fall 2027 is the fake itself, any other is made when first asked about. */
  const storeOf = (key: string): FakeSemester => {
    if (key === "2027/fall") return fake;
    let held = fake.semesters.get(key);
    if (held === undefined) {
      held = { variants: [], blockedTimes: [], planDiffs: {} };
      fake.semesters.set(key, held);
    }
    return held;
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const { pathname, search } = url;
    if (!pathname.startsWith("/api/")) return realFetch(input as RequestInfo, init);

    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    fake.sent.push({ method, pathname, search, body });

    if (pathname === "/api/workspace/changes") return json({ changeCount: 0 });
    if (pathname === "/api/history") return json({ canUndo: fake.labels.length > 0, canRedo: false });
    if (pathname === "/api/settings") {
      return json({ language: "en", examSpacingDays: 3, version: `v${fake.version}`, warnings: [] });
    }
    if (!pathname.startsWith("/api/timetable")) {
      const catalogKey = `${pathname.split("/")[3]}/${url.searchParams.get("semester")}`;
      const catalog = options.catalogs?.[catalogKey];
      if (catalog === null) return json({ warnings: [{ kind: "no-catalog-for-year" }] }, 404);
      return json({ offerings: catalog ?? options.offerings, warnings: [] });
    }

    const [, year, semester, route = ""] = /^\/api\/timetable\/(\d+)\/(\w+)(.*)$/.exec(pathname) ?? [];
    const s = storeOf(`${year}/${semester}`);
    const { resolve, resolved, freeName, edited, view } = on(s);
    if (method === "GET" && route === "/exams") {
      if (s.exams === "unreadable") return new Response("<html>500</html>", { status: 500 });
      const position = url.searchParams.get("position");
      return json({
        variantName: resolve(url.searchParams.get("variant"), position === null ? undefined : Number(position)),
        exams: s.exams ?? { sittings: [], warnings: [], coursesWithUnknownExams: 0 },
        spacingDays: 3,
        version: `v${fake.version}`,
        warnings: [],
        catalogWarnings: [],
        catalogRefused: null,
      });
    }
    if (method === "GET" && route === "/registration") {
      await fake.registrationGate;
      const position = url.searchParams.get("position");
      const variant = resolved(url.searchParams.get("variant"), position === null ? undefined : Number(position));
      const name = variant?.name ?? "A";
      return json({
        variantName: name,
        variantPosition: variant === undefined ? undefined : s.variants.indexOf(variant),
        planDiffs: s.planDiffs[name] ?? [],
        registers: options.registers?.[name] ?? [],
        // the fake's digest is the list as JSON: like the server's, it changes exactly when the list does (#355)
        digest: JSON.stringify(s.planDiffs[name] ?? []),
        version: `v${fake.version}`,
        warnings: [],
      });
    }
    if (method === "GET") {
      const position = url.searchParams.get("position");
      return json(view(url.searchParams.get("variant"), position === null ? undefined : Number(position)));
    }

    const request = body as Record<string, unknown> & {
      basedOn?: string;
      variant?: string;
      position?: number;
    };
    const at = request.position;
    await fake.saveGate;
    if (fake.changeUnderneath) {
      fake.changeUnderneath = false;
      fake.version += 1;
      return json({ reason: "state-file-changed", warnings: [] }, 409);
    }
    if (request.basedOn !== `v${fake.version}`) {
      return json({ reason: "state-file-changed", warnings: [] }, 409);
    }
    const key = `${method} ${route}`;

    // an apply of a Plan Diff the Variant is no longer served with writes nothing (#295)
    if (key === "POST /plan-diffs/apply") {
      const name = resolve(request.variant, at);
      const held = s.planDiffs[name] ?? [];
      const applied = held.find((d) => d.kind === request.kind && d.courseNumber === request.courseNumber);
      if (applied === undefined) {
        return json({ reason: "plan-diff-stale", version: `v${fake.version}`, warnings: [] }, 409);
      }
      s.planDiffs[name] = held.filter((d) => d !== applied);
    }
    // "apply all" of a list that is not the one served now writes nothing (#355)
    if (key === "POST /variants/registered" && request.applyDiffs === true) {
      const name = resolve(request.variant, at);
      if (request.digest !== JSON.stringify(s.planDiffs[name] ?? [])) {
        return json({ reason: "plan-diff-stale", version: `v${fake.version}`, warnings: [] }, 409);
      }
    }
    fake.version += 1;

    let answerAbout: string | undefined = request.variant;
    let answerAt: number | undefined = at;
    switch (key) {
      case "POST /picks": {
        const { basedOn: _b, variant: _v, position: _p, ...pick } = request;
        const variant = edited(request.variant, at);
        variant.picks = [
          ...variant.picks.filter(
            (p) => p.courseNumber !== pick.courseNumber || p.lessonType !== pick.lessonType,
          ),
          pick as unknown as GroupPick,
        ];
        fake.labels.push("pick-group");
        break;
      }
      case "DELETE /picks": {
        const variant = edited(request.variant, at);
        variant.picks = variant.picks.filter(
          (p) => p.courseNumber !== request.courseNumber || p.lessonType !== request.lessonType,
        );
        fake.labels.push("remove-pick");
        break;
      }
      case "POST /variants": {
        const name = (request.name as string | undefined) ?? freeName();
        s.variants.push({ name, primary: s.variants.length === 0, picks: [], tray: [] });
        answerAbout = name;
        answerAt = s.variants.length - 1;
        fake.labels.push("create-variant");
        break;
      }
      case "POST /variants/duplicate": {
        const source = edited(request.variant, at);
        const name = (request.name as string | undefined) ?? freeName();
        answerAt = s.variants.indexOf(source) + 1;
        s.variants.splice(answerAt, 0, {
          name,
          primary: false,
          picks: [...source.picks],
          tray: [...source.tray],
        });
        answerAbout = name;
        fake.labels.push("duplicate-variant");
        break;
      }
      case "POST /variants/rename": {
        const renamed = edited(request.variant, at);
        renamed.name = request.name as string;
        answerAbout = request.name as string;
        answerAt = s.variants.indexOf(renamed);
        fake.labels.push("rename-variant");
        break;
      }
      case "POST /variants/primary": {
        const chosen = edited(request.variant, at);
        for (const v of s.variants) v.primary = v === chosen;
        fake.labels.push("set-primary-variant");
        break;
      }
      case "DELETE /variants": {
        const gone = edited(request.variant, at);
        s.variants = s.variants.filter((v) => v !== gone);
        if (gone.primary && s.variants[0] !== undefined && !s.variants.some((v) => v.primary)) {
          s.variants[0].primary = true;
        }
        answerAbout = undefined;
        fake.labels.push("delete-variant");
        break;
      }
      case "POST /tray": {
        const variant = edited(request.variant, at);
        if (!variant.tray.includes(request.courseNumber as string)) {
          variant.tray = [...variant.tray, request.courseNumber as string];
        }
        fake.labels.push("add-to-tray");
        break;
      }
      case "DELETE /tray": {
        const variant = edited(request.variant, at);
        variant.tray = variant.tray.filter((c) => c !== request.courseNumber);
        variant.picks = variant.picks.filter((p) => p.courseNumber !== request.courseNumber);
        fake.labels.push("remove-from-tray");
        break;
      }
      case "POST /variants/registered": {
        const chosen = edited(request.variant, at);
        for (const v of s.variants) {
          v.primary = v === chosen;
          v.registered = v === chosen;
        }
        // "apply all": every actionable Plan Diff is applied, so only the not-offered ones are left
        if (request.applyDiffs === true) {
          s.planDiffs[chosen.name] = (s.planDiffs[chosen.name] ?? []).filter((d) => d.kind === "not-offered");
        }
        fake.labels.push("mark-variant-registered");
        break;
      }
      case "DELETE /variants/registered": {
        edited(request.variant, at).registered = false;
        fake.labels.push("unmark-variant-registered");
        break;
      }
      case "POST /plan-diffs/apply": {
        fake.labels.push(`apply-plan-diff-${String(request.kind)}`);
        break;
      }
      case "POST /blocked-times": {
        s.blockedTimes = [...s.blockedTimes, ...split(request as never, semester as FakeBlockedTime["semester"])];
        fake.labels.push("add-blocked-time");
        break;
      }
      case "PUT /blocked-times": {
        const index = request.index as number;
        s.blockedTimes = [
          ...s.blockedTimes.slice(0, index),
          ...split(request as never, semester as FakeBlockedTime["semester"]),
          ...s.blockedTimes.slice(index + 1),
        ];
        fake.labels.push("replace-blocked-time");
        break;
      }
      case "DELETE /blocked-times": {
        s.blockedTimes = s.blockedTimes.filter((_, index) => index !== request.index);
        fake.labels.push("remove-blocked-time");
        break;
      }
      case "POST /blocked-times/copy": {
        const target = `${String(request.toYear)}/${String(request.toSemester)}`;
        fake.copied.set(target, [
          ...(fake.copied.get(target) ?? []),
          ...s.blockedTimes.map((b) => ({ ...b, semester: request.toSemester as FakeBlockedTime["semester"] })),
        ]);
        fake.labels.push("copy-blocked-times");
        break;
      }
      default:
        return json({ error: `the fake has no ${key}` }, 404);
    }

    return json(view(answerAbout, answerAt));
  }) as typeof fetch;

  return fake;
}
