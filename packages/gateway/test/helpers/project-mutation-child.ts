import { close, mergeProjectInternal } from "../../../core/src/db";
import { deleteProject } from "../../../core/src/data";

const [operation, sourceId, targetId] = process.argv.slice(2);
if (!operation || !sourceId)
  throw new Error("missing project mutation arguments");

try {
  if (operation === "merge") {
    if (!targetId) throw new Error("missing merge target");
    mergeProjectInternal(sourceId, targetId);
  } else if (operation === "delete") {
    deleteProject(sourceId);
  } else {
    throw new Error(`unknown project mutation: ${operation}`);
  }
} finally {
  close();
}
