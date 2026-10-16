import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * A legal document from `src/legal/*.md`, rendered on the server (no client JavaScript).
 * The Markdown files are the source to edit.
 */
export function LegalPage({ source }: { source: string }) {
  return (
    <article className="mx-auto max-w-3xl pb-16 text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h1 className="mb-2 text-3xl font-semibold tracking-tight" {...p} />,
          h2: (p) => <h2 className="mt-10 mb-3 text-lg font-semibold" {...p} />,
          p: (p) => <p className="my-3 text-pretty text-fg/90" {...p} />,
          em: (p) => <em className="text-muted" {...p} />,
          ul: (p) => <ul className="my-3 list-disc space-y-1.5 pl-5" {...p} />,
          ol: (p) => <ol className="my-3 list-decimal space-y-1.5 pl-5" {...p} />,
          a: (p) => <a className="text-accent underline underline-offset-2" {...p} />,
          code: (p) => <code className="rounded bg-bg-subtle px-1 py-0.5 font-mono text-[0.85em]" {...p} />,
          table: (p) => (
            <div className="my-4 overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-left text-xs" {...p} />
            </div>
          ),
          th: (p) => <th className="border-b border-border bg-bg-subtle px-3 py-2 font-medium" {...p} />,
          td: (p) => <td className="border-b border-border px-3 py-2 align-top" {...p} />,
        }}
      >
        {source}
      </ReactMarkdown>
    </article>
  );
}
