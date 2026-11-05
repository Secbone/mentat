# @mentat/panel

Read-only overview projection shared by the CLI and the future DSH web panel.

`buildOverview(repos)` answers the three panel questions in order:

1. What needs a person now? (`needsPerson`, using the Ticket stage table)
2. What is open or already ended?
3. What did the Router decide, and which Workers ran?

`renderOverviewText(overview)` is the terminal view. The web panel should
consume the same JSON instead of re-deriving ticket state.
