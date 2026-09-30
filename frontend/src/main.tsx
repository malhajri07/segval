import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, MemoryRouter } from "react-router-dom";
import { DEMO } from "./api/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* The demo may run in a sandboxed about:srcdoc frame with no usable URL, so route in memory. */}
    {DEMO ? <MemoryRouter><App /></MemoryRouter> : <BrowserRouter><App /></BrowserRouter>}
  </StrictMode>,
);
