import { ensureUiAssetsStaged } from "../../script/ui-assets";

export default async function setup(): Promise<void> {
  await ensureUiAssetsStaged();
}
