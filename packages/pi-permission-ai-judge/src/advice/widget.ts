import type { HighRiskCategory } from "../authority/highrisk";

/**
 * Dialog advice widget (PIEXTENSIO-13): a pi-native `setWidget` panel shown
 * while a permission dialog is up, so the human sees what the judge said —
 * or why it could not judge — instead of a silent dialog.
 *
 * The widget is set at defer time (the chain link runs before the terminal
 * renders the dialog) and cleared when the permission system broadcasts a
 * `permissions:decision` for the same request. Render-only: it never gates,
 * allows, denies, or suppresses anything (ADR 0011 §8's annotation contract,
 * applied on the judge's side of the seam).
 */

export const ADVICE_WIDGET_KEY = "ai-bash-judge-advice";

/** Theme colors the advice lines use; all exist in pi's theme vocabulary. */
export type AdviceColor = "accent" | "warning" | "dim";

/** The pi theme surface the widget factory needs (narrow seam for tests). */
export interface AdviceTheme {
    fg(color: AdviceColor, text: string): string;
}

/** A minimal renderable component (structural subset of pi-tui's Component). */
export interface AdviceComponent {
    render(width: number): string[];
    invalidate(): void;
}

/** The pi UI surface the presenter needs (narrow seam for tests). */
export interface AdviceWidgetUi {
    setWidget(
        key: string,
        content:
            | string[]
            | ((tui: unknown, theme: AdviceTheme) => AdviceComponent)
            | undefined,
    ): void;
}

/** What the judge concluded, in dialog-facing vocabulary. */
export type AdviceView =
    | {
          readonly state: "judgment";
          readonly verdict: "allow" | "deny" | "defer";
          readonly reason: string;
          /** True in Shadow mode: the dialog shows regardless of the verdict. */
          readonly shadow: boolean;
      }
    | {
          readonly state: "skipped";
          readonly category: HighRiskCategory;
          readonly rule: string;
      }
    | {
          readonly state: "unavailable";
          readonly cause: string;
      };

/** The decision-relevant command fragment highlighted for long commands. */
export interface AdviceFocus {
    readonly segment: string;
    readonly origin: "high-risk" | "triggering-unit" | "executed-unit";
    readonly category?: HighRiskCategory;
}

const REASON_MAX_CHARS = 180;
const SEGMENT_MAX_CHARS = 120;

/** Collapse model prose to one line and clamp its length (code-point aware). */
function sanitizeLine(text: string, maxChars: number): string {
    const collapsed = text.replace(/\s+/g, " ").trim();
    const chars = [...collapsed];
    if (chars.length <= maxChars) {
        return collapsed;
    }
    return `${chars.slice(0, maxChars - 1).join("")}…`;
}

/** Clamp a rendered line to the live terminal width. */
function clampToWidth(line: string, width: number): string {
    if (width <= 0) {
        return "";
    }
    const chars = [...line];
    if (chars.length <= width) {
        return line;
    }
    return width >= 2
        ? `${chars.slice(0, width - 1).join("")}…`
        : chars.slice(0, width).join("");
}

export interface AdviceLines {
    readonly lines: readonly string[];
    readonly colors: readonly AdviceColor[];
}

/**
 * Pure renderer: one verdict line plus an optional focus line.
 * `skipped`/`unavailable` carry their own cause in line one.
 */
export function formatAdvice(
    view: AdviceView,
    focus?: AdviceFocus,
): AdviceLines {
    const lines: string[] = [];
    const colors: AdviceColor[] = [];
    switch (view.state) {
        case "judgment": {
            const suffix = view.shadow ? " (shadow)" : "";
            lines.push(
                `ai-judge ${view.verdict}${suffix} — ${sanitizeLine(view.reason, REASON_MAX_CHARS)}`,
            );
            colors.push(
                view.verdict === "deny" ? "warning" : "accent",
            );
            break;
        }
        case "skipped": {
            lines.push(
                `ai-judge skipped — high-risk ${view.category} (${view.rule}); forced dialog`,
            );
            colors.push("warning");
            break;
        }
        case "unavailable": {
            lines.push(
                `ai-judge unavailable — ${sanitizeLine(view.cause, REASON_MAX_CHARS)}; not judged`,
            );
            colors.push("dim");
            break;
        }
    }
    if (focus !== undefined) {
        const label =
            focus.category !== undefined
                ? `high-risk: ${focus.category}`
                : focus.origin;
        lines.push(
            `focus: ${sanitizeLine(focus.segment, SEGMENT_MAX_CHARS)} (${label})`,
        );
        colors.push("dim");
    }
    return { lines, colors };
}

/**
 * Owns the widget lifecycle: present on defer, clear when the decision
 * resolves the same request, clear on shutdown. Disabled at construction
 * (`dialogAdvice: false`) makes every method a no-op.
 */
export class AdvicePresenter {
    private readonly ui: AdviceWidgetUi | undefined;
    private currentRequestId: string | undefined;

    constructor(ui: AdviceWidgetUi | undefined, enabled: boolean) {
        this.ui = enabled ? ui : undefined;
    }

    present(requestId: string, view: AdviceView, focus?: AdviceFocus): void {
        if (this.ui === undefined) {
            return;
        }
        this.currentRequestId = requestId;
        const { lines, colors } = formatAdvice(view, focus);
        this.ui.setWidget(ADVICE_WIDGET_KEY, (_tui, theme) => ({
            render: (width: number) =>
                lines.map((line, index) =>
                    theme.fg(colors[index] ?? "dim", clampToWidth(line, width)),
                ),
            invalidate: () => {},
        }));
    }

    /** Clear the widget iff the decision resolves the request it describes. */
    handleDecision(requestId: string): void {
        if (this.ui === undefined || requestId !== this.currentRequestId) {
            return;
        }
        this.clear();
    }

    shutdown(): void {
        if (this.ui === undefined) {
            return;
        }
        this.clear();
    }

    private clear(): void {
        this.currentRequestId = undefined;
        this.ui?.setWidget(ADVICE_WIDGET_KEY, undefined);
    }
}
