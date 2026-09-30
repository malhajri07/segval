import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import { DEMO } from "./api/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {DEMO ? <HashRouter><App /></HashRouter> : <BrowserRouter><App /></BrowserRouter>}
  </StrictMode>,
);
