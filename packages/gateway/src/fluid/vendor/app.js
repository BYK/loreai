"use strict";
/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
// Vendored from tinylicious@7.0.1: dist/app.js; routes are redirected to the SQLite-backed adapter.
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
exports.create = void 0;
const server_services_shared_1 = require("@fluidframework/server-services-shared");
const body_parser_1 = require("body-parser");
const compression_1 = __importDefault(require("compression"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const cors_1 = __importDefault(require("cors"));
const express_1 = __importStar(require("express"));
const json_stringify_safe_1 = __importDefault(require("json-stringify-safe"));
const morgan_1 = __importDefault(require("morgan"));
const winston = __importStar(require("winston"));
const routes_1 = require("./routes");
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const split = require("split");
/**
 * Basic stream logging interface for libraries that require a stream to pipe output to (re: Morgan)
 */
const stream = split().on("data", (message) => {
  winston.info(message);
});
function create(
  config,
  storage,
  mongoManager,
  // eslint-disable-next-line import/no-deprecated
  collaborationSessionEventEmitter,
  authorize,
) {
  // Maximum REST request size
  const requestSize = config.get("alfred:restJsonSize");
  // Express app configuration
  const app = (0, express_1.default)();
  // initialize RestLess server translation
  const restLessMiddleware = () => {
    const restLessServer = new server_services_shared_1.RestLessServer();
    return (req, res, next) => {
      void restLessServer
        .translate(req, res)
        .then(() => next())
        .catch(next);
    };
  };
  app.use(restLessMiddleware());
  // Running behind iisnode
  app.set("trust proxy", 1);
  app.use((0, compression_1.default)());
  app.use((0, morgan_1.default)(config.get("logger:morganFormat"), { stream }));
  app.use((0, cookie_parser_1.default)());
  app.use((0, body_parser_1.json)({ limit: requestSize }));
  app.use(
    (0, body_parser_1.urlencoded)({ limit: requestSize, extended: false }),
  );
  // Bind routes
  const routes = (0, routes_1.create)(
    config,
    mongoManager,
    storage,
    collaborationSessionEventEmitter,
  );
  app.use((0, cors_1.default)());
  // Lore spike: authorize after RestLess translation and CORS preflight handling.
  if (authorize) app.use(authorize);
  app.use(routes.storage);
  app.use(routes.ordering);
  // Basic Help Message
  app.use(
    (0, express_1.Router)().get("/", (req, res) => {
      res
        .status(200)
        .send(
          "This is Tinylicious. Learn more at https://github.com/microsoft/FluidFramework/tree/main/server/routerlicious/packages/tinylicious",
        );
    }),
  );
  // Catch 404 and forward to error handler
  app.use((req, res, next) => {
    const err = new Error("Not Found");
    err.status = 404;
    next(err);
  });
  // Error handlers
  app.use((err, req, res, _next) => {
    res.status(err.status || 500);
    res.json({
      error: (0, json_stringify_safe_1.default)(err),
      message: err.message,
    });
  });
  return app;
}
exports.create = create;
//# sourceMappingURL=app.js.map
