"use strict";
/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
// Vendored from tinylicious@7.0.1: dist/routes/storage/index.js; changed Git filesystem dependency.
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
exports.create = void 0;
const express_1 = require("express");
const blobs = __importStar(require("./git/blobs"));
const commits = __importStar(require("./git/commits"));
const refs = __importStar(require("./git/refs"));
const tags = __importStar(require("tinylicious/dist/routes/storage/git/tags"));
const trees = __importStar(require("./git/trees"));
const repositoryCommits = __importStar(require("./repository/commits"));
const contents = __importStar(require("./repository/contents"));
const headers = __importStar(
  require("tinylicious/dist/routes/storage/repository/headers"),
);
function create(store) {
  const apiRoutes = {
    git: {
      blobs: blobs.create(store),
      commits: commits.create(store),
      refs: refs.create(store),
      tags: tags.create(store),
      trees: trees.create(store),
    },
    repository: {
      commits: repositoryCommits.create(store),
      contents: contents.create(store),
      headers: headers.create(store),
    },
  };
  const router = (0, express_1.Router)();
  router.use(apiRoutes.git.blobs);
  router.use(apiRoutes.git.refs);
  router.use(apiRoutes.git.tags);
  router.use(apiRoutes.git.trees);
  router.use(apiRoutes.git.commits);
  router.use(apiRoutes.repository.commits);
  router.use(apiRoutes.repository.contents);
  router.use(apiRoutes.repository.headers);
  return router;
}
exports.create = create;
//# sourceMappingURL=index.js.map
