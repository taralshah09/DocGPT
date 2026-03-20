import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

const CodeBlock = ({ node, className, children, ...props }) => {
  const match = /language-(\w+)/.exec(className || '');
  const [copied, setCopied] = useState(false);

  // If there's no language match and the code is short/single-line, treat as inline
  const isInline = !match && !String(children).includes('\n');

  if (isInline) {
    return (
      <code className="md-inline-code" {...props}>
        {children}
      </code>
    );
  }

  const handleCopy = () => {
    const code = String(children).replace(/\n$/, '');
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isInline) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }

  return (
    <div className="code-block-container">
      <div className="code-block-header">
        <span className="code-block-lang">{match ? match[1] : 'text'}</span>
        <button className="code-block-copy" onClick={handleCopy}>
          {copied ? (
            <span className="copy-success">✓ Copied!</span>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <SyntaxHighlighter
        style={vscDarkPlus}
        language={match ? match[1] : 'text'}
        PreTag="div"
        customStyle={{
          margin: 0,
          borderBottomLeftRadius: '12px',
          borderBottomRightRadius: '12px',
          background: '#0a0a0a',
          fontSize: '14px',
          padding: '20px',
          fontFamily: "'JetBrains Mono', monospace",
        }}
        {...props}
      >
        {String(children).replace(/\n$/, '')}
      </SyntaxHighlighter>
    </div>
  );
};

const MarkdownRenderer = ({ content }) => {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code: CodeBlock,
        // Override components for premium styling
        h1: ({ node, ...props }) => <h1 className="md-h1" {...props} />,
        h2: ({ node, ...props }) => <h2 className="md-h2" {...props} />,
        h3: ({ node, ...props }) => <h3 className="md-h3" {...props} />,
        a: ({ node, ...props }) => <a className="md-link" target="_blank" rel="noopener noreferrer" {...props} />,
        table: ({ node, ...props }) => (
          <div className="table-responsive">
            <table className="md-table" {...props} />
          </div>
        ),
        blockquote: ({ node, ...props }) => <blockquote className="md-blockquote" {...props} />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
};

export default MarkdownRenderer;
