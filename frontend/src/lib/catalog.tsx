import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { Catalog } from "../api/types";

const CatalogContext = createContext<Catalog | null>(null);

export function CatalogProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.catalog().then(setCatalog).catch((e) => setError(String(e.message ?? e)));
  }, []);
  if (error) {
    return (
      <div className="boot">
        <h2>Can't reach the SegVal API</h2>
        <p className="muted">{error}</p>
        <p className="muted">Start the backend: <code>uvicorn segval.api.app:app --port 8000</code></p>
      </div>
    );
  }
  if (!catalog) return <div className="boot muted">Loading catalog…</div>;
  return <CatalogContext.Provider value={catalog}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): Catalog {
  const c = useContext(CatalogContext);
  if (!c) throw new Error("useCatalog outside provider");
  return c;
}
