window.__ModuleLoader__.load({
  id: "@mentat/dsh-client",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");

    const EN = {
      nav: "Mentat",
      refresh: "Refresh",
      poll: "Poll source",
      needs: "Needs a person",
      open: "Open",
      assignments: "Assignments",
      evolution: "Evolution",
      decisions: "Decisions",
      source: "Source",
      sourceActive: "active",
      sourceIdle: "idle",
      noSource: "No source configured.",
      lastPoll: "last poll",
      never: "never",
      pollCount: "triggers",
      pollError: "error",
      emptyNeeds: "Nothing needs a person.",
      emptyOpen: "No open Tickets.",
      emptyAssignments: "No Assignments.",
      emptyEvolution: "No evolution candidates.",
      loading: "Loading…",
      unavailable: "Mentat unavailable: {error}",
      counts: "needs person {needs} · open {open} · tickets {tickets}",
      noPack: "no pack",
    };

    const ZH = {
      nav: "Mentat",
      refresh: "刷新",
      poll: "轮询来源",
      needs: "需要人处理",
      open: "进行中",
      assignments: "执行任务",
      evolution: "进化候选",
      decisions: "决策",
      source: "来源",
      sourceActive: "运行中",
      sourceIdle: "空闲",
      noSource: "未配置来源。",
      lastPoll: "上次轮询",
      never: "从未",
      pollCount: "触发数",
      pollError: "错误",
      emptyNeeds: "当前不需要人处理。",
      emptyOpen: "没有进行中的工单。",
      emptyAssignments: "没有执行任务。",
      emptyEvolution: "没有进化候选。",
      loading: "加载中…",
      unavailable: "Mentat 不可用：{error}",
      counts: "需要人 {needs} · 进行中 {open} · 工单 {tickets}",
      noPack: "无能力包",
    };

    const styles = {
      root: { padding: "4px 2px", color: "var(--dsw-alias-label-primary)" },
      head: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" },
      title: { fontSize: "15px", fontWeight: 600, margin: 0, flex: 1 },
      button: {
        background: "var(--dsw-alias-fill-l1)",
        color: "var(--dsw-alias-label-primary)",
        border: "0.5px solid var(--dsw-alias-border-l1)",
        borderRadius: "6px",
        padding: "5px 9px",
        cursor: "pointer",
        fontSize: "12px",
      },
      muted: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" },
      row: {
        border: "0.5px solid var(--dsw-alias-border-l1)",
        borderRadius: "8px",
        padding: "8px 10px",
        margin: "6px 0",
        background: "var(--dsw-alias-fill-l1)",
      },
      tag: { marginLeft: "6px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" },
      mono: { fontFamily: "var(--dsw-font-mono)", fontSize: "11px" },
    };

    function shortDigest(digest) {
      if (!digest) return "";
      const value = String(digest);
      return value.length > 16 ? value.slice(0, 16) + "…" : value;
    }

    function format(t, key, values) {
      let text = t(key);
      for (const [name, value] of Object.entries(values ?? {})) {
        text = text.replaceAll("{" + name + "}", String(value));
      }
      return text;
    }

    function MentatSection({ t }) {
      const [state, setState] = React.useState({ loading: true });

      const load = React.useCallback(async () => {
        try {
          const response = await fetch("/mentat/overview");
          if (!response.ok) throw new Error("HTTP " + response.status);
          const overview = await response.json();
          setState({ loading: false, overview });
        } catch (error) {
          setState({ loading: false, error: String(error) });
        }
      }, []);

      React.useEffect(() => {
        load();
      }, [load]);

      const poll = React.useCallback(async () => {
        try {
          await fetch("/mentat/poll", { method: "POST" });
          await load();
        } catch (error) {
          setState({ loading: false, error: String(error) });
        }
      }, [load]);

      if (state.loading) return React.createElement("div", { style: styles.muted }, t("loading"));
      if (state.error) {
        return React.createElement(
          "div",
          { style: styles.muted },
          format(t, "unavailable", { error: state.error }),
        );
      }
      const overview = state.overview;
      const assignments = overview.assignments ?? [];
      const evolution = overview.evolution ?? [];
      return React.createElement(
        "div",
        { style: styles.root },
        React.createElement(
          "div",
          { style: styles.head },
          React.createElement("h2", { style: styles.title }, t("nav")),
          React.createElement("button", { style: styles.button, onClick: load }, t("refresh")),
          React.createElement("button", { style: styles.button, onClick: poll }, t("poll")),
        ),
        React.createElement(
          "div",
          { style: styles.muted },
          format(t, "counts", {
            needs: overview.counts.needsPerson,
            open: overview.counts.open,
            tickets: overview.counts.tickets,
          }),
        ),
        React.createElement("h3", { style: styles.muted }, t("source")),
        overview.source
          ? React.createElement(
              "div",
              { style: styles.row },
              React.createElement(
                "strong",
                null,
                overview.source.active ? t("sourceActive") : t("sourceIdle"),
              ),
              React.createElement(
                "div",
                { style: styles.muted },
                t("lastPoll") +
                  ": " +
                  (overview.source.lastPollAt || t("never")) +
                  (overview.source.lastPollCount !== undefined
                    ? " · " + t("pollCount") + " " + overview.source.lastPollCount
                    : "") +
                  (overview.source.lastError
                    ? " · " + t("pollError") + ": " + overview.source.lastError
                    : ""),
              ),
            )
          : React.createElement("div", { style: styles.muted }, t("noSource")),
        React.createElement("h3", { style: styles.muted }, t("needs")),
        overview.needsPerson.length === 0
          ? React.createElement("div", { style: styles.muted }, t("emptyNeeds"))
          : overview.needsPerson.map((ticket) =>
              React.createElement(
                "div",
                { key: ticket.id, style: styles.row },
                React.createElement("strong", null, ticket.id),
                React.createElement("span", { style: styles.tag }, ticket.stage),
                React.createElement(
                  "div",
                  { style: styles.muted },
                  ticket.question || ticket.latestReport || "",
                ),
              ),
            ),
        React.createElement("h3", { style: styles.muted }, t("open")),
        overview.open.length === 0
          ? React.createElement("div", { style: styles.muted }, t("emptyOpen"))
          : overview.open.map((ticket) =>
              React.createElement(
                "div",
                { key: ticket.id, style: styles.row },
                React.createElement("strong", null, ticket.id),
                React.createElement("span", { style: styles.tag }, ticket.stage),
              ),
            ),
        React.createElement("h3", { style: styles.muted }, t("assignments")),
        assignments.length === 0
          ? React.createElement("div", { style: styles.muted }, t("emptyAssignments"))
          : assignments.map((assignment) =>
              React.createElement(
                "div",
                { key: assignment.id, style: styles.row },
                React.createElement("strong", null, assignment.worker),
                React.createElement("span", { style: styles.tag }, assignment.state),
                React.createElement(
                  "div",
                  { style: styles.mono },
                  assignment.packDigest ? shortDigest(assignment.packDigest) : t("noPack"),
                ),
              ),
            ),
        React.createElement("h3", { style: styles.muted }, t("evolution")),
        evolution.length === 0
          ? React.createElement("div", { style: styles.muted }, t("emptyEvolution"))
          : evolution.map((candidate) =>
              React.createElement(
                "div",
                { key: candidate.id, style: styles.row },
                React.createElement("strong", null, "v" + candidate.version),
                React.createElement("span", { style: styles.tag }, candidate.status),
                React.createElement(
                  "div",
                  { style: styles.mono },
                  shortDigest(candidate.digest) +
                    (candidate.reason ? " · " + candidate.reason : ""),
                ),
              ),
            ),
        React.createElement(
          "div",
          { style: { ...styles.muted, marginTop: "12px" } },
          t("decisions") +
            ": " +
            Object.entries(overview.decisions)
              .map(([key, value]) => key + "=" + value)
              .join("  "),
        ),
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register("mentat", { en: EN, zh: ZH }), "mentat: dictionaries");
      const t = ctx.locale.bind("mentat");
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "mentat",
            order: 80,
            label: () => t("nav"),
            locale: "mentat",
            inject: () => ({ t }),
          },
          MentatSection,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  },
});
