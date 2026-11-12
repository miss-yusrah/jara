import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Chat-style Markdown rendering for Jara AI answers (Tailwind only).
export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-[15.5px] leading-relaxed text-ink [&>*:first-child]:mt-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h1 className="mt-2 mb-3 text-2xl leading-tight font-extrabold tracking-tight" {...p} />,
          h2: (p) => <h2 className="mt-6 mb-2 text-lg font-extrabold text-forest" {...p} />,
          h3: (p) => <h3 className="mt-4 mb-1.5 font-extrabold" {...p} />,
          p: (p) => <p className="my-3" {...p} />,
          ul: (p) => <ul className="my-3 grid list-disc gap-1.5 pl-6 marker:text-mandarin" {...p} />,
          ol: (p) => <ol className="my-3 grid list-decimal gap-1.5 pl-6 marker:font-bold marker:text-mandarin" {...p} />,
          li: (p) => <li className="pl-1" {...p} />,
          strong: (p) => <strong className="font-extrabold" {...p} />,
          a: (p) => <a className="font-semibold text-forest underline" target="_blank" rel="noreferrer" {...p} />,
          blockquote: (p) => <blockquote className="my-3 border-l-4 border-crest pl-4 text-ink/70 italic" {...p} />,
          hr: () => <hr className="my-5 border-ink/10" />,
          code: ({ className, children, ...p }) =>
            className ? (
              <code className={`block overflow-x-auto rounded-xl bg-ink/[0.05] p-4 font-mono text-sm ${className}`} {...p}>
                {children}
              </code>
            ) : (
              <code className="rounded-md bg-ink/[0.07] px-1.5 py-0.5 font-mono text-[0.9em]" {...p}>
                {children}
              </code>
            ),
          pre: (p) => <pre className="my-3" {...p} />,
          table: (p) => (
            <div className="my-4 overflow-x-auto rounded-xl border-2 border-ink/10">
              <table className="w-full border-collapse text-left text-sm" {...p} />
            </div>
          ),
          thead: (p) => <thead className="bg-forest text-cream" {...p} />,
          th: (p) => <th className="px-3 py-2 font-extrabold" {...p} />,
          td: (p) => <td className="border-t border-ink/10 px-3 py-2 align-top" {...p} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
