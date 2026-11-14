"use client";

// Catches errors in the root layout itself. Must render its own <html>/<body>
// and cannot rely on the app stylesheet, so it is fully inline-styled.
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="no">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          background: "#f7f4ed",
          color: "#14171e",
          fontFamily: "'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          textAlign: "center",
          padding: 24,
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase", color: "#8a6410" }}>Chase</div>
          <h2 style={{ fontWeight: 900, fontSize: 30, margin: "8px 0 0" }}>Noe gikk galt</h2>
          <p style={{ color: "#5c6370" }}>Last inn siden på nytt.</p>
          <button
            onClick={() => reset()}
            style={{
              marginTop: 20,
              minHeight: 48,
              padding: "0 24px",
              borderRadius: 14,
              border: "none",
              background: "#ebb84b",
              color: "#0e1117",
              fontWeight: 800,
              boxShadow: "0 1px 2px rgb(20 23 30 / 0.05), 0 8px 24px -12px rgb(20 23 30 / 0.18)",
              fontSize: 16,
              cursor: "pointer",
            }}
          >
            Prøv igjen
          </button>
        </div>
      </body>
    </html>
  );
}
