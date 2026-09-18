/* @refresh reload */
import { render } from "solid-js/web";

import "./styles/app.css";
import { App } from "./app";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Lore UI: #root element not found");
}

render(() => <App />, root);
