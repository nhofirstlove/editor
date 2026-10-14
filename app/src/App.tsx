import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { ProjectList } from "./ProjectList.tsx";
import { ProjectView } from "./ProjectView.tsx";

/** The open project lives in the URL (#/p/<name>), so reloading keeps it open. */
function projectFromHash(): string | null {
  const m = /^#\/p\/(.+)$/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

export function App() {
  const [project, setProject] = useState(projectFromHash);
  const [toolsError, setToolsError] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => setProject(projectFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    api
      .health()
      .then((h) => setToolsError(h.tools.ok ? null : h.tools.message))
      .catch((err: Error) => setToolsError(err.message));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">
          Video Editor
        </a>
        {project && <span className="crumb">/ {project}</span>}
      </header>
      {toolsError && <div className="banner banner-error">{toolsError}</div>}
      {/* Keyed by name: each project starts with fresh editor state and its own undo history. */}
      {project ? <ProjectView key={project} name={project} /> : <ProjectList />}
    </div>
  );
}
