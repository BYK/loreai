export type EntityOperationPolicy = {
  operation: string;
  destructive: boolean;
  dryRun: boolean;
  invalidDryRun: boolean;
  jsonInteractive: boolean;
  requiresYes: boolean;
};

export function entityOperationPolicy(
  args: readonly string[],
  values: Record<string, unknown>,
): EntityOperationPolicy {
  const subcommand = args[0] ?? "";
  const verb = args[1];
  const operation =
    (subcommand === "alias" || subcommand === "relation") && verb
      ? `lore entity ${subcommand} ${verb}`
      : `lore entity ${subcommand}`;
  const destructive =
    subcommand === "delete" ||
    subcommand === "merge" ||
    subcommand === "dedup" ||
    ((subcommand === "alias" || subcommand === "relation") &&
      (verb === "rm" || verb === "remove"));
  const dryRun = values["dry-run"] === true || values.dryRun === true;

  return {
    operation,
    destructive,
    dryRun,
    invalidDryRun: dryRun && subcommand !== "dedup",
    jsonInteractive: values.json === true && values.interactive === true,
    requiresYes: destructive && !dryRun,
  };
}
