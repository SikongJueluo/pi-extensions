import { describe, expect, it, vi } from "vitest";
import {
    ADVICE_WIDGET_KEY,
    AdvicePresenter,
    formatAdvice,
    type AdviceComponent,
    type AdviceTheme,
    type AdviceWidgetUi,
} from "../src/advice/widget";

const theme: AdviceTheme = {
    fg: (color, text) => `<${color}>${text}</>`,
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

    it("clamps long reasons and segments with an ellipsis", () => {
        const long = "a".repeat(400);
        const advice = formatAdvice(
            { state: "judgment", verdict: "defer", reason: long, shadow: false },
            { segment: long, origin: "triggering-unit" },
        );
        expect([...advice.lines[0]!].length).toBe("ai-judge defer — ".length + 180);
        expect(advice.lines[0]!.endsWith("…")).toBe(true);
        const focusLine = advice.lines[1]!;
        const segment = focusLine.slice("focus: ".length, focusLine.lastIndexOf(" ("));
        expect([...segment].length).toBe(120);
        expect(segment.endsWith("…")).toBe(true);
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
        const presenter = new AdvicePresenter(ui, true);
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
            "<accent>ai-judge defer — ambiguous intent</>",
        ]);
        expect(render(component, 10)[0]).toBe(
            "<accent>ai-judge …</>",
        );
        component.invalidate();
    });

    it("is a no-op end to end when disabled", () => {
        const ui = recordingUi();
        const presenter = new AdvicePresenter(ui, false);
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
        const presenter = new AdvicePresenter(ui, true);
        presenter.present("req-1", { state: "unavailable", cause: "x" });
        presenter.handleDecision("req-other");
        expect(ui.calls).toHaveLength(1);
        presenter.handleDecision("req-1");
        expect(ui.calls).toHaveLength(2);
        expect(ui.calls[1]).toEqual({ key: ADVICE_WIDGET_KEY, content: undefined });
    });

    it("a later present re-keys the clear guard onto the new request", () => {
        const ui = recordingUi();
        const presenter = new AdvicePresenter(ui, true);
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
        const presenter = new AdvicePresenter(ui, true);
        presenter.present("req-1", { state: "unavailable", cause: "x" });
        presenter.shutdown();
        expect(ui.calls.at(-1)).toEqual({
            key: ADVICE_WIDGET_KEY,
            content: undefined,
        });
    });
});

describe("AdvicePresenter with a real ExtensionUIContext-shaped ui", () => {
    it("accepts the overload-style setWidget surface", () => {
        const setWidget = vi.fn();
        const ui = { setWidget } as unknown as AdviceWidgetUi;
        const presenter = new AdvicePresenter(ui, true);
        presenter.present("r", { state: "unavailable", cause: "shape" });
        expect(setWidget).toHaveBeenCalledWith(
            ADVICE_WIDGET_KEY,
            expect.any(Function),
        );
    });
});
