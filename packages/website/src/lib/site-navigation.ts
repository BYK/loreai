/** Shared destinations for the desktop field guide and both mobile menus. */
export function navigationGroups(base: string) {
  return [
    {
      id: "product",
      label: "Product",
      heading: "Meet your project memory",
      links: [
        {
          label: "Explore the app",
          href: `${base}tour/?view=knowledge#product`,
          section: `${base}tour/`,
          description: "See saved sessions, rules and their sources.",
          icon: "app",
        },
        {
          label: "How memory works",
          href: `${base}docs/memory/`,
          description: "What stays stored. What reaches your agent.",
          icon: "memory",
        },
        {
          label: "Connect your coding agent",
          href: `${base}docs/install/`,
          description: "Keep the client you already work with.",
          icon: "connect",
        },
      ],
      feature: {
        art: "journal",
        label: "An interactive field guide",
        title: "One decision. Remembered.",
        description:
          "Follow a useful rule from conversation to your next task.",
        action: "Open the quest journal",
        href: `${base}#journal`,
      },
      footer: "Local history. Reviewable knowledge.",
      footerLink: {
        label: "Data & costs",
        href: `${base}docs/data-and-costs/`,
        external: false,
      },
    },
    {
      id: "resources",
      label: "Resources",
      heading: "Learn and build",
      links: [
        {
          label: "Documentation",
          href: `${base}docs/`,
          section: `${base}docs/`,
          description: "Setup, everyday use and configuration.",
          icon: "docs",
        },
        {
          label: "Blog",
          href: `${base}blog/`,
          section: `${base}blog/`,
          description: "Product ideas and engineering from Lore.",
          icon: "notes",
        },
        {
          label: "Troubleshooting",
          href: `${base}docs/troubleshooting/`,
          description: "Find a missing session or check your setup.",
          icon: "help",
        },
      ],
      feature: {
        art: "tools",
        label: "Your first session",
        title: "A result you can check.",
        description:
          "Connect your agent and find its first recorded conversation.",
        action: "Follow the setup guide",
        href: `${base}docs/first-session/`,
      },
      footer: "Decisions worth keeping.",
      footerLink: {
        label: "Release notes",
        href: "https://github.com/BYK/loreai/releases",
        external: true,
      },
    },
  ] as const;
}

export function currentSection(pathname: string, section?: string) {
  return !section
    ? undefined
    : pathname === section
      ? "page"
      : pathname.startsWith(section)
        ? "true"
        : undefined;
}
