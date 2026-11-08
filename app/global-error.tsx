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
          background: "#0e1117",
          color: "#f3efe6",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          textAlign: "center",
          padding: 24,
        }}
      >
        <div>
          <div style={{ fontSize: 40, fontWeight: 900, color: "#ebb84b" }}>Chase</div>
          <h2 style={{ fontWeight: 700 }}>Noe gikk galt</h2>
          <p style={{ color: "#a3a9b6" }}>Last inn siden på nytt.</p>
          <button
            onClick={() => reset()}
            style={{
              marginTop: 12,
              padding: "12px 22px",
              borderRadius: 12,
              border: "none",
              background: "linear-gradient(135deg,#f6dd97,#ebb84b)",
              color: "#1a1305",
              fontWeight: 700,
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
