import { useState } from "react";
import { DEMO, api } from "../api/client";
import { useCatalog } from "../lib/catalog";

export function CatalogPage() {
  const catalog = useCatalog();
  const [seedState, setSeedState] = useState<string | null>(null);
  const [customers, setCustomers] = useState(5000);

  const seed = async () => {
    if (!confirm("This replaces all business data in the graph (saved segment definitions are kept). Continue?")) return;
    setSeedState("Loading synthetic data…");
    try {
      const r = await api.seed(customers);
      setSeedState(`Loaded: ${Object.entries(r).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
    } catch (e) {
      setSeedState(`Failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Data catalog</h1>
          <p className="muted">The business vocabulary available in the builder, and where each term lives in the graph.</p>
        </div>
      </div>

      <h2>Graph entities</h2>
      <div className="catalog-grid">
        {catalog.entities.map((e) => (
          <section className="card" key={e.id}>
            <h3>{e.display} <code className="muted small">:{e.label}</code></h3>
            {e.description && <p className="muted small">{e.description}</p>}
            <div className="small muted">
              {Object.entries(e.paths).map(([a, hops]) => (
                <div key={a}>
                  from <b>{a}</b>: <code>{hops.length === 0 ? "(itself)" : hops.map((h) =>
                    `${h.direction === "in" ? "<-" : "-"}[:${h.rel}]${h.direction === "out" ? "->" : "-"}(:${h.label})`).join("")}</code>
                  {e.multi_valued[a] && " · many"}
                </div>
              ))}
            </div>
            <table className="data-table compact">
              <tbody>
                {e.attributes.map((a) => (
                  <tr key={a.id}>
                    <td>{a.display}</td>
                    <td className="muted small">{a.type}{a.unit ? ` · ${a.unit}` : ""}</td>
                    <td className="muted small">{a.values?.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>

      <h2>Metrics</h2>
      <section className="card">
        <table className="data-table">
          <thead><tr><th>Metric</th><th>Calculation</th><th>Time window</th></tr></thead>
          <tbody>
            {catalog.metrics.map((m) => (
              <tr key={m.id}>
                <td>{m.display}</td>
                <td className="small"><code>{m.aggregate}({m.entity}{m.property ? `.${m.property}` : ""})</code></td>
                <td className="small muted">{m.time_property ? `default ${m.default_window_months} months` : "all time"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <h2>Networks</h2>
      <section className="card">
        {catalog.networks.map((n) => (
          <p key={n.id}><b>{n.display}</b> <code className="small">[:{n.rel}]</code> <span className="muted">{n.description}</span></p>
        ))}
      </section>

      {!DEMO && <>
      <h2>Sample data</h2>
      <section className="card">
        <p className="muted small">Development only: generates a synthetic mobile base (personas, call graph, churn clusters).</p>
        <div className="btn-row">
          <label>Customers <input type="number" className="num" value={customers} min={100} max={200000} step={1000}
            onChange={(e) => setCustomers(Number(e.target.value))} /></label>
          <button type="button" className="btn" onClick={seed}>Load sample data</button>
        </div>
        {seedState && <p className="small">{seedState}</p>}
      </section>
      </>}
    </div>
  );
}
