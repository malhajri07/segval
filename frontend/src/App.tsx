import { NavLink, Route, Routes } from "react-router-dom";
import { CatalogProvider } from "./lib/catalog";
import { BuilderPage } from "./pages/BuilderPage";
import { CatalogPage } from "./pages/CatalogPage";
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
          <NavLink to="/overlap">Overlap</NavLink>
          <NavLink to="/catalog">Catalog</NavLink>
        </nav>
      </header>
      <main>
        <CatalogProvider>
          <Routes>
            <Route path="/" element={<SegmentsPage />} />
            <Route path="/builder" element={<BuilderPage key="new" />} />
            <Route path="/builder/:id" element={<BuilderPage />} />
            <Route path="/segments/:id" element={<SegmentPage />} />
            <Route path="/overlap" element={<OverlapPage />} />
            <Route path="/catalog" element={<CatalogPage />} />
          </Routes>
        </CatalogProvider>
      </main>
    </div>
  );
}
