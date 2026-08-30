import type { PublicErrorShape } from "../providers/provider";

export interface PublicErrorNoticeProps {
  error: PublicErrorShape;
  onRetry?: () => void;
}

export function PublicErrorNotice({ error, onRetry }: PublicErrorNoticeProps) {
  return (
    <div className="error-notice" role="alert">
      <p>{error.message}</p>
      {error.recoverable && onRetry ? (
        <button className="button button-secondary" type="button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
