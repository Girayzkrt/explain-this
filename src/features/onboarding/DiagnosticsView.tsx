import { useState } from "react";
import {
  createSanitizedDiagnosticReport,
  serializeDiagnosticReport,
  type DiagnosticFacts,
} from "./diagnostics";

export interface DiagnosticsViewProps {
  facts: DiagnosticFacts;
  copyReport(report: string): Promise<void>;
}

export function DiagnosticsView({ facts, copyReport }: DiagnosticsViewProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const report = serializeDiagnosticReport(createSanitizedDiagnosticReport(facts));

  function copyDiagnostics(): void {
    try {
      void copyReport(report).then(
        () => setStatus("copied"),
        () => setStatus("failed"),
      );
    } catch {
      setStatus("failed");
    }
  }

  return (
    <section className="diagnostics-view" aria-labelledby="diagnostics-title">
      <h3 id="diagnostics-title">Connection diagnostics</h3>
      <p>Includes only local setup facts and never page text or model responses.</p>
      <button
        className="button button-secondary"
        type="button"
        onClick={copyDiagnostics}
      >
        Copy diagnostics
      </button>
      {status === "copied" ? <p role="status">Diagnostics copied.</p> : null}
      {status === "failed" ? (
        <p role="alert">Could not copy diagnostics. Try again.</p>
      ) : null}
    </section>
  );
}
