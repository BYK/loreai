"use strict";
/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
// Vendored from tinylicious@7.0.1: dist/routes/storage/git/trees.js; Git filesystem is SQLite-backed.
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
exports.create = exports.getTree = exports.createTree = void 0;
const express_1 = require("express");
const git = __importStar(require("isomorphic-git"));
const utils = __importStar(require("../utils"));
async function createTree(store, tenantId, authorization, params) {
  const entries = params.tree.map((tree) => {
    const entry = {
      mode: tree.mode,
      oid: tree.sha,
      path: tree.path,
      type: "tree",
    };
    return entry;
  });
  const sha = await git.writeTree({
    fs: store.gitFs,
    dir: utils.getGitDir(store, tenantId),
    tree: entries,
  });
  return getTree(store, tenantId, authorization, sha, false, true);
}
exports.createTree = createTree;
async function getTree(
  store,
  tenantId,
  authorization,
  sha,
  recursive,
  _useCache,
) {
  let returnEntries;
  if (recursive) {
    returnEntries = await git.walk({
      fs: store.gitFs,
      dir: utils.getGitDir(store, tenantId),
      map: async (path, [head]) => {
        if (path === ".") {
          return;
        }
        return {
          path,
          mode: (await head.mode()).toString(8),
          sha: await head.oid(),
          size: 0,
          type: await head.type(),
          url: "",
        };
      },
      trees: [git.TREE({ ref: sha })],
    });
  } else {
    const treeObject = await git.readTree({
      fs: store.gitFs,
      dir: utils.getGitDir(store, tenantId),
      oid: sha,
    });
    const description = treeObject.tree;
    returnEntries = description.map((tree) => {
      const returnEntry = {
        path: tree.path,
        mode: tree.mode,
        sha: tree.oid,
        size: 0,
        type: tree.type,
        url: "",
      };
      return returnEntry;
    });
  }
  return {
    sha,
    tree: returnEntries,
    url: "",
  };
}
exports.getTree = getTree;
function create(store) {
  const router = (0, express_1.Router)();
  router.post("/repos/:ignored?/:tenantId/git/trees", (request, response) => {
    const treeP = createTree(
      store,
      request.params.tenantId,
      request.get("Authorization") ?? "",
      request.body,
    );
    utils.handleResponse(treeP, response, false, 201);
  });
  router.get(
    "/repos/:ignored?/:tenantId/git/trees/:sha",
    (request, response) => {
      const useCache = !("disableCache" in request.query);
      const treeP = getTree(
        store,
        request.params.tenantId,
        request.get("Authorization") ?? "",
        request.params.sha,
        request.query.recursive === "1",
        useCache,
      );
      utils.handleResponse(treeP, response, useCache);
    },
  );
  return router;
}
exports.create = create;
//# sourceMappingURL=trees.js.map
