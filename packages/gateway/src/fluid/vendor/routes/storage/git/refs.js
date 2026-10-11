"use strict";
/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
// Vendored from tinylicious@7.0.1: dist/routes/storage/git/refs.js; Git filesystem is SQLite-backed.
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
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.create =
  exports.deleteRef =
  exports.updateRef =
  exports.createRef =
  exports.getRef =
  exports.getRefs =
    void 0;
const express_1 = require("express");
const git = __importStar(require("isomorphic-git"));
const utils = __importStar(require("../utils"));
function refToIRef(ref, sha) {
  return {
    object: {
      sha,
      type: "",
      url: "",
    },
    ref,
    url: "",
  };
}
async function getRefs(store, tenantId, authorization) {
  const branches = await git.listBranches({
    fs: store.gitFs,
    dir: utils.getGitDir(store, tenantId),
  });
  return Promise.all(
    branches.map(async (branch) =>
      getRef(store, tenantId, authorization, branch),
    ),
  );
}
exports.getRefs = getRefs;
async function getRef(store, tenantId, authorization, ref) {
  const resolved = await git.resolveRef({
    fs: store.gitFs,
    dir: utils.getGitDir(store, tenantId),
    ref,
  });
  return refToIRef(ref, resolved);
}
exports.getRef = getRef;
async function createRef(store, tenantId, authorization, params) {
  await git.writeRef({
    fs: store.gitFs,
    dir: utils.getGitDir(store, tenantId),
    ref: params.ref,
    value: params.sha,
  });
  return refToIRef(params.ref, params.sha);
}
exports.createRef = createRef;
async function updateRef(store, tenantId, authorization, ref, params) {
  const dir = utils.getGitDir(store, tenantId);
  // Current code - or nodegit - takes in updates without the /refs input - need to resolve the behavior and
  // either leave in the refs below or update the git managers to include it.
  const rebasedRef = `refs/${ref}`;
  // There is no updateRef in iso-git so we instead delete/write
  await git.writeRef({
    fs: store.gitFs,
    dir,
    force: true,
    ref: rebasedRef,
    value: params.sha,
  });
  return refToIRef(ref, params.sha);
}
exports.updateRef = updateRef;
async function deleteRef(_store, _tenantId, _authorization, _ref) {
  throw new Error("Not implemented");
}
exports.deleteRef = deleteRef;
function create(store) {
  const router = (0, express_1.Router)();
  router.get("/repos/:ignored?/:tenantId/git/refs", (request, response) => {
    const refsP = getRefs(
      store,
      request.params.tenantId,
      request.get("Authorization") ?? "",
    );
    utils.handleResponse(refsP, response, false);
  });
  router.get("/repos/:ignored?/:tenantId/git/refs/*", (request, response) => {
    const refP = getRef(
      store,
      request.params.tenantId,
      request.get("Authorization") ?? "",
      request.params[0],
    );
    utils.handleResponse(refP, response, false);
  });
  router.post("/repos/:ignored?/:tenantId/git/refs", (request, response) => {
    const refP = createRef(
      store,
      request.params.tenantId,
      request.get("Authorization") ?? "",
      request.body,
    );
    utils.handleResponse(refP, response, false, 201);
  });
  router.patch("/repos/:ignored?/:tenantId/git/refs/*", (request, response) => {
    const refP = updateRef(
      store,
      request.params.tenantId,
      request.get("Authorization") ?? "",
      request.params[0],
      request.body,
    );
    utils.handleResponse(refP, response, false);
  });
  router.delete(
    "/repos/:ignored?/:tenantId/git/refs/*",
    (request, response) => {
      const refP = deleteRef(
        store,
        request.params.tenantId,
        request.get("Authorization") ?? "",
        request.params[0],
      );
      utils.handleResponse(refP, response, false, 204);
    },
  );
  return router;
}
exports.create = create;
//# sourceMappingURL=refs.js.map
