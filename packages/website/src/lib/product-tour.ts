export const TOUR_SCREENS = [
  {
    id: "sessions",
    choice: "Find a session",
    title: "See what Lore recorded",
    description:
      "Open your project’s Sessions list to find a recorded conversation. A session appearing here is your first connection check.",
    link: "first-session/#verify",
    action: "Verify your first session",
    alt: "Actual Lore app with a sample webhook-service project and three recorded sessions",
  },
  {
    id: "knowledge",
    choice: "Review knowledge",
    title: "Read the rule and where it came from",
    description:
      "Open a knowledge entry, inspect Source & history, and edit inaccurate information. Review the resulting .lore.md diff before sharing it through Git.",
    link: "using-lore/#review-knowledge",
    action: "Learn to review knowledge",
    alt: "Actual Lore app showing a sample webhook decision, its content, and source history",
  },
  {
    id: "usage",
    choice: "Inspect activity",
    title: "Understand your model activity",
    description:
      "Model usage counts recorded session-days by model. For estimated spending and background work, use Providers & costs in the app; activity counts are not a bill.",
    link: "data-and-costs/#inspect-usage",
    action: "Understand usage and costs",
    alt: "Actual Lore Model usage screen with synthetic session-day counts across two models",
  },
];
