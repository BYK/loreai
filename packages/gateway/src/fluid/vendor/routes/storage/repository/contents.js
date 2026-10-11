"use strict";
/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
// Vendored from tinylicious@7.0.1: dist/routes/storage/repository/contents.js; Git filesystem is SQLite-backed.
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (
          !desc ||
          ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)
        ) {
          desc = {
            enumerable: true,
            get: function () {
              return m[k];
            },
          };
        }
        Object.defineProperty(o, k2, desc);
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? function (o, v) {
        Object.defineProperty(o, "default", { enumerable: true, value: v });
      }
    : function (o, v) {
        o["default"] = v;
      });
var __importStar =
  (this && this.__importStar) ||
  function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null)
      for (var k in mod)
        if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k))
          __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = exports.getContent = void 0;
const express_1 = require("express");
const utils_1 = require("../../../utils");
const blobs_1 = require("../git/blobs");
const trees_1 = require("../git/trees");
const utils = __importStar(require("../utils"));
async function getContent(store, tenantId, authorization, path, ref) {
  const tree = await (0, trees_1.getTree)(
    store,
    tenantId,
    authorization,
    ref,
    true,
    true,
  );
  let content;
  for (const entry of tree.tree) {
    if (entry.path === path) {
      content = await (0, blobs_1.getBlob)(
        store,
        tenantId,
        authorization,
        entry.sha,
        true,
      );
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return content;
}
exports.getContent = getContent;
function create(store) {
  const router = (0, express_1.Router)();
  router.get("/repos/:ignored?/:tenantId/contents/*", (request, response) => {
    const contentP = getContent(
      store,
      request.params.tenantId,
      request.get("Authorization") ?? "",
      request.params[0],
      (0, utils_1.queryParamToString)(request.query.ref) ?? "",
    );
    utils.handleResponse(contentP, response, false);
  });
  return router;
}
exports.create = create;
//# sourceMappingURL=contents.js.map
