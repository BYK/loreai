// Present generated reference rows as readable field records. The source tables
// remain generator-owned; IDs agree with the authored-table directory index.
export default function referenceSearch() {
  return (tree) => {
    const text = (node) =>
      node.value ?? node.children?.map(text).join("") ?? "";
    const element = (tagName, properties, children) => ({
      type: "element",
      tagName,
      properties,
      children,
    });
    function visit(parent) {
      let reference = false;
      let inReference = false;
      let section = "";
      let fieldHeading = 3;
      for (const [index, node] of (parent.children ?? []).entries()) {
        if (node.type === "element") {
          const heading = ["h2", "h3"].includes(node.tagName)
            ? node
            : node.children?.find(
                (child) =>
                  child.type === "element" &&
                  ["h2", "h3"].includes(child.tagName),
              );
          if (heading?.tagName === "h2") {
            reference = ["Field reference", "Setting reference"].includes(
              text(heading),
            );
            if (reference) inReference = true;
          } else if (reference) {
            if (node.tagName === "ul")
              node.properties = { ...node.properties, dataPagefindIgnore: "" };
            reference = false;
          }
          if (inReference && heading) {
            section = text(heading).replaceAll("`", "").trim();
            fieldHeading = heading.tagName === "h3" ? 4 : 3;
          }
          if (node.tagName === "thead")
            node.properties = { ...node.properties, dataPagefindIgnore: "" };
          if (inReference && node.tagName === "table") {
            const cells = (row) =>
              (row.children ?? []).filter(
                (n) => n.type === "element" && ["td", "th"].includes(n.tagName),
              );
            const head = node.children.find((n) => n.tagName === "thead");
            const columns = cells(
              head?.children.find((n) => n.tagName === "tr") ?? {},
            ).map(text);
            if (!["Field", "Variable"].includes(columns[0])) continue;
            const environment = columns[0] === "Variable";
            const body = node.children.find((n) => n.tagName === "tbody");
            const fields = (body?.children ?? [])
              .filter((n) => n.tagName === "tr")
              .map((row) => {
                const values = cells(row);
                const key = values[0]?.children.find(
                  (n) => n.tagName === "code",
                );
                if (!key) return row;
                const field = text(key);
                const label =
                  environment || field.startsWith(section + ".")
                    ? field
                    : section + "." + field;
                const meta = environment
                  ? values[0].children
                      .slice(values[0].children.indexOf(key) + 1)
                      .filter((n, i) => !(i === 0 && n.tagName === "br"))
                  : [
                      element(
                        "dl",
                        { className: ["reference-metadata"] },
                        values
                          .slice(1, -1)
                          .flatMap((value, i) => [
                            element("div", {}, [
                              element("dt", {}, [
                                { type: "text", value: columns[i + 1] },
                              ]),
                              element(
                                "dd",
                                {},
                                value.children.length
                                  ? value.children
                                  : [{ type: "text", value: "—" }],
                              ),
                            ]),
                          ]),
                      ),
                    ];
                return element(
                  "section",
                  {
                    id: `setting-${label}`,
                    className: ["reference-field"],
                    ariaLabel: label,
                  },
                  [
                    element(
                      "div",
                      {
                        id: `field-heading-${label}`,
                        className: ["reference-field-heading"],
                        role: "heading",
                        ariaLevel: fieldHeading,
                      },
                      [
                        element("a", { href: `#setting-${label}` }, [
                          element("code", {}, [{ type: "text", value: label }]),
                        ]),
                      ],
                    ),
                    element("div", { className: ["reference-defaults"] }, meta),
                    element(
                      "div",
                      { className: ["reference-description"] },
                      values.at(-1)?.children ?? [],
                    ),
                  ],
                );
              });
            parent.children[index] = element(
              "div",
              { className: ["reference-fields"] },
              fields,
            );
            continue;
          }
        }
        if (node.children) visit(node);
      }
    }
    visit(tree);
  };
}
