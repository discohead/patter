// The right-hand panel follows the graph: a module as code you can edit
// (⌘/Ctrl-Enter hot-swaps it); a subpatch as its interface — inlets you can
// re-patch, outlets, the controls on its face, what's inside, and what you
// can do with it; a macro and its targets; or, with nothing selected inside
// a subpatch, the subpatch you're in. On a listener's page it all reads the
// same, but only the mixer's switches change anything: the patch is the host's.

import { useEffect, useState } from 'react';
import { app, useEmitter } from '../app/store';
import { leafOf, parentOf, SEGMENT, within } from '../runtime/patch';
import { childrenOf, instanceRootOf, outletsOf } from '../runtime/resolve';

export function Inspector() {
  useEmitter(app.uiEvents);
  useEmitter(app.patchEvents);
  const doc = app.runtime.doc;
  const one = app.selected;
  if (one && doc.modules[one]) return <CodePanel name={one} />;
  if (one && doc.subpatches[one]) return <SubpatchPanel path={one} />;
  if (one?.startsWith('macro:') && doc.macros[one.slice(6)]) return <MacroPanel name={one.slice(6)} />;
  if (app.selection.length > 1) return <MultiPanel ids={app.selection} />;
  if (app.scope && doc.subpatches[app.scope]) return <SubpatchPanel path={app.scope} here />;
  return (
    <div className="code-panel empty">
      <p>Select a module to see its code, a subpatch to see its interface.</p>
      {app.listening ? (
        <p>Double-click a subpatch to open it; <kbd>esc</kbd> goes back up.</p>
      ) : (
        <p>Shift-click or drag across the graph to select several, then <kbd>⌘G</kbd> to group them into a subpatch. Double-click a subpatch to open it; <kbd>esc</kbd> goes back up.</p>
      )}
    </div>
  );
}

function useRunner() {
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown> | unknown) => {
    setError(null);
    try {
      app.runtime.checkpoint();
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return { error, run };
}

/** Where a path sits, with any abstraction instance it belongs to. */
function Where({ path }: { path: string }) {
  const doc = app.runtime.doc;
  const inst = instanceRootOf(doc, path);
  if (!parentOf(path) && !inst) return null;
  const absName = inst ? doc.subpatches[inst].abstraction! : '';
  const others = inst ? app.runtime.instancesOf(absName).filter((p) => p !== inst) : [];
  return (
    <p className="dim where">
      {parentOf(path) && (
        <>
          in{' '}
          <button className="link" onClick={() => app.enter(parentOf(path))}>
            {parentOf(path)}
          </button>
        </>
      )}
      {inst && (
        <>
          {' '}· part of <b>{absName}</b>
          {others.length ? `: edits here also reach ${others.join(', ')}` : ''}
        </>
      )}
    </p>
  );
}

function CodePanel({ name }: { name: string }) {
  const rt = app.runtime;
  const doc = rt.doc.modules[name];
  const [code, setCode] = useState(doc.code);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Follow the document when it changes underneath (the agent edited it).
  useEffect(() => {
    setCode(doc.code);
    setError(null);
    setNote(null);
  }, [name, doc.code]);

  const live = rt.module(name);
  const report = live ? rt.report(name) : null;
  const dirty = code !== doc.code;
  const readOnly = app.listening;

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      rt.checkpoint();
      const r = await rt.defineModule(name, { kind: doc.kind, code });
      setWarnings(r.warnings);
      setNote(r.abstraction?.instancesUpdated.length ? `also updated ${r.abstraction.instancesUpdated.join(', ')} (${r.abstraction.name})` : null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const routes = rt.doc.mods.filter((m) => m.target.startsWith(`${name}.`) || m.source.split('.')[0] === name);
  const reads = report?.inputs.map((i) => (leafOf(i.from) === i.ref ? i.ref : `${i.ref} ← ${i.from}`)) ?? [];

  return (
    <div className="code-panel">
      <header>
        <div>
          <span className={`badge badge-${doc.kind}`}>{doc.kind}</span>
          <strong>{leafOf(name)}</strong>
          {report && <span className="dim"> · {report.output} · {report.ugens} UGens</span>}
        </div>
        <Where path={name} />
        <div className="row">
          {doc.kind !== 'control' && (
            <>
              <label className="check">
                <input type="checkbox" checked={doc.play} onChange={(e) => rt.setMonitor(name, { play: e.target.checked })} /> to mix
              </label>
              <label className="check">
                <input type="checkbox" checked={doc.mute} onChange={(e) => rt.setMonitor(name, { mute: e.target.checked })} /> mute
              </label>
            </>
          )}
          {!readOnly && (
            <button
              className="ghost danger"
              onClick={async () => {
                try {
                  rt.checkpoint();
                  await rt.removeModule(name, { force: true });
                  app.select(null);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              remove
            </button>
          )}
        </div>
      </header>
      {doc.description && <p className="desc">{doc.description}</p>}
      <textarea
        spellCheck={false}
        value={code}
        readOnly={readOnly}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if (readOnly) return;
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void apply();
          }
          if (e.key === 'Tab') {
            e.preventDefault();
            const t = e.currentTarget;
            const { selectionStart: a, selectionEnd: b } = t;
            const next = `${code.slice(0, a)}  ${code.slice(b)}`;
            setCode(next);
            requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
          }
        }}
      />
      {readOnly ? (
        <p className="dim">The code as it runs; it changes when the patch on air does.</p>
      ) : (
        <div className="row between">
          <span className="dim">{dirty ? 'edited — ⌘↩ to hot-swap' : 'in sync'}</span>
          <button disabled={!dirty || busy} onClick={() => void apply()}>{busy ? 'compiling…' : 'apply'}</button>
        </div>
      )}
      {error && <pre className="error">{error}</pre>}
      {note && !error && <p className="dim">{note}</p>}
      {warnings.length > 0 && !error && <pre className="warn">{warnings.join('\n')}</pre>}
      {reads.length > 0 && <p className="dim">reads: {reads.join(', ')}</p>}
      {routes.length > 0 && (
        <ul className="routes">
          {routes.map((r, i) => (
            <li key={i}>
              {r.source} → {r.target} <span className="dim">× {r.amount}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Everything an inlet of a subpatch in `scope` could be patched from. */
function sourceOptions(scope: string, exclude: string): string[] {
  const rt = app.runtime;
  const doc = rt.doc;
  const { modules, subpatches } = childrenOf(doc, scope);
  const out: string[] = [];
  for (const m of modules) {
    out.push(leafOf(m));
    for (const o of Object.keys(rt.shapeOf(m)?.outputs ?? {})) out.push(`${leafOf(m)}.${o}`);
  }
  for (const s of subpatches) {
    if (s === exclude) continue;
    const outs = Object.keys(outletsOf(doc, s).outlets);
    if (outs.length) out.push(leafOf(s));
    for (const o of outs.slice(1)) out.push(`${leafOf(s)}.${o}`);
  }
  for (const i of Object.keys(doc.subpatches[scope]?.inlets ?? {})) out.push(i);
  return [...new Set(out)];
}

function SubpatchPanel({ path, here }: { path: string; here?: boolean }) {
  const rt = app.runtime;
  const doc = rt.doc;
  const sp = doc.subpatches[path];
  const { error, run } = useRunner();
  const [absName, setAbsName] = useState<string | null>(null);
  if (!sp) return null;
  const options = sourceOptions(parentOf(path), path);
  const outs = outletsOf(doc, path);
  const { modules, subpatches } = childrenOf(doc, path);
  const instances = sp.abstraction ? rt.instancesOf(sp.abstraction) : [];
  const count = Object.keys(doc.modules).filter((k) => within(k, path)).length;
  const readOnly = app.listening;

  return (
    <div className="code-panel">
      <header>
        <div>
          <span className="badge badge-subpatch">{sp.abstraction ?? 'subpatch'}</span>
          <strong>{leafOf(path)}</strong>
          <span className="dim"> · {count} module{count === 1 ? '' : 's'}</span>
        </div>
        <Where path={path} />
        <div className="row wrap">
          {!here && <button className="ghost" onClick={() => app.enter(path)}>open</button>}
          {here && <button className="ghost" onClick={() => app.up()}>↑ up</button>}
          {!readOnly && (
            <>
              <button className="ghost" onClick={() => void run(async () => app.selectMany((await rt.ungroup(path)).moved))}>ungroup</button>
              <button className="ghost" onClick={() => void run(async () => app.select((await rt.duplicate(path)).path))}>
                {sp.abstraction ? 'another instance' : 'duplicate'}
              </button>
              {sp.abstraction ? (
                <button className="ghost" title="cut loose: later edits stay here" onClick={() => void run(() => rt.detach(path))}>detach</button>
              ) : (
                <button className="ghost" onClick={() => setAbsName(leafOf(path))}>save as abstraction</button>
              )}
              <button
                className="ghost danger"
                onClick={() =>
                  void run(async () => {
                    await rt.removeSubpatch(path, { force: true });
                    if (here) app.up();
                  })
                }
              >
                remove
              </button>
            </>
          )}
        </div>
      </header>
      {absName !== null && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (!SEGMENT.test(absName)) throw new Error('abstraction names are lowercase: a-z, 0-9, _');
              await rt.saveAbstraction(path, absName);
              setAbsName(null);
            });
          }}
        >
          <input autoFocus className="name-input" value={absName} onChange={(e) => setAbsName(e.target.value.toLowerCase())} onKeyDown={(e) => e.key === 'Escape' && setAbsName(null)} />
          <button type="submit">save</button>
          <button type="button" className="ghost" onClick={() => setAbsName(null)}>cancel</button>
        </form>
      )}
      {sp.description && <p className="desc">{sp.description}</p>}
      {sp.abstraction && (
        <p className="dim">
          An instance of <b>{sp.abstraction}</b>
          {instances.length > 1 ? `, with ${instances.filter((p) => p !== path).join(', ')}` : ''}. Code and structure edits inside reach every instance; knobs and inlet connections are this one's own.
        </p>
      )}

      <h4>inlets</h4>
      {Object.keys(sp.inlets).length === 0 ? (
        <p className="dim">none: it reads nothing from outside</p>
      ) : (
        <ul className="ports">
          {Object.entries(sp.inlets).map(([name, inl]) => (
            <li key={name}>
              <span className="port-name">{name}</span>
              <span className="dim">←</span>
              {readOnly ? (
                <span>{inl.from ?? '(unconnected)'}</span>
              ) : (
                <select
                  value={inl.from ?? ''}
                  title="what feeds this inlet (re-patching doesn't restart anything)"
                  onChange={(e) => void run(() => rt.defineSubpatch(path, { inlets: { [name]: { from: e.target.value || null } } }))}
                >
                  <option value="">(unconnected)</option>
                  {options.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                  {inl.from && !options.includes(inl.from) && <option value={inl.from}>{inl.from}</option>}
                </select>
              )}
              <span className="dim">{inl.channels}ch {inl.rate}</span>
            </li>
          ))}
        </ul>
      )}

      <h4>outlets</h4>
      {Object.keys(outs.outlets).length ? (
        <ul className="ports">
          {Object.entries(outs.outlets).map(([n, ref]) => (
            <li key={n}>
              <span className="port-name">{n}</span>
              <span className="dim">→</span> {ref}
              {outs.implicit && <span className="dim"> (implicit: nothing inside reads it)</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="dim">none{outs.candidates?.length ? `: ask for one of ${outs.candidates.join(', ')}` : ''}</p>
      )}

      <h4>
        controls <span className="dim">· its face</span>
      </h4>
      {Object.keys(sp.controls).length === 0 ? (
        <p className="dim">{readOnly ? 'none' : 'none yet. Open it, select a module and ☆ the knobs that should show from outside.'}</p>
      ) : (
        <ul className="ports">
          {Object.entries(sp.controls).map(([n, ref]) => (
            <li key={n}>
              <span className="port-name">{n}</span>
              <span className="dim">→</span> {ref}
              {!readOnly && (
                <button className="ghost tiny" title="take off the face" onClick={() => void run(() => rt.defineSubpatch(path, { controls: { [n]: null } }))}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <h4>inside</h4>
      <ul className="children">
        {[...subpatches, ...modules].map((c) => (
          <li key={c}>
            <button
              className="link"
              onClick={() => {
                if (!here) app.enter(path);
                app.select(c);
              }}
            >
              {leafOf(c)}
            </button>{' '}
            <span className="dim">{doc.modules[c]?.kind ?? doc.subpatches[c]?.abstraction ?? 'subpatch'}</span>
          </li>
        ))}
      </ul>
      {error && <pre className="error">{error}</pre>}
    </div>
  );
}

function MacroPanel({ name }: { name: string }) {
  const rt = app.runtime;
  const m = rt.doc.macros[name];
  const { error, run } = useRunner();
  const routes = rt.doc.mods.filter((r) => r.source === `macro:${name}`);
  return (
    <div className="code-panel">
      <header>
        <div>
          <span className="badge badge-macro">macro</span>
          <strong>{m.label ?? leafOf(name)}</strong>
          <span className="dim"> · {Math.round(m.value * 100) / 100}{m.bipolar ? ' (bipolar)' : ''}</span>
        </div>
        <Where path={name} />
        {!app.listening && (
          <div className="row">
            <button
              className="ghost danger"
              onClick={() =>
                void run(() => {
                  rt.removeMacro(name);
                  app.select(null);
                })
              }
            >
              remove
            </button>
          </div>
        )}
      </header>
      {m.description && <p className="desc">{m.description}</p>}
      <h4>targets</h4>
      {routes.length ? (
        <ul className="routes">
          {routes.map((r) => (
            <li key={r.target}>
              {r.target} <span className="dim">× {r.amount}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dim">none</p>
      )}
      {error && <pre className="error">{error}</pre>}
    </div>
  );
}

function MultiPanel({ ids }: { ids: string[] }) {
  const doc = app.runtime.doc;
  return (
    <div className="code-panel">
      <header>
        <div>
          <strong>{ids.length} selected</strong>
        </div>
      </header>
      <ul className="children">
        {ids.map((id) => (
          <li key={id}>
            {leafOf(id.replace(/^macro:/, ''))} <span className="dim">{doc.modules[id]?.kind ?? (doc.subpatches[id] ? 'subpatch' : id.startsWith('macro:') ? 'macro' : '')}</span>
          </li>
        ))}
      </ul>
      {!app.listening && (
        <p className="dim">
          <kbd>⌘G</kbd> groups them into a subpatch: inlets and outlets are made for every cable that crosses the boundary, and nothing restarts.
        </p>
      )}
    </div>
  );
}
