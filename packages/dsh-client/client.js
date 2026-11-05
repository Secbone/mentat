window.__ModuleLoader__.load({
  id: "@mentat/dsh-client",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");

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
    };

    function MentatSection() {
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

      if (state.loading) return React.createElement("div", { style: styles.muted }, "Loading…");
      if (state.error) {
        return React.createElement(
          "div",
          { style: styles.muted },
          "Mentat unavailable: " + state.error,
        );
      }
      const overview = state.overview;
      return React.createElement(
        "div",
        { style: styles.root },
        React.createElement(
          "div",
          { style: styles.head },
          React.createElement("h2", { style: styles.title }, "Mentat"),
          React.createElement("button", { style: styles.button, onClick: load }, "Refresh"),
          React.createElement("button", { style: styles.button, onClick: poll }, "Poll source"),
        ),
        React.createElement(
          "div",
          { style: styles.muted },
          "needs person " +
            overview.counts.needsPerson +
            " · open " +
            overview.counts.open +
            " · tickets " +
            overview.counts.tickets,
        ),
        React.createElement("h3", { style: styles.muted }, "Needs a person"),
        overview.needsPerson.length === 0
          ? React.createElement("div", { style: styles.muted }, "Nothing needs a person.")
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
        React.createElement("h3", { style: styles.muted }, "Open"),
        overview.open.length === 0
          ? React.createElement("div", { style: styles.muted }, "No open Tickets.")
          : overview.open.map((ticket) =>
              React.createElement(
                "div",
                { key: ticket.id, style: styles.row },
                React.createElement("strong", null, ticket.id),
                React.createElement("span", { style: styles.tag }, ticket.stage),
              ),
            ),
        React.createElement(
          "div",
          { style: { ...styles.muted, marginTop: "12px" } },
          Object.entries(overview.decisions)
            .map(([key, value]) => key + "=" + value)
            .join("  "),
        ),
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "mentat",
            order: 80,
            label: "Mentat",
          },
          MentatSection,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
