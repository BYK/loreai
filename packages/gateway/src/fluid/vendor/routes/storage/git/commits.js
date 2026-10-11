"use strict";
/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
// Vendored from tinylicious@7.0.1: dist/routes/storage/git/commits.js; Git filesystem is SQLite-backed.
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
exports.create = exports.getCommit = exports.createCommit = void 0;
const express_1 = require("express");
const git = __importStar(require("isomorphic-git"));
const utils = __importStar(require("../utils"));
async function createCommit(store, tenantId, authorization, params) {
  // TODO should include both author and committer
  const author = {
    email: params.author.email,
    name: params.author.name,
    timestamp: Math.floor(Date.parse(params.author.date) / 1000),
    timezoneOffset: 0,
  };
  const commitObject = {
    message: params.message,
    parent: params.parents,
    tree: params.tree,
    author,
    committer: author,
  };
  const sha = await git.writeCommit({
    fs: store.gitFs,
    dir: utils.getGitDir(store, tenantId),
    commit: commitObject,
  });
  return {
    author: params.author,
    committer: params.author,
    message: params.message,
    parents: params.parents.map((parentSha) => ({
      sha: parentSha,
      url: "",
    })),
    sha,
    tree: { sha: params.tree, url: "" },
    url: "",
  };
}
exports.createCommit = createCommit;
async function getCommit(store, tenantId, authorization, sha, _useCache) {
  const commit = await git.readCommit({
    fs: store.gitFs,
    dir: utils.getGitDir(store, tenantId),
    oid: sha,
  });
  const description = commit.commit;
  return {
    author: {
      email: description.author.email,
      name: description.author.name,
      date: new Date(description.author.timestamp * 1000).toISOString(),
    },
    committer: {
      email: description.committer.email,
      name: description.committer.name,
      date: new Date(description.committer.timestamp * 1000).toISOString(),
    },
    message: description.message,
    parents: description.parent.map((parentSha) => ({
      sha: parentSha,
      url: "",
    })),
    sha,
    tree: { sha: description.tree, url: "" },
    url: "",
  };
}
exports.getCommit = getCommit;
function create(store) {
  const router = (0, express_1.Router)();
  router.post("/repos/:ignored?/:tenantId/git/commits", (request, response) => {
    const commitP = createCommit(
      store,
      request.params.tenantId,
      request.get("Authorization") ?? "",
      request.body,
    );
    utils.handleResponse(commitP, response, false, 201);
  });
  router.get(
    "/repos/:ignored?/:tenantId/git/commits/:sha",
    (request, response) => {
      const useCache = !("disableCache" in request.query);
      const commitP = getCommit(
        store,
        request.params.tenantId,
        request.get("Authorization") ?? "",
        request.params.sha,
        useCache,
      );
      utils.handleResponse(commitP, response, useCache);
    },
  );
  return router;
}
exports.create = create;
//# sourceMappingURL=commits.js.map
