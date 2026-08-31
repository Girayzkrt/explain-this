import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

export interface SafeMarkdownProps {
  children: string;
}

export function SafeMarkdown({ children }: SafeMarkdownProps) {
  return (
    <ReactMarkdown
      skipHtml
      rehypePlugins={[rehypeSanitize]}
      components={{
        a: ({ children: label }) => (
          <span className="reader-markdown-link-text">{label}</span>
        ),
        img: ({ alt }) => (
          <span className="reader-markdown-image-text">{alt ?? "Image"}</span>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
