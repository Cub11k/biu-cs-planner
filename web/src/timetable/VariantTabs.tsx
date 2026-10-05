import { useId, useRef, useState } from "react";
import { DIRECTION, t, type Language } from "../i18n/strings.ts";
import type { VariantTab } from "./picks.ts";

export type VariantTabsProps = {
  language: Language;
  /** Every Variant of the Timetable, in file order. */
  variants: readonly VariantTab[];
  /** The Variant on the week, or `undefined` while the Timetable has not been read. */
  shown: string | undefined;
  onShow: (name: string) => void;
  /**
   * The id of the element the tabs control — the week (#324). Each tab names it in
   * `aria-controls`, and the panel names the selected tab back with `aria-labelledby`, using the
   * tab's id from `variantTabId`.
   */
  panelId: string;
  /**
   * The edits, or `undefined` for *not now* — the State File has not been read, or there is no
   * revision to base a save on — in which case every control that would write is disabled rather
   * than a button that sends a save which cannot succeed.
   */
  edits:
    | {
        create: (name: string | undefined) => void;
        duplicate: () => void;
        rename: (name: string) => void;
        remove: () => void;
        makePrimary: () => void;
      }
    | undefined;
};

/**
 * The Variant tabs above the week (#281; docs/design.md, "Screens").
 *
 * Choosing a tab is view state in the page and never a State File edit: it asks the API for that
 * Variant and nothing is written. Every other control here is an ordinary edit through the one
 * guarded writer, which is why each is one undo step and why a stale page has it refused.
 *
 * A tab list with a roving `tabIndex`: one Tab stop for the whole row, the arrow keys move between
 * tabs — the visual direction, so in Hebrew the right arrow goes to the tab on the right, which is
 * the previous one — and Enter or Space shows the tab focused. Switching is manual rather than on
 * focus, because showing a Variant asks the server, and arrowing past three tabs should not ask
 * three times.
 */
/** The id of the tab at this position, for the panel's `aria-labelledby`. */
export const variantTabId = (panelId: string, index: number): string => `${panelId}-tab-${index}`;

export function VariantTabs({
  language,
  variants,
  shown,
  onShow,
  panelId,
  edits,
}: VariantTabsProps): React.JSX.Element {
  /** Which inline form is open: naming a new Variant, or renaming the one shown. */
  const [naming, setNaming] = useState<"create" | "rename" | undefined>(undefined);
  const [name, setName] = useState("");
  const inputId = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  const current = variants.find((variant) => variant.name === shown);
  const focusable = Math.max(
    0,
    variants.findIndex((variant) => variant.name === shown),
  );

  const moveFocus = (from: number, key: string): void => {
    const forward = DIRECTION[language] === "rtl" ? "ArrowLeft" : "ArrowRight";
    const backward = DIRECTION[language] === "rtl" ? "ArrowRight" : "ArrowLeft";
    const last = variants.length - 1;
    const to =
      key === forward
        ? from === last ? 0 : from + 1
        : key === backward
          ? from === 0 ? last : from - 1
          : key === "Home"
            ? 0
            : key === "End"
              ? last
              : undefined;
    if (to !== undefined) tabs.current[to]?.focus();
  };

  const open = (mode: "create" | "rename"): void => {
    setNaming(mode);
    setName(mode === "rename" ? (shown ?? "") : "");
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const typed = name.trim();
    if (naming === "create") edits?.create(typed === "" ? undefined : typed);
    // a rename to nothing is not a name; the Save button is disabled for it as well
    if (naming === "rename" && typed !== "") edits?.rename(typed);
    setNaming(undefined);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-rule bg-paper px-4 py-1.5 text-sm">
      {variants.length > 0 && (
        <div role="tablist" aria-label={t(language, "variantTabs")} className="flex flex-wrap gap-1">
          {variants.map((variant, index) => {
            const selected = variant.name === shown;
            return (
              <button
                // two Variants can share a name, which is a Warning and not something to crash on
                key={`${index}:${variant.name}`}
                ref={(element) => {
                  tabs.current[index] = element;
                }}
                type="button"
                role="tab"
                id={variantTabId(panelId, index)}
                aria-controls={panelId}
                aria-selected={selected}
                tabIndex={index === focusable ? 0 : -1}
                data-variant={variant.name}
                data-primary={variant.primary}
                onClick={() => onShow(variant.name)}
                onKeyDown={(event) => moveFocus(index, event.key)}
                className={`variant-tab rounded-sm border px-2.5 py-1 ${
                  selected ? "is-selected border-ink" : "border-rule"
                }`}
              >
                {/* isolated: a student's own name, in either script, inside the UI's direction */}
                <bdi>{variant.name}</bdi>
                {variant.primary && (
                  <span className="variant-primary ms-1.5 text-xs">
                    {t(language, "variantPrimaryMark")}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {naming === undefined ? (
        <span className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            data-variant-action="create"
            disabled={edits === undefined}
            onClick={() => open("create")}
            className="variant-action"
          >
            {t(language, "variantNew")}
          </button>
          {/* the rest act on the tab shown, so there has to be one */}
          <button
            type="button"
            data-variant-action="duplicate"
            disabled={edits === undefined || current === undefined}
            onClick={() => edits?.duplicate()}
            className="variant-action"
          >
            {t(language, "variantDuplicate")}
          </button>
          <button
            type="button"
            data-variant-action="rename"
            disabled={edits === undefined || current === undefined}
            onClick={() => open("rename")}
            className="variant-action"
          >
            {t(language, "variantRename")}
          </button>
          <button
            type="button"
            data-variant-action="primary"
            disabled={edits === undefined || current === undefined || current.primary}
            onClick={() => edits?.makePrimary()}
            className="variant-action"
          >
            {t(language, "variantMakePrimary")}
          </button>
          <button
            type="button"
            data-variant-action="delete"
            disabled={edits === undefined || current === undefined}
            onClick={() => edits?.remove()}
            className="variant-action"
          >
            {t(language, "variantDelete")}
          </button>
        </span>
      ) : (
        <form onSubmit={submit} className="flex flex-wrap items-center gap-1">
          <label htmlFor={inputId} className="text-xs text-pencil">
            {t(language, naming === "create" ? "variantNameNew" : "variantNameRename")}
          </label>
          <input
            id={inputId}
            // the student is here to type, so the field takes the focus the button had
            autoFocus
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setNaming(undefined);
            }}
            placeholder={naming === "create" ? t(language, "variantNamePlaceholder") : undefined}
            className="w-40 rounded-sm border border-rule bg-paper px-2 py-0.5"
          />
          <button
            type="submit"
            data-variant-action="save"
            disabled={naming === "rename" && name.trim() === ""}
            className="variant-action"
          >
            {t(language, "variantSave")}
          </button>
          <button type="button" onClick={() => setNaming(undefined)} className="variant-action">
            {t(language, "variantCancel")}
          </button>
        </form>
      )}
    </div>
  );
}
