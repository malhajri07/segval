import { NavLink, Route, Routes } from "react-router-dom";
import { DEMO } from "./api/client";
import { CatalogProvider } from "./lib/catalog";
import { BuilderPage } from "./pages/BuilderPage";
import { CatalogPage } from "./pages/CatalogPage";
import { GraphPage } from "./pages/GraphPage";
import { OverlapPage } from "./pages/OverlapPage";
import { SegmentPage } from "./pages/SegmentPage";
import { SegmentsPage } from "./pages/SegmentsPage";

export function App() {
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="logo" aria-hidden>◆</span> SegVal</div>
        <nav>
          <NavLink to="/" end>Segments</NavLink>
          <NavLink to="/builder">Builder</NavLink>
          <NavLink to="/graph">Graph</NavLink>
          <NavLink to="/overlap">Overlap</NavLink>
          <NavLink to="/catalog">Catalog</NavLink>
        </nav>
        {DEMO && (
          <span className="demo-badge" title="Runs entirely in this page on a synthetic sample of 2,000 customers">
            Demo · sample data
          </span>
        )}
      </header>
      <main>
        <CatalogProvider>
          <Routes>
            <Route path="/" element={<SegmentsPage />} />
            <Route path="/builder" element={<BuilderPage key="new" />} />
            <Route path="/builder/:id" element={<BuilderPage />} />
            <Route path="/segments/:id" element={<SegmentPage />} />
            <Route path="/graph" element={<GraphPage />} />
            <Route path="/overlap" element={<OverlapPage />} />
            <Route path="/catalog" element={<CatalogPage />} />
          </Routes>
        </CatalogProvider>
      </main>
    </div>
  );
}
