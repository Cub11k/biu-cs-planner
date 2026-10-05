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

export type FakeApi = {
  /** The Fall 2027 Timetable the fake holds. */
  variants: FakeVariant[];
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
function split(range: Omit<FakeBlockedTime, "semester">): FakeBlockedTime[] {
  const start = clock(range.start, false);
  const end = clock(range.end, true);
  if (end >= start) return [{ ...range, semester: "fall" }];
  const next = NEXT_DAY[range.day];
  return [
    { ...range, semester: "fall", end: "00:00" },
    ...(next === undefined ? [] : [{ ...range, semester: "fall" as const, day: next, start: "00:00" }]),
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
}): FakeApi {
  const realFetch = globalThis.fetch;
  const fake: FakeApi = {
    variants: options.variants ?? [],
    blockedTimes: options.blockedTimes ?? [],
    copied: new Map(),
    planDiffs: options.planDiffs ?? {},
    registrationGate: undefined,
    sent: [],
    labels: [],
    changeUnderneath: false,
    version: 0,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };

  /** The Variant a name addresses — of two sharing it, the one at `position` (#322). */
  const named = (name: string, position: number | undefined): FakeVariant | undefined => {
    const at = position === undefined ? undefined : fake.variants[position];
    return at?.name === name ? at : fake.variants.find((v) => v.name === name);
  };

  const resolve = (requested: string | null | undefined, position?: number): string =>
    resolved(requested, position)?.name ?? "A";

  const resolved = (requested: string | null | undefined, position?: number): FakeVariant | undefined =>
    (requested ? named(requested, position) : undefined) ??
    fake.variants.find((v) => v.primary) ??
    fake.variants[0];

  const freeName = (): string =>
    [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].find((letter) => !fake.variants.some((v) => v.name === letter)) ??
    "A2";

  /** The Variant an edit names, made if it is not there — as a first Pick makes it. */
  const edited = (requested: string | undefined, position?: number): FakeVariant => {
    const name = requested ?? resolve(undefined);
    let variant = named(name, requested === undefined ? undefined : position);
    if (variant === undefined) {
      variant = { name, primary: fake.variants.length === 0, picks: [], tray: [] };
      fake.variants.push(variant);
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
        fake.blockedTimes
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
    const variantWarnings: Array<Record<string, unknown>> = fake.variants.flatMap((v) => {
      if (!seen.has(v.name)) {
        seen.add(v.name);
        return [];
      }
      return [{ kind: "variant-name-not-unique", name: v.name }];
    });
    const registered = fake.variants.filter((v) => v.registered === true).length;
    if (registered > 1) variantWarnings.push({ kind: "registered-variant-not-unique", registered });
    return {
      variantName: name,
      variantPosition: variant === undefined ? undefined : fake.variants.indexOf(variant),
      variants: fake.variants.map((v) => ({
        name: v.name,
        primary: v.primary,
        ...(v.registered === true ? { registered: true } : {}),
      })),
      variantWarnings,
      picks,
      clashes,
      blockedTimes: fake.blockedTimes,
      blockedTimeWarnings: fake.blockedTimes.flatMap((blocked, index) =>
        clock(blocked.end, true) > clock(blocked.start, false)
          ? []
          : [{ kind: "blocked-time-does-not-advance", index, start: blocked.start, end: blocked.end }],
      ),
      tray: trayOf(variant),
      planDiffs: fake.planDiffs[name] ?? [],
      version: `v${fake.version}`,
      warnings: [],
    };
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
    if (!pathname.startsWith("/api/timetable")) return json({ offerings: options.offerings, warnings: [] });

    const route = pathname.replace("/api/timetable/2027/fall", "");
    if (method === "GET" && route === "/registration") {
      await fake.registrationGate;
      const position = url.searchParams.get("position");
      const variant = resolved(url.searchParams.get("variant"), position === null ? undefined : Number(position));
      const name = variant?.name ?? "A";
      return json({
        variantName: name,
        variantPosition: variant === undefined ? undefined : fake.variants.indexOf(variant),
        planDiffs: fake.planDiffs[name] ?? [],
        registers: options.registers?.[name] ?? [],
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
      const held = fake.planDiffs[name] ?? [];
      const applied = held.find((d) => d.kind === request.kind && d.courseNumber === request.courseNumber);
      if (applied === undefined) {
        return json({ reason: "plan-diff-stale", version: `v${fake.version}`, warnings: [] }, 409);
      }
      fake.planDiffs[name] = held.filter((d) => d !== applied);
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
        fake.variants.push({ name, primary: fake.variants.length === 0, picks: [], tray: [] });
        answerAbout = name;
        answerAt = fake.variants.length - 1;
        fake.labels.push("create-variant");
        break;
      }
      case "POST /variants/duplicate": {
        const source = edited(request.variant, at);
        const name = (request.name as string | undefined) ?? freeName();
        answerAt = fake.variants.indexOf(source) + 1;
        fake.variants.splice(answerAt, 0, {
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
        answerAt = fake.variants.indexOf(renamed);
        fake.labels.push("rename-variant");
        break;
      }
      case "POST /variants/primary": {
        const chosen = edited(request.variant, at);
        for (const v of fake.variants) v.primary = v === chosen;
        fake.labels.push("set-primary-variant");
        break;
      }
      case "DELETE /variants": {
        const gone = edited(request.variant, at);
        fake.variants = fake.variants.filter((v) => v !== gone);
        if (gone.primary && fake.variants[0] !== undefined && !fake.variants.some((v) => v.primary)) {
          fake.variants[0].primary = true;
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
        for (const v of fake.variants) {
          v.primary = v === chosen;
          v.registered = v === chosen;
        }
        // "apply all": every actionable Plan Diff is applied, so only the not-offered ones are left
        if (request.applyDiffs === true) {
          fake.planDiffs[chosen.name] = (fake.planDiffs[chosen.name] ?? []).filter((d) => d.kind === "not-offered");
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
        fake.blockedTimes = [...fake.blockedTimes, ...split(request as never)];
        fake.labels.push("add-blocked-time");
        break;
      }
      case "PUT /blocked-times": {
        const index = request.index as number;
        fake.blockedTimes = [
          ...fake.blockedTimes.slice(0, index),
          ...split(request as never),
          ...fake.blockedTimes.slice(index + 1),
        ];
        fake.labels.push("replace-blocked-time");
        break;
      }
      case "DELETE /blocked-times": {
        fake.blockedTimes = fake.blockedTimes.filter((_, index) => index !== request.index);
        fake.labels.push("remove-blocked-time");
        break;
      }
      case "POST /blocked-times/copy": {
        const target = `${String(request.toYear)}/${String(request.toSemester)}`;
        fake.copied.set(target, [
          ...(fake.copied.get(target) ?? []),
          ...fake.blockedTimes.map((b) => ({ ...b, semester: request.toSemester as FakeBlockedTime["semester"] })),
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
