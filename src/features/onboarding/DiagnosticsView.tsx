import { useEffect, useRef, useState } from "react";
import {
  createSanitizedDiagnosticReport,
  serializeDiagnosticReport,
  type TrustedDiagnosticOverrides,
} from "./diagnostics";

export interface DiagnosticsViewProps {
  facts: unknown;
  trustedOverrides?: TrustedDiagnosticOverrides;
  copyReport(report: string): Promise<void>;
}

export function DiagnosticsView({
  facts,
  trustedOverrides,
  copyReport,
}: DiagnosticsViewProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const mounted = useRef(true);
  const operationId = useRef(0);
  const report = serializeDiagnosticReport(
    createSanitizedDiagnosticReport(facts, trustedOverrides),
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function copyDiagnostics(): void {
    const currentOperation = ++operationId.current;
    const updateStatus = (nextStatus: "copied" | "failed") => {
      if (mounted.current && currentOperation === operationId.current) {
        setStatus(nextStatus);
      }
    };

    try {
      void copyReport(report).then(
        () => updateStatus("copied"),
        () => updateStatus("failed"),
      );
    } catch {
      updateStatus("failed");
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
