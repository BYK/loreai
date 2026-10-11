"use strict";
/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
// Vendored from tinylicious@7.0.1: dist/routes/storage/repository/commits.js; Git filesystem is SQLite-backed.
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
exports.create = exports.getCommits = void 0;
const express_1 = require("express");
const git = __importStar(require("isomorphic-git"));
const utils_1 = require("../../../utils");
const utils = __importStar(require("../utils"));
async function getCommits(store, tenantId, authorization, sha, count) {
  const descriptions = await git.log({
    fs: store.gitFs,
    depth: count,
    dir: utils.getGitDir(store, tenantId),
    ref: sha,
  });
  return descriptions.map((description) => {
    return {
      url: "",
      sha: description.oid,
      commit: {
        url: "",
        author: {
          name: description.commit.author.name,
          email: description.commit.author.email,
          date: new Date(
            description.commit.author.timestamp * 1000,
          ).toISOString(),
        },
        committer: {
          name: description.commit.committer.name,
          email: description.commit.committer.email,
          date: new Date(
            description.commit.committer.timestamp * 1000,
          ).toISOString(),
        },
        message: description.commit.message,
        tree: {
          sha: description.commit.tree,
          url: "",
        },
      },
      parents: description.commit.parent.map((parent) => ({
        sha: parent,
        url: "",
      })),
    };
  });
}
exports.getCommits = getCommits;
function create(store) {
  const router = (0, express_1.Router)();
  router.get("/repos/:ignored?/:tenantId/commits", (request, response) => {
    const commitsP = getCommits(
      store,
      request.params.tenantId,
      request.get("Authorization") ?? "",
      (0, utils_1.queryParamToString)(request.query.sha) ?? "",
      (0, utils_1.queryParamToNumber)(request.query.count) ?? 1,
    );
    utils.handleResponse(commitsP, response, false);
  });
  return router;
}
exports.create = create;
//# sourceMappingURL=commits.js.map
