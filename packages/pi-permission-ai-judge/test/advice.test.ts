import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

/** Tail length used to prove wrapping loses no content. */
const REASON_TAIL = 10;

function stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, "");
}
import {
    ADVICE_WIDGET_KEY,
    AdvicePresenter,
    formatAdvice,
    type AdviceComponent,
    type AdviceTheme,
    type AdviceWidgetUi,
} from "../src/advice/widget";

/** ANSI-styled fake: invisible to truncateToWidth, like a real theme. */
const theme: AdviceTheme = {
    fg: (_color, text) => `\x1b[35m${text}\x1b[0m`,
};

function render(component: AdviceComponent, width = 200): string[] {
    return component.render(width);
}

describe("formatAdvice", () => {
    it("renders a judgment line with verdict and reason", () => {
        const advice = formatAdvice({
            state: "judgment",
            verdict: "defer",
            reason: "command rewrites published history; intent not established",
            shadow: false,
        });
        expect(advice.lines).toEqual([
            "ai-judge defer — command rewrites published history; intent not established",
        ]);
        expect(advice.colors).toEqual(["accent"]);
    });

    it("marks shadow verdicts and colors deny as warning", () => {
        const advice = formatAdvice({
            state: "judgment",
            verdict: "deny",
            reason: "credential read without user intent",
            shadow: true,
        });
        expect(advice.lines[0]).toBe(
            "ai-judge deny (shadow) — credential read without user intent",
        );
        expect(advice.colors[0]).toBe("warning");
    });

    it("renders the skipped state with category and rule", () => {
        const advice = formatAdvice({
            state: "skipped",
            category: "data_loss",
            rule: "git clean -xfd",
        });
        expect(advice.lines).toEqual([
            "ai-judge skipped — high-risk data_loss (git clean -xfd); forced dialog",
        ]);
        expect(advice.colors).toEqual(["warning"]);
    });

    it("renders the unavailable state with cause", () => {
        const advice = formatAdvice({
            state: "unavailable",
            cause: "model call failed (timeout)",
        });
        expect(advice.lines).toEqual([
            "ai-judge unavailable — model call failed (timeout); not judged",
        ]);
        expect(advice.colors).toEqual(["dim"]);
    });

    it("appends a focus line for a high-risk match", () => {
        const advice = formatAdvice(
            { state: "skipped", category: "history_rewrite", rule: "git push --force" },
            { segment: "git push --force origin main", origin: "high-risk", category: "history_rewrite" },
        );
        expect(advice.lines[1]).toBe(
            "focus: git push --force origin main (high-risk: history_rewrite)",
        );
        expect(advice.colors[1]).toBe("dim");
    });

    it("labels a plain triggering-unit focus by origin", () => {
        const advice = formatAdvice(
            { state: "judgment", verdict: "defer", reason: "r", shadow: false },
            { segment: "rm -rf build", origin: "triggering-unit" },
        );
        expect(advice.lines[1]).toBe("focus: rm -rf build (triggering-unit)");
    });

    it("collapses whitespace in reason and focus", () => {
        const advice = formatAdvice(
            { state: "judgment", verdict: "defer", reason: "a\n  b\t\tc", shadow: false },
            { segment: "x\n y", origin: "executed-unit" },
        );
        expect(advice.lines[0]).toContain("— a b c");
        expect(advice.lines[1]).toBe("focus: x y (executed-unit)");
    });

    it("clamps pathological reasons and segments with an ellipsis", () => {
        const long = "a".repeat(4000);
        const advice = formatAdvice(
            { state: "judgment", verdict: "defer", reason: long, shadow: false },
            { segment: long, origin: "triggering-unit" },
        );
        expect([...advice.lines[0]!].length).toBe("ai-judge defer — ".length + 600);
        expect(advice.lines[0]!.endsWith("…")).toBe(true);
        const focusLine = advice.lines[1]!;
        const segment = focusLine.slice("focus: ".length, focusLine.lastIndexOf(" ("));
        expect([...segment].length).toBe(240);
        expect(segment.endsWith("…")).toBe(true);
    });

    it("keeps ordinary multi-sentence reasons complete", () => {
        const reason =
            "命令会重写已发布的历史记录且用户意图未确立。".repeat(6);
        const advice = formatAdvice({
            state: "judgment",
            verdict: "defer",
            reason,
            shadow: false,
        });
        expect(advice.lines[0]!.endsWith("。"));
        expect(advice.lines[0]!.endsWith("…")).toBe(false);
    });
});

function recordingUi(): AdviceWidgetUi & {
    calls: Array<{ key: string; content: unknown }>;
} {
    const calls: Array<{ key: string; content: unknown }> = [];
    return {
        calls,
        setWidget(key, content) {
            calls.push({ key, content });
        },
    };
}

describe("AdvicePresenter", () => {
    it("sets a themed widget on present and clamps to render width", () => {
        const ui = recordingUi();
        const presenter = new AdvicePresenter(ui, undefined, true);
        presenter.present("req-1", {
            state: "judgment",
            verdict: "defer",
            reason: "ambiguous intent",
            shadow: false,
        });
        expect(ui.calls).toHaveLength(1);
        expect(ui.calls[0]!.key).toBe(ADVICE_WIDGET_KEY);
        const factory = ui.calls[0]!.content as (
            tui: unknown,
            theme: AdviceTheme,
        ) => AdviceComponent;
        const component = factory({}, theme);
        expect(render(component, 200)).toEqual([
            "\x1b[35mai-judge defer — ambiguous intent\x1b[0m",
        ]);
        const clamped = render(component, 10);
        expect(clamped.length).toBeGreaterThan(1);
        for (const line of clamped) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(10);
        }
        const joined = clamped.map(stripAnsi).join("").replace(/\s+/g, "");
        expect(joined).toContain("ambiguousintent");
        component.invalidate();
    });

    it("never renders wider than the terminal and loses no CJK text", () => {
        const ui = recordingUi();
        const presenter = new AdvicePresenter(ui, undefined, true);
        const reason = "命令会重写已发布的历史记录且用户意图未确立".repeat(10);
        presenter.present("req-1", {
            state: "judgment",
            verdict: "defer",
            reason,
            shadow: false,
        });
        const factory = ui.calls[0]!.content as (
            tui: unknown,
            theme: AdviceTheme,
        ) => AdviceComponent;
        const component = factory({}, theme);
        for (const width of [5, 20, 80, 120]) {
            const lines = render(component, width);
            for (const line of lines) {
                expect(visibleWidth(line)).toBeLessThanOrEqual(width);
            }
            expect(visibleWidth(lines[0]!)).toBeGreaterThan(0);
        }
        // Wrapping, not truncation: the full reason survives the render.
        const joined = render(component, 20).map(stripAnsi).join("");
        expect(joined).toContain(reason.slice(-REASON_TAIL));
    });

    it("is a no-op end to end when disabled", () => {
        const ui = recordingUi();
        const presenter = new AdvicePresenter(ui, undefined, false);
        presenter.present("req-1", {
            state: "unavailable",
            cause: "off",
        });
        presenter.handleDecision("req-1");
        presenter.shutdown();
        expect(ui.calls).toHaveLength(0);
    });

    it("clears only on the decision that resolves the current request", () => {
        const ui = recordingUi();
        const presenter = new AdvicePresenter(ui, undefined, true);
        presenter.present("req-1", { state: "unavailable", cause: "x" });
        presenter.handleDecision("req-other");
        expect(ui.calls).toHaveLength(1);
        presenter.handleDecision("req-1");
        expect(ui.calls).toHaveLength(2);
        expect(ui.calls[1]).toEqual({ key: ADVICE_WIDGET_KEY, content: undefined });
    });

    it("a later present re-keys the clear guard onto the new request", () => {
        const ui = recordingUi();
        const presenter = new AdvicePresenter(ui, undefined, true);
        presenter.present("req-1", { state: "unavailable", cause: "x" });
        presenter.present("req-2", { state: "unavailable", cause: "y" });
        presenter.handleDecision("req-1");
        expect(ui.calls).toHaveLength(2); // nothing cleared
        presenter.handleDecision("req-2");
        expect(ui.calls).toHaveLength(3);
        expect(ui.calls[2]).toEqual({ key: ADVICE_WIDGET_KEY, content: undefined });
    });

    it("shutdown clears the widget", () => {
        const ui = recordingUi();
        const presenter = new AdvicePresenter(ui, undefined, true);
        presenter.present("req-1", { state: "unavailable", cause: "x" });
        presenter.shutdown();
        expect(ui.calls.at(-1)).toEqual({
            key: ADVICE_WIDGET_KEY,
            content: undefined,
        });
    });

    it("emits a sanitized auto-allow notify", () => {
        const notify = vi.fn();
        const presenter = new AdvicePresenter(recordingUi(), notify, true);
        presenter.notifyAllowed("  command   matches\nexplicit user intent  ");
        expect(notify).toHaveBeenCalledWith(
            "ai-bash-judge auto-allowed — command matches explicit user intent",
            "info",
        );
    });

    it("skips the auto-allow notify when disabled", () => {
        const notify = vi.fn();
        const presenter = new AdvicePresenter(recordingUi(), notify, false);
        presenter.notifyAllowed("r");
        presenter.present("r", { state: "unavailable", cause: "x" });
        expect(notify).not.toHaveBeenCalled();
    });
});

describe("AdvicePresenter with a real ExtensionUIContext-shaped ui", () => {
    it("accepts the overload-style setWidget surface", () => {
        const setWidget = vi.fn();
        const ui = { setWidget } as unknown as AdviceWidgetUi;
        const presenter = new AdvicePresenter(ui, undefined, true);
        presenter.present("r", { state: "unavailable", cause: "shape" });
        expect(setWidget).toHaveBeenCalledWith(
            ADVICE_WIDGET_KEY,
            expect.any(Function),
        );
    });
});
