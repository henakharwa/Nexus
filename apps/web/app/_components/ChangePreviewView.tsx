"use client";

import type { ChangePreview, ChangePreviewSection, DiffLine, ProposalContext } from "@mai-chat/shared-types";

// Exactly what an agent-proposed action will change (a diff, full text, or
// from -> to fields) and why it was proposed, on the approval card. Built by
// services/chat-server/src/change-preview.ts.

function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="change-diff" role="table" aria-label="Line changes">
      {lines.map((line, index) =>
        line.type === "gap" ? (
          <div className="change-diff-gap" role="row" key={index}>
            {line.text}
          </div>
        ) : (
          <div className={`change-diff-line ${line.type}`} role="row" key={index}>
            <span className="change-diff-num" aria-hidden="true">
              {line.oldLine ?? ""}
            </span>
            <span className="change-diff-num" aria-hidden="true">
              {line.newLine ?? ""}
            </span>
            <span
              className="change-diff-sign"
              aria-label={line.type === "add" ? "added" : line.type === "del" ? "removed" : undefined}
            >
              {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
            </span>
            <code>{line.text || " "}</code>
          </div>
        ),
      )}
    </div>
  );
}

function Section({ section }: { section: ChangePreviewSection }) {
  return (
    <section className="change-section" data-testid="change-section">
      <h4>{section.title}</h4>
      {section.note && <p className="change-note">{section.note}</p>}
      {section.kind === "diff" && section.lines && section.lines.length > 0 && <DiffView lines={section.lines} />}
      {section.kind === "text" && section.text && <pre className="change-text">{section.text}</pre>}
      {section.kind === "fields" && section.fields && (
        <dl className="change-fields">
          {section.fields.map((field, index) => (
            <div key={`${field.label}-${index}`}>
              <dt>{field.label}</dt>
              <dd>
                {field.from !== undefined && field.from !== field.to && (
                  <span className="change-from">
                    <del>{field.from || "(empty)"}</del>
                    <span aria-hidden="true"> → </span>
                  </span>
                )}
                <span className="change-to">{field.to || "(empty)"}</span>
                {field.from !== undefined && field.from === field.to && (
                  <span className="change-same"> (unchanged)</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export function ChangePreviewView({ preview }: { preview: ChangePreview }) {
  return (
    <div className="change-preview" data-testid="change-preview">
      <div className="change-preview-label">What will change</div>
      {preview.sections.map((section, index) => (
        <Section section={section} key={`${section.title}-${index}`} />
      ))}
    </div>
  );
}

export function ProposalContextView({ context }: { context: ProposalContext }) {
  return (
    <details className="proposal-context" data-testid="proposal-context">
      <summary>
        Why the agent proposed this
        {context.reads.length > 0 && (
          <span>
            {" "}
            · read {context.reads.length} thing{context.reads.length === 1 ? "" : "s"} first
          </span>
        )}
      </summary>
      <div className="proposal-context-body">
        <p className="proposal-context-heading">
          {context.source === "workflow" ? "Workflow task" : `Request from ${context.requestedBy ?? "a teammate"}`}
        </p>
        <pre className="change-text">{context.request ?? "(no request recorded)"}</pre>
        {context.reads.length > 0 && (
          <>
            <p className="proposal-context-heading">What it read just before</p>
            <p className="proposal-context-warning">
              This content was written outside Nexus. If the change follows instructions found here rather than the
              request above, don&apos;t approve it.
            </p>
            <ol className="proposal-context-reads">
              {context.reads.map((read, index) => (
                <li key={index}>
                  <strong>{read.tool.replace(/_/g, " ")}</strong>
                  {read.summary && <span> ({read.summary})</span>}
                  <pre className="change-text">{read.excerpt}</pre>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </details>
  );
}
