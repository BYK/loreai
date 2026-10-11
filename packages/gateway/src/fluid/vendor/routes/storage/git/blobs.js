"use strict";
/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
// Vendored from tinylicious@7.0.1: dist/routes/storage/git/blobs.js; Git filesystem is SQLite-backed.
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
exports.create = exports.getBlob = exports.createBlob = void 0;
const common_utils_1 = require("@fluidframework/common-utils");
// eslint-disable-next-line import/no-deprecated
const express_1 = require("express");
const git = __importStar(require("isomorphic-git"));
const utils = __importStar(require("../utils"));
async function createBlob(store, tenantId, authorization, body) {
  const buffer = Buffer.from(body.content, body.encoding);
  const sha = await git.writeBlob({
    fs: store.gitFs,
    dir: utils.getGitDir(store, tenantId),
    blob: buffer,
  });
  return {
    sha,
    url: "",
  };
}
exports.createBlob = createBlob;
async function getBlob(store, tenantId, authorization, sha, _useCache) {
  const gitObj = await git.readBlob({
    fs: store.gitFs,
    dir: utils.getGitDir(store, tenantId),
    oid: sha,
  });
  const buffer = gitObj.blob;
  const result = {
    url: "",
    sha,
    size: buffer.length,
    // eslint-disable-next-line import/no-deprecated
    content: (0, common_utils_1.Uint8ArrayToString)(buffer, "base64"),
    encoding: "base64",
  };
  return result;
}
exports.getBlob = getBlob;
function create(store) {
  const router = (0, express_1.Router)();
  router.post("/repos/:ignored?/:tenantId/git/blobs", (request, response) => {
    const blobP = createBlob(
      store,
      request.params.tenantId,
      request.get("Authorization") ?? "",
      request.body,
    );
    utils.handleResponse(blobP, response, false, 201);
  });
  /**
   * Retrieves the given blob from the repository
   */
  router.get(
    "/repos/:ignored?/:tenantId/git/blobs/:sha",
    (request, response) => {
      const useCache = !("disableCache" in request.query);
      const blobP = getBlob(
        store,
        request.params.tenantId,
        request.get("Authorization") ?? "",
        request.params.sha,
        useCache,
      );
      utils.handleResponse(blobP, response, useCache);
    },
  );
  /**
   * Retrieves the given blob as an image
   */
  router.get(
    "/repos/:ignored?/:tenantId/git/blobs/raw/:sha",
    (request, response) => {
      const useCache = !("disableCache" in request.query);
      const blobP = getBlob(
        store,
        request.params.tenantId,
        request.get("Authorization") ?? "",
        request.params.sha,
        useCache,
      );
      blobP.then(
        (blob) => {
          if (useCache) {
            response.setHeader("Cache-Control", "public, max-age=31536000");
          }
          response
            .status(200)
            .write(Buffer.from(blob.content, "base64"), () => response.end());
        },
        (error) => {
          response.status(400).json(error);
        },
      );
    },
  );
  return router;
}
exports.create = create;
//# sourceMappingURL=blobs.js.map
