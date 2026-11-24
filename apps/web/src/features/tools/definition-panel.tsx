import type { ToolDetail } from '@neurouter/shared';
import { CopyableMono } from '@/components/code/copy-button';
import { JsonViewer } from '@/components/code/json-viewer';
import { DetailList, Section } from '@/components/layout/section';
import { Pill } from '@/components/status/status';
import { DASH, formatDateTime, shortHash } from '@/lib/format';
import { VersionHistory } from './version-history';

/** Definition tab: description, input schema, annotations (labelled untrusted), pinned hash. */
export function DefinitionPanel({ tool, showHistory = false }: { tool: ToolDetail; showHistory?: boolean }) {
  return (
    <div className="flex flex-col gap-5">
      <Section title="Description">
        <p className="leading-relaxed whitespace-pre-wrap">{tool.description || <span className="text-muted-foreground">No description.</span>}</p>
      </Section>
      <Section title="Input schema">
        <JsonViewer value={tool.inputSchema} label="Input schema" collapseAfter={40} />
      </Section>
      <Section title="Annotations" actions={tool.annotationsTrusted ? <Pill tone="ok">trusted server</Pill> : <Pill tone="muted">untrusted</Pill>}>
        {tool.annotations ? <JsonViewer value={tool.annotations} label="Annotations" /> : <p className="text-muted-foreground">None reported.</p>}
        {!tool.annotationsTrusted ? <p className="mt-2 text-[13px] text-muted-foreground">Hints like readOnlyHint come from the server and are not used for policy unless the server is marked trusted.</p> : null}
      </Section>
      <Section title="Pinned definition">
        <DetailList
          items={[
            { label: 'Hash', value: tool.pinnedHash ? <CopyableMono value={tool.pinnedHash} display={shortHash(tool.pinnedHash)} ariaLabel="Copy pinned hash" /> : DASH },
            { label: 'Pinned', value: tool.pinnedAt ? `${formatDateTime(tool.pinnedAt)} by ${tool.pinnedBy?.name ?? DASH}` : DASH },
          ]}
        />
      </Section>
      {showHistory ? (
        <Section title="Definition history" description="Every definition hash the server has reported, with its review decision." bodyClassName="p-0">
          <VersionHistory toolId={tool.id} pinnedHash={tool.pinnedHash} />
        </Section>
      ) : null}
    </div>
  );
}
